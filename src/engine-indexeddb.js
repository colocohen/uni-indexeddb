/**
 * engine-indexeddb.js — IndexedDB backend for uni-indexeddb
 *
 * Each table = separate IndexedDB database with one object store ("data").
 * Database-per-table eliminates versionchange headaches.
 * Auto-creates on first put. Idle close after inactivity.
 * Binary keys (Uint8Array) for correct sort order.
 */

var keys = require('./keys');

var CHUNK_BYTES = 64 * 1024;
var IDLE_CLOSE_MS = 15 * 1000;
var STORE_NAME = 'data';

// Meta store — one record per database (key = META_KEY) holding running
// stats maintained by flushWrites. Reads are O(1); writes add one get +
// one put per row in the same transaction as the data write, keeping
// count/size byte-accurate. Node/LevelDB engine gets size from the file-
// system directly, so no meta store there — this whole mechanism is
// browser/IDB-side only. See stat(), readMeta(), backfillMeta(),
// flushWrites().
var META_STORE_NAME = 'meta';
var META_KEY = 'stats';
// The table's auto-increment counter — its own record in the meta store,
// written in the same transaction as the rows it numbers (and apart from
// 'stats', which backfillMeta rewrites).
var COUNTER_KEY = 'autoinc';

// Bumped from 1 → 2 to add the meta store. Existing v1 databases
// upgrade automatically on next open — onupgradeneeded runs and the
// idempotent createObjectStore adds `meta` alongside the existing
// `data`. Pre-upgrade rows already in `data` are not seeded into meta
// during the upgrade (would need a cursor scan inside the versionchange
// tx, which risks blocking); instead, the first stat() call detects
// meta.backfilled !== true and runs backfillMeta() once to seed it.
var DB_VERSION = 2;

module.exports = function createEngine(opts) {
    var shuttingDown = false;
    var openTables = Object.create(null);
    var MAX_NUMERIC = keys.bigintToBytes(keys.MAX_SAFE);

    // Snapshots (quiesce): while paused no batch starts; quiesceWaiters
    // hear when the ones running have finished.
    var paused = false, pausedFlushes = [], activeFlushes = 0, quiesceWaiters = [];

    // =====================================================================
    // Table state
    // =====================================================================

    function createTableState(name) {
        return {
            name: name, db: null, status: 'closed',
            writeQueue: [], readQueue: [],
            writeCache: Object.create(null), writeCacheCount: 0, writeCacheReplies: [],
            scanning: false, processing: false, onClosed: null, closeTimer: null,
            counterWanted: 0,   // auto-increment: the value the next batch stores
            counterSaved: 0,    // ...and the one stored last
            watchers: [],       // export snapshots: told each key's value before a batch changes it
            holds: 0            // exports reading it — no idle close
        };
    }

    function getTable(table) {
        if (!openTables[table]) openTables[table] = createTableState(table);
        return openTables[table];
    }

    // =====================================================================
    // Public API
    // =====================================================================

    // counter: optional — the auto-increment value to store with this batch
    // (only ever raised). Keys come checked and assigned (core.js).
    function put(table, data, cb, counter) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        if (counter > t.counterWanted) t.counterWanted = counter;
        if (t.scanning) {
            // Held while a scan chunk is being read; visible to get() at
            // once, answered when it is in the database (flushWriteCache).
            addToWriteCache(t, data, cb);
            return;
        }
        t.writeQueue.push({
            data: data,
            reply: function(err, count) { if (err) return cb(err); cb(null, count); }
        });
        scheduleProcess(t);
    }

    function get(table, tableKeys, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        t.readQueue.push({
            keys: tableKeys,
            reply: function(err, rows) { if (err) return cb(err); cb(null, rows); }
        });
        scheduleProcess(t);
    }

    function scan(table, cursor, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var o = parseScanOpts(cursor);
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            // A table that does not exist is empty; any other failure is
            // the caller's to see.
            if (err) return err.code === 'TABLE_NOT_FOUND' ? cb(null, [], null, true) : cb(scanError(err));
            scanChunk(t, o, function(err2, rows, nextCursor, done) {
                // Puts that waited for this chunk go in now, not whenever
                // the table is next touched — their callers are waiting.
                if (t.writeCacheCount > 0) scheduleProcess(t);
                if (err2) { startIdle(t); return cb(scanError(err2)); }
                startIdle(t);
                cb(null, rows, nextCursor, done);
            });
        });
    }

    // DOMException and the like → { code, message }.
    function scanError(err) {
        if (err && typeof err.code === 'string') return err;
        return { code: 'SCAN_FAILED', message: err && err.message ? err.message : String(err) };
    }

    function stat(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, { count: 0, size: 0, status: t.status });
            readMeta(t, function(meta) {
                if (meta && meta.backfilled) {
                    // Fast path — O(1) read from meta store, no scanning.
                    // Every write in flushWrites has been keeping this
                    // record accurate, so we just serialize it out.
                    startIdle(t);
                    return cb(null, buildStatResult(t, meta));
                }
                // Meta missing or unseeded (fresh table pre-2 upgrade,
                // or corruption). Do one full-scan backfill — cost is
                // one-time; subsequent stat() calls hit the fast path
                // above.
                backfillMeta(t, function(seeded) {
                    startIdle(t);
                    cb(null, buildStatResult(t, seeded));
                });
            });
        });
    }

    // Build the { count, size, status, tx_count, put_count, del_count,
    // last_write } object returned to callers. Same-shape as before for
    // count/size/status — new fields are additive and optional for
    // downstream consumers.
    function buildStatResult(t, meta) {
        return {
            count:      meta.count      || 0,
            size:       meta.size       || 0,
            status:     t.status,
            tx_count:   meta.tx_count   || 0,
            put_count:  meta.put_count  || 0,
            del_count:  meta.del_count  || 0,
            last_write: meta.last_write || null
        };
    }

    // Read the meta record. Returns null on any error (transient tx open
    // fail, store missing, request error) — callers treat that the same
    // as "meta unseeded" and fall through to backfill.
    function readMeta(t, cb) {
        var tx;
        try {
            tx = t.db.transaction(META_STORE_NAME, 'readonly');
        } catch (e) { return cb(null); }
        var store = tx.objectStore(META_STORE_NAME);
        var req = store.get(META_KEY);
        req.onsuccess = function() { cb(req.result || null); };
        req.onerror = function() { cb(null); };
    }

    // One-time seed: cursor-scan the data store, sum count + bytes, then
    // write the initial meta record. Runs on the first stat() after a
    // v1→v2 upgrade (where `data` has pre-existing rows), or when meta
    // has been lost. Uses the same t.scanning + flushWrites pattern as
    // scanChunk for correctness with concurrent writes.
    //
    // Cost is O(N) — but ONCE per table. All subsequent stat() calls hit
    // the O(1) fast path above. Even a 100k-row table takes well under
    // a second here; if that's ever a problem, this is where a chunked/
    // yielding variant would go.
    function backfillMeta(t, cb) {
        var empty = { count: 0, size: 0, tx_count: 0, put_count: 0, del_count: 0, last_write: null, backfilled: true };
        if (t.scanning) return cb(empty);
        t.scanning = true;
        flushWrites(t, function() {
            var tx;
            try {
                tx = t.db.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
            } catch (e) {
                t.scanning = false;
                return cb(empty);
            }
            var store = tx.objectStore(STORE_NAME);
            var metaStore = tx.objectStore(META_STORE_NAME);
            var request = store.openCursor();
            var count = 0, bytes = 0;

            request.onsuccess = function(e) {
                var idbCursor = e.target.result;
                if (!idbCursor) {
                    // Cursor exhausted — write the seeded meta.
                    var seeded = {
                        count: count, size: bytes,
                        tx_count: 0, put_count: 0, del_count: 0,
                        last_write: null,
                        backfilled: true
                    };
                    metaStore.put(seeded, META_KEY);
                    return;
                }
                count++;
                if (idbCursor.key && idbCursor.key.byteLength) bytes += idbCursor.key.byteLength;
                if (idbCursor.value && idbCursor.value.byteLength) bytes += idbCursor.value.byteLength;
                idbCursor.continue();
            };

            request.onerror = function() {
                // Best-effort — return what we accumulated. tx.oncomplete
                // won't fire in this path (or will fire with unwritten
                // meta), so callers get the same numbers stat would see
                // on the next call.
            };

            tx.oncomplete = function() {
                t.scanning = false;
                cb({
                    count: count, size: bytes,
                    tx_count: 0, put_count: 0, del_count: 0,
                    last_write: null,
                    backfilled: true
                });
            };
            tx.onerror = function() { t.scanning = false; cb(empty); };
            tx.onabort = function() { t.scanning = false; cb(empty); };
        });
    }

    function count(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, 0);
            countRecords(t, function(n) {
                startIdle(t);
                cb(null, n);
            });
        });
    }

    function listTables(cb) {
        var idb = typeof indexedDB !== 'undefined' ? indexedDB : self.indexedDB;
        if (!idb) return cb(null, []);
        if (typeof idb.databases === 'function') {
            idb.databases().then(function(list) {
                var result = [];
                for (var i = 0; i < list.length; i++) {
                    if (list[i].name) result.push(list[i].name);
                }
                cb(null, result.sort());
            }).catch(function() { cb(null, []); });
        } else {
            // Fallback: return tables we've seen in this session
            cb(null, Object.keys(openTables).sort());
        }
    }

    function drop(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = openTables[table];
        if (t) {
            cancelIdle(t);
            // Writes still waiting are answered, not left hanging: the table
            // they were for is gone.
            drainWritesError(t, { code: 'DROPPED' });
            var replies = t.writeCacheReplies;
            t.writeCache = Object.create(null); t.writeCacheCount = 0; t.writeCacheReplies = [];
            for (var r = 0; r < replies.length; r++) replies[r]({ code: 'DROPPED' });
            if (t.db) { try { t.db.close(); } catch (e) {} }
            t.db = null;
            t.status = 'closed';
            delete openTables[table];
        }
        var idb = typeof indexedDB !== 'undefined' ? indexedDB : self.indexedDB;
        if (!idb) return cb(null);
        var req = idb.deleteDatabase(table);
        req.onsuccess = function() { cb(null); };
        req.onerror = function() { cb({ code: 'DROP_FAILED', message: req.error ? req.error.message : 'Drop failed' }); };
        req.onblocked = function() {
            // Another connection — onsuccess will fire once unblocked
        };
    }

    function close(cb) {
        shuttingDown = true;
        var allNames = Object.keys(openTables);
        var remaining = 0;
        var allCounted = false;

        function onTableDone() {
            remaining--;
            if (remaining === 0 && allCounted) cb(null);
        }

        for (var i = 0; i < allNames.length; i++) {
            var t = openTables[allNames[i]];
            cancelIdle(t);
            if (t.processing) {
                remaining++;
                t.onClosed = onTableDone;
            } else if (t.status === 'open') {
                remaining++;
                (function(tbl) {
                    flushWriteCache(tbl, function() {
                        flushWrites(tbl, function() {
                            closeTable(tbl, onTableDone);
                        });
                    });
                })(t);
            }
        }

        allCounted = true;
        if (remaining === 0) cb(null);
    }

    // =====================================================================
    // Scan options parser
    // =====================================================================

    // A string or number is shorthand for { after }. Options:
    //   after   — start past this key (exclusive)
    //   before  — stop before this key (exclusive)
    //   reverse — read from high keys to low
    //   limit   — at most this many rows, exactly (0: no limit — chunks of
    //             ~CHUNK_BYTES, for walking a whole table)
    //   offset  — skip this many rows first (cursor.advance — values of
    //             the skipped rows are not read)
    //   more    — with a limit: check by key only whether another row
    //             follows, so that `done` is exact. Without it a stop at the
    //             limit reports done: false — "there may be more".
    //   values  — false: keys only — rows is [key, key, ...] and no value
    //             is read (chunks of ~CHUNK_BYTES of keys)
    // after/before are tested with != null: 0 is a key.
    function parseScanOpts(cursor) {
        var o = { after: null, before: null, reverse: false, limit: 0, offset: 0, more: false, values: true, raw: false };
        if (cursor === null || cursor === undefined) return o;
        if (typeof cursor === 'string' || typeof cursor === 'number') { o.after = cursor; return o; }
        if (cursor.after  != null) o.after  = cursor.after;
        if (cursor.before != null) o.before = cursor.before;
        o.reverse = !!cursor.reverse;
        if (cursor.limit  > 0) o.limit  = Math.floor(cursor.limit);
        if (cursor.offset > 0) o.offset = Math.floor(cursor.offset);
        o.more = !!cursor.more;
        o.values = cursor.values !== false;
        o.raw = !!cursor.raw;   // keys as the stored bytes (export)
        return o;
    }

    // =====================================================================
    // Processing Scheduler
    // =====================================================================

    function scheduleProcess(t) {
        if (!t.processing) { t.processing = true; processTable(t); }
    }

    function processTable(t) {
        cancelIdle(t);
        var needCreate = t.writeQueue.length > 0;
        ensureOpen(t, needCreate, function(err) {
            if (err) {
                drainWritesError(t, err);
                drainReadsEmpty(t);
                t.processing = false;
                if (shuttingDown && t.onClosed) t.onClosed();
                return;
            }
            flushWrites(t, function() {
                if (shuttingDown) {
                    drainReadsEmpty(t);
                    flushWriteCache(t, function() {
                        t.processing = false;
                        closeTable(t, function() { if (t.onClosed) t.onClosed(); });
                    });
                    return;
                }
                processReads(t, function() {
                    flushWriteCache(t, function() {
                        if (t.writeQueue.length > 0 || t.readQueue.length > 0) processTable(t);
                        else { t.processing = false; startIdle(t); }
                    });
                });
            });
        });
    }

    // =====================================================================
    // Table Open / Close
    // =====================================================================

    function ensureOpen(t, createIfMissing, cb) {
        if (t.status === 'open') return cb(null);
        if (t.status === 'opening' || t.status === 'closing') {
            setTimeout(function() { ensureOpen(t, createIfMissing, cb); }, 10);
            return;
        }
        if (t.status === 'error' && !createIfMissing) return cb({ code: 'TABLE_ERROR', message: 'Table in error state' });
        openTable(t, createIfMissing, cb);
    }

    function openTable(t, createIfMissing, cb) {
        t.status = 'opening';
        var idb = typeof indexedDB !== 'undefined' ? indexedDB : self.indexedDB;
        if (!idb) {
            t.status = 'error';
            return cb({ code: 'NO_INDEXEDDB', message: 'indexedDB not available' });
        }

        var request = idb.open(t.name, DB_VERSION);
        var missing = false;

        request.onupgradeneeded = function(e) {
            // A read of a table that does not exist does not create it.
            // open() creates the database on its own; aborting its upgrade
            // transaction undoes that.
            if (!createIfMissing && e.oldVersion === 0) {
                missing = true;
                e.target.transaction.abort();
                return;
            }
            var db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
            // Also create meta store on this same upgrade — idempotent, so
            // safe to run against fresh v0-nothing dbs and existing v1
            // (data-only) dbs. Meta gets populated lazily by the first
            // stat() call via backfillMeta.
            if (!db.objectStoreNames.contains(META_STORE_NAME)) {
                db.createObjectStore(META_STORE_NAME);
            }
        };

        request.onsuccess = function(e) {
            t.db = e.target.result;
            t.status = 'open';

            t.db.onclose = function() {
                t.db = null;
                t.status = 'closed';
            };

            t.db.onversionchange = function() {
                if (t.db) { t.db.close(); t.db = null; }
                t.status = 'closed';
            };

            if (!createIfMissing && !t.db.objectStoreNames.contains(STORE_NAME)) {
                t.db.close(); t.db = null; t.status = 'error';
                return cb({ code: 'TABLE_NOT_FOUND' });
            }

            cb(null);
        };

        request.onerror = function(e) {
            t.db = null;
            if (missing) {
                // 'closed', not 'error': the next read looks again (a write
                // — here or in another tab — may have created it meanwhile).
                if (e && e.preventDefault) e.preventDefault();
                t.status = 'closed';
                return cb({ code: 'TABLE_NOT_FOUND' });
            }
            t.status = 'error';
            cb({ code: 'OPEN_FAILED', message: request.error ? request.error.message : 'Unknown error' });
        };

        request.onblocked = function() {};
    }

    function closeTable(t, cb) {
        if (t.status !== 'open' || !t.db) return cb();
        cancelIdle(t);
        t.status = 'closing';
        try { t.db.close(); } catch (e) {}
        t.db = null;
        t.status = 'closed';
        cb();
    }

    // =====================================================================
    // Idle Timer
    // =====================================================================

    function startIdle(t) {
        cancelIdle(t);
        t.closeTimer = setTimeout(function() {
            if (t.status === 'open' && !t.processing && t.holds === 0 && t.writeQueue.length === 0 && t.readQueue.length === 0) {
                closeTable(t, function() {});
            }
        }, IDLE_CLOSE_MS);
    }

    function cancelIdle(t) {
        if (t.closeTimer) { clearTimeout(t.closeTimer); t.closeTimer = null; }
    }

    // =====================================================================
    // Write Cache (during scan)
    // =====================================================================

    // A put that arrives while a scan chunk is being read waits here. get()
    // sees it at once (readFromCache); its caller hears back only when the
    // transaction carrying it has completed — "done" means in the database,
    // never "accepted into memory".
    function addToWriteCache(t, data, cb) {
        // By key as stored: '555' and 555 are one key, and a binary key is
        // kept whole (the row itself is held, not String(key)).
        for (var i = 0; i < data.length; i++) {
            t.writeCache[cacheId(data[i][0])] = data[i];
            t.writeCacheCount++;
        }
        t.writeCacheReplies.push(function(err) {
            if (err) return cb(err);
            cb(null, data.length);
        });
    }

    function flushWriteCache(t, cb) {
        if (t.writeCacheCount === 0) return cb();
        var data = [];
        for (var id in t.writeCache) data.push(t.writeCache[id]);
        var replies = t.writeCacheReplies;
        t.writeCache = Object.create(null);
        t.writeCacheCount = 0;
        t.writeCacheReplies = [];
        t.writeQueue.push({ data: data, reply: function(err) {
            for (var i = 0; i < replies.length; i++) replies[i](err || null);
        } });
        flushWrites(t, cb);
    }

    // =====================================================================
    // Flush Writes — single transaction over BOTH data + meta stores
    // =====================================================================
    //
    // Every write batch atomically updates the meta record:
    //   - count / size: byte-accurate deltas computed from a pre-read of
    //                   the old value in the same transaction
    //   - tx_count:     +1 per batch (one transaction = one tx tick)
    //   - put_count / del_count: +1 per row op
    //   - last_write:   Date.now() at commit
    //
    // Cost added by meta maintenance: one metaStore.get + one metaStore.
    // put per batch, plus one dataStore.get per row (to know delta). All
    // in the same transaction as the writes themselves, so no extra
    // round-trip latency and no window where meta could disagree with
    // data.
    //
    // If pre-read fails on any row (best-effort onerror), that row's
    // delta is skipped but the write still happens — the meta may drift
    // slightly. A subsequent stat() call re-seeds via backfillMeta only
    // if meta is missing/unseeded, so drift is quiet; if it matters,
    // callers can explicitly force a re-seed by deleting meta directly.
    function flushWrites(t, cb0) {
        if (t.writeQueue.length === 0) return cb0();
        // quiesce(): no batch starts until resume — see Snapshots.
        if (paused) { pausedFlushes.push(function() { flushWrites(t, cb0); }); return; }
        activeFlushes++;
        var batch = t.writeQueue; t.writeQueue = [];
        var watchers = t.watchers.slice();
        var counter = t.counterWanted > t.counterSaved ? t.counterWanted : 0;

        function cb() {
            if (--activeFlushes === 0 && quiesceWaiters.length) {
                var q = quiesceWaiters; quiesceWaiters = [];
                for (var x = 0; x < q.length; x++) q[x]();
            }
            cb0();
        }

        var tx;
        try {
            tx = t.db.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
        } catch (e) {
            for (var i = 0; i < batch.length; i++) batch[i].reply(e, 0);
            return cb();
        }

        var store     = tx.objectStore(STORE_NAME);
        var metaStore = tx.objectStore(META_STORE_NAME);

        // Load current meta once for this batch. If unseeded, start from
        // zeros — a later stat() call will still trigger backfill if
        // .backfilled isn't set, so we mark that here defensively.
        // The counter rides in the same transaction as the rows it numbers.
        if (counter) metaStore.put(counter, COUNTER_KEY);

        var meta = null;
        var metaReq = metaStore.get(META_KEY);
        metaReq.onsuccess = function() {
            meta = metaReq.result || {
                count: 0, size: 0,
                tx_count: 0, put_count: 0, del_count: 0,
                last_write: null,
                backfilled: false
            };

            // Count how many rows we're processing across the whole batch
            // so we know when every per-row pre-read has landed and it's
            // safe to write meta back. Note: this counter is a JS-side
            // gate, not the transaction's own commit trigger — IDB's own
            // commit fires once no more requests are outstanding.
            var pending = 0;
            for (var i = 0; i < batch.length; i++) pending += batch[i].data.length;

            if (pending === 0) {
                // Empty batch data — bump tx counter only, leave the rest.
                meta.tx_count++;
                meta.last_write = Date.now();
                metaStore.put(meta, META_KEY);
                return;
            }

            function onRowSettled() {
                if (--pending > 0) return;
                meta.tx_count++;
                meta.last_write = Date.now();
                metaStore.put(meta, META_KEY);
            }

            for (var b = 0; b < batch.length; b++) {
                var rows = batch[b].data;
                for (var r = 0; r < rows.length; r++) {
                    (function(row) {
                        var keyBuf = keys.toKeyBuffer(row[0]);
                        var keySize = keyBuf.byteLength;
                        var oldReq = store.get(keyBuf);
                        oldReq.onsuccess = function() {
                            var old = oldReq.result;   // Uint8Array or undefined
                            var oldSize = old ? (old.byteLength || 0) : 0;
                            // An export's snapshot sees the value first.
                            for (var w = 0; w < watchers.length; w++) watchers[w](keyBuf, old);

                            if (row[1] === null) {
                                // Delete
                                if (old !== undefined) {
                                    store.delete(keyBuf);
                                    meta.count--;
                                    meta.size -= (keySize + oldSize);
                                    meta.del_count++;
                                }
                                // else: delete of non-existent key — no-op,
                                // no delta.
                            } else {
                                // Put — insert or update. IndexedDB stores a
                                // view's WHOLE buffer (structured clone), so a
                                // view into a larger one (a chunk of a payload)
                                // is stored as a copy of just its bytes.
                                var val = row[1];
                                if (val.byteOffset !== 0 || val.byteLength !== val.buffer.byteLength) val = new Uint8Array(val);
                                store.put(val, keyBuf);
                                if (old === undefined) {
                                    meta.count++;
                                    meta.size += (keySize + val.byteLength);
                                } else {
                                    meta.size += (val.byteLength - oldSize);
                                }
                                meta.put_count++;
                            }
                            onRowSettled();
                        };
                        oldReq.onerror = function() {
                            // Best-effort — skip delta for this row, but
                            // still let the pending counter drain so meta
                            // gets written.
                            onRowSettled();
                        };
                    })(rows[r]);
                }
            }
        };

        metaReq.onerror = function() {
            // Meta read failed — proceed with data writes only, no meta
            // update this round. Meta will drift; next stat() call
            // notices missing/stale meta and re-seeds via backfill.
            if (watchers.length) { tx.abort(); return; }   // no write a snapshot has not seen
            for (var i = 0; i < batch.length; i++) {
                var rows = batch[i].data;
                for (var j = 0; j < rows.length; j++) {
                    var keyBuf = keys.toKeyBuffer(rows[j][0]);
                    if (rows[j][1] === null) {
                        store.delete(keyBuf);
                    } else {
                        var val = rows[j][1];   // a partial view — see the put above
                        if (val.byteOffset !== 0 || val.byteLength !== val.buffer.byteLength) val = new Uint8Array(val);
                        store.put(val, keyBuf);
                    }
                }
            }
        };

        tx.oncomplete = function() {
            if (counter > t.counterSaved) t.counterSaved = counter;
            for (var i = 0; i < batch.length; i++) batch[i].reply(null, batch[i].data.length);
            cb();
        };

        tx.onerror = function() {
            var err = tx.error || { code: 'WRITE_FAILED' };
            for (var i = 0; i < batch.length; i++) batch[i].reply(err, 0);
            cb();
        };

        tx.onabort = function() {
            var err = tx.error || { code: 'WRITE_ABORTED' };
            for (var i = 0; i < batch.length; i++) batch[i].reply(err, 0);
            cb();
        };
    }

    // =====================================================================
    // Process Reads — single transaction
    // =====================================================================

    function processReads(t, cb) {
        if (t.readQueue.length === 0) return cb();
        var batch = t.readQueue; t.readQueue = [];
        var allKeys = [];
        for (var i = 0; i < batch.length; i++) {
            for (var j = 0; j < batch[i].keys.length; j++) allKeys.push(batch[i].keys[j]);
        }
        var unique = dedupKeys(allKeys);
        var cached = readFromCache(t, unique);
        var toFetch = [];
        for (var k = 0; k < unique.length; k++) {
            if (!(unique[k] in cached)) toFetch.push(unique[k]);
        }

        if (toFetch.length === 0) { replyReads(batch, cached, {}); return cb(); }

        var tx;
        try {
            tx = t.db.transaction(STORE_NAME, 'readonly');
        } catch (e) {
            replyReads(batch, cached, {});
            return cb();
        }

        var store = tx.objectStore(STORE_NAME);
        var dbResults = Object.create(null);
        var pending = toFetch.length;

        for (var i = 0; i < toFetch.length; i++) {
            (function(fetchKey) {
                var keyBuf = keys.toKeyBuffer(fetchKey);
                var req = store.get(keyBuf);
                req.onsuccess = function() {
                    dbResults[fetchKey] = req.result !== undefined ? req.result : null;   // already a fresh copy
                    pending--;
                    if (pending === 0) done();
                };
                req.onerror = function() {
                    dbResults[fetchKey] = null;
                    pending--;
                    if (pending === 0) done();
                };
            })(toFetch[i]);
        }

        function done() {
            replyReads(batch, cached, dbResults);
            cb();
        }
    }

    function dedupKeys(keyList) {
        var seen = Object.create(null); var result = [];
        for (var i = 0; i < keyList.length; i++) {
            if (!seen[keyList[i]]) { seen[keyList[i]] = true; result.push(keyList[i]); }
        }
        return result;
    }

    function readFromCache(t, keyList) {
        var found = Object.create(null);
        if (t.writeCacheCount === 0) return found;
        for (var i = 0; i < keyList.length; i++) {
            var row = t.writeCache[cacheId(keyList[i])];
            if (row) found[keyList[i]] = row[1];
        }
        return found;
    }

    function cacheId(key) {
        return keys.bytesId(keys.toKeyBuffer(key));
    }

    function replyReads(batch, cached, dbResults) {
        for (var i = 0; i < batch.length; i++) {
            var batchKeys = batch[i].keys;
            var rows = Object.create(null);
            for (var j = 0; j < batchKeys.length; j++) {
                rows[batchKeys[j]] = (batchKeys[j] in cached) ? cached[batchKeys[j]]
                    : (batchKeys[j] in dbResults) ? dbResults[batchKeys[j]]
                    : null;
            }
            batch[i].reply(null, rows);
        }
    }

    // =====================================================================
    // Scan — cursor-based chunked iteration
    // =====================================================================

    function scanChunk(t, o, cb) {
        t.scanning = true;
        // The first chunk of a scan sees every write queued before it.
        var pre = (o.after === null && o.before === null) ? flushWrites : noop;
        pre(t, function() {
            var tx;
            try {
                tx = t.db.transaction(STORE_NAME, 'readonly');
            } catch (e) {
                t.scanning = false;
                return cb(e, [], null, true);
            }

            var store = tx.objectStore(STORE_NAME);
            var lower = o.after  !== null ? keys.toKeyBuffer(o.after)  : null;
            var upper = o.before !== null ? keys.toKeyBuffer(o.before) : null;
            var dir = o.reverse ? 'prev' : 'next';

            // values: false — a key cursor: no value is loaded.
            var keysOnly = !o.values && typeof store.openKeyCursor === 'function';
            var request;
            try {
                request = keysOnly ? store.openKeyCursor(keyRange(lower, upper), dir)
                                   : store.openCursor(keyRange(lower, upper), dir);
            } catch (e) {
                // An empty range (after ≥ before) is a DataError here, not
                // an empty result.
                t.scanning = false;
                return cb(null, [], null, true);
            }

            var rows = [];
            var bytes = 0;
            var lastKey = null;
            var lastBuf = null;
            var skipped = o.offset === 0;

            request.onsuccess = function(e) {
                var idbCursor = e.target.result;
                if (!idbCursor) return end(true);

                // offset: one jump past that many rows — the ones skipped are
                // never loaded.
                if (!skipped) {
                    skipped = true;
                    idbCursor.advance(o.offset);
                    return;
                }

                lastBuf = new Uint8Array(idbCursor.key);
                lastKey = o.raw ? lastBuf : keys.fromKeyBuffer(lastBuf);
                if (o.values) {
                    var value = idbCursor.value;   // already a fresh copy
                    rows.push([lastKey, value]);
                    bytes += value.byteLength;
                } else {
                    rows.push(lastKey);
                    bytes += lastBuf.byteLength;
                }

                // With a limit: exactly that many rows, whatever their size.
                // Without one: chunks of about CHUNK_BYTES.
                if (o.limit > 0 ? rows.length >= o.limit : bytes >= CHUNK_BYTES) {
                    if (o.limit > 0 && o.more) return probe();
                    return end(false);
                }

                idbCursor.continue();
            };

            request.onerror = function() {
                t.scanning = false;
                cb(request.error, rows, null, true);
            };

            // more: is there a key past the last row, in the same direction
            // and range? A key cursor — no value is loaded.
            function probe() {
                var range = o.reverse ? keyRange(lower, lastBuf) : keyRange(lastBuf, upper);
                var req;
                try {
                    req = store.openKeyCursor ? store.openKeyCursor(range, dir) : store.openCursor(range, dir);
                } catch (e) {
                    return end(true);   // nothing left between the last row and the bound
                }
                req.onsuccess = function(e) { end(!e.target.result); };
                req.onerror = function() { end(false); };
            }

            function end(done) {
                t.scanning = false;
                cb(null, rows, done ? null : lastKey, done);
            }
        });
    }

    // The range strictly between lower and upper — either may be null.
    function keyRange(lower, upper) {
        if (lower && upper) return IDBKeyRange.bound(lower, upper, true, true);
        if (lower) return IDBKeyRange.lowerBound(lower, true);
        if (upper) return IDBKeyRange.upperBound(upper, true);
        return null;
    }

    function noop(t, cb) { cb(); }

    // =====================================================================
    // Count — O(1) via IDBObjectStore.count()
    // =====================================================================

    function countRecords(t, cb) {
        var tx;
        try {
            tx = t.db.transaction(STORE_NAME, 'readonly');
        } catch (e) {
            return cb(0);
        }
        var store = tx.objectStore(STORE_NAME);
        var req = store.count();
        req.onsuccess = function() { cb(req.result); };
        req.onerror = function() { cb(0); };
    }

    // =====================================================================
    // Auto-increment counter
    // =====================================================================

    // The stored counter. A table that has none yet (made before counters,
    // or never given a numeric key) starts from its largest numeric key:
    // numeric keys are 8 bytes, 0 .. MAX_NUMERIC, and sort before any text
    // key, so it is the first 8-byte key walking down from MAX_NUMERIC. A
    // table that does not exist: 0.
    function readCounter(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return err.code === 'TABLE_NOT_FOUND' ? cb(null, Math.max(0, t.counterWanted)) : cb(err);
            var tx;
            try { tx = t.db.transaction([STORE_NAME, META_STORE_NAME], 'readonly'); }
            catch (e) { return cb(scanError(e)); }
            var result = 0;
            var req = tx.objectStore(META_STORE_NAME).get(COUNTER_KEY);
            req.onsuccess = function() {
                if (typeof req.result === 'number' && req.result >= 0) {
                    result = req.result;
                    if (result > t.counterSaved) t.counterSaved = result;
                    return;
                }
                var store = tx.objectStore(STORE_NAME);
                var range = IDBKeyRange.upperBound(MAX_NUMERIC);
                var cur = store.openKeyCursor ? store.openKeyCursor(range, 'prev') : store.openCursor(range, 'prev');
                cur.onsuccess = function(e) {
                    var c = e.target.result;
                    if (!c) return;
                    var k = new Uint8Array(c.key);
                    if (k.length !== 8) return c.continue();   // a text key that starts with \0
                    result = keys.numericValue(k);
                };
            };
            tx.oncomplete = function() { startIdle(t); cb(null, Math.max(result, t.counterWanted)); };
            tx.onerror = tx.onabort = function() { startIdle(t); cb(scanError(tx.error || { code: 'READ_FAILED' })); };
        });
    }

    // =====================================================================
    // Snapshots — for exports (core.js)
    // =====================================================================

    // cb(resume) once no batch is being written, in any table; none starts
    // until resume() — the moment between is the snapshot's point in time.
    function quiesce(cb) {
        if (paused) return setTimeout(function() { quiesce(cb); }, 1);
        paused = true;
        function ready() {
            cb(function resume() {
                paused = false;
                var q = pausedFlushes; pausedFlushes = [];
                for (var i = 0; i < q.length; i++) q[i]();
            });
        }
        if (activeFlushes === 0) ready(); else quiesceWaiters.push(ready);
    }

    // fn(keyBytes, oldValue | undefined) before each batch that changes the
    // table — once per row of the batch. → unwatch().
    function watch(table, fn) {
        var t = getTable(table);
        t.watchers.push(fn);
        return function unwatch() {
            var i = t.watchers.indexOf(fn);
            if (i >= 0) t.watchers.splice(i, 1);
        };
    }

    // +1 / −1: an export reading the table — it is not closed for idling.
    function hold(table, delta) {
        var t = getTable(table);
        t.holds += delta;
        if (t.holds === 0 && t.status === 'open' && !t.processing) startIdle(t);
        else if (t.holds > 0) cancelIdle(t);
    }

    // =====================================================================
    // Drain helpers
    // =====================================================================

    function drainWritesError(t, err) {
        var b = t.writeQueue; t.writeQueue = [];
        for (var i = 0; i < b.length; i++) b[i].reply(err, 0);
    }

    function drainReadsEmpty(t) {
        var b = t.readQueue; t.readQueue = [];
        for (var i = 0; i < b.length; i++) {
            var rows = Object.create(null);
            for (var j = 0; j < b[i].keys.length; j++) rows[b[i].keys[j]] = null;
            b[i].reply(null, rows);
        }
    }

    // =====================================================================
    // Return public API
    // =====================================================================

    return {
        put: put,
        get: get,
        scan: scan,
        stat: stat,
        count: count,
        tables: listTables,
        drop: drop,
        close: close,
        readCounter: readCounter,
        quiesce: quiesce,
        watch: watch,
        hold: hold
    };
};
