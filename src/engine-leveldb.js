/**
 * engine-leveldb.js — LevelDB backend for uni-indexeddb
 *
 * Each table = separate LevelDB instance (database-per-table).
 * Auto-creates on first put. Idle close after inactivity.
 * Write batching, read dedup, scan with write cache.
 * Row count and write stats kept in count.txt next to the table's files
 * (see Count) — the same stat() the IndexedDB engine gives.
 */

var path = require('path');
var fs = require('fs');
var keys = require('./keys');

var CHUNK_BYTES = 64 * 1024;
var IDLE_CLOSE_MS = 15 * 1000;
var MAX_REPAIR_ATTEMPTS = 1;
var COUNT_FILE = 'count.txt';

// The table's auto-increment counter lives under the empty key, in the same
// batch as the rows it numbers. User keys are never empty (keys.checkKey),
// and every walk of the table starts past it (gt: EMPTY).
var EMPTY = new Uint8Array(0);
var MAX_NUMERIC = keys.bigintToBytes(keys.MAX_SAFE);

module.exports = function createEngine(opts) {
    var ClassicLevel = require('classic-level').ClassicLevel;
    var dir = opts && opts.dir ? opts.dir : './data';
    var shuttingDown = false;
    var openTables = Object.create(null);

    // Snapshots (quiesce): while paused no batch starts; quiesceWaiters
    // hear when the ones running have finished.
    var paused = false, pausedFlushes = [], activeFlushes = 0, quiesceWaiters = [];

    // =====================================================================
    // Table state
    // =====================================================================

    function createTableState(dbPath) {
        return {
            dbPath: dbPath, db: null, status: 'closed',
            repairAttempts: 0, writeQueue: [], readQueue: [],
            writeCache: Object.create(null), writeCacheCount: 0, writeCacheReplies: [],
            scanning: false, processing: false, onClosed: null, closeTimer: null,
            count: null,        // rows in the table; null = not known (see Count)
            stats: newStats(),  // tx_count, put_count, del_count, last_write
            writeGen: 0,        // batches committed — lets a recount see it raced one
            flushing: false, flushWaiters: [],
            counterWanted: 0,   // auto-increment: the value the next batch stores
            counterSaved: 0,    // ...and the one stored last
            watchers: [],       // export snapshots: told each key's value before a batch changes it
            holds: 0            // exports reading it — no idle close
        };
    }

    function getTable(table) {
        var dbPath = path.join(dir, table);
        if (!openTables[dbPath]) openTables[dbPath] = createTableState(dbPath);
        return openTables[dbPath];
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

    function scanError(err) {
        if (err && typeof err.code === 'string' && err.code.indexOf('LEVEL_') !== 0) return err;
        return { code: 'SCAN_FAILED', message: err && err.message ? err.message : String(err) };
    }

    function stat(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, buildStat(0, 0, t.status, newStats()));
            collectStat(t, function(info) { startIdle(t); cb(null, info); });
        });
    }

    function count(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, 0);
            ensureCount(t, function(n) {
                startIdle(t);
                cb(null, n);
            });
        });
    }

    function listTables(cb) {
        fs.readdir(dir, function(err, entries) {
            if (err) return cb(null, []);
            var result = [];
            var remaining = entries.length;
            if (remaining === 0) return cb(null, []);
            for (var i = 0; i < entries.length; i++) {
                (function(name) {
                    fs.stat(path.join(dir, name), function(err2, s) {
                        if (!err2 && s.isDirectory()) result.push(name);
                        if (--remaining === 0) cb(null, result.sort());
                    });
                })(entries[i]);
            }
        });
    }

    function drop(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var dbPath = path.join(dir, table);
        var t = openTables[dbPath];
        if (t) {
            cancelIdle(t);
            // Writes still waiting are answered, not left hanging: the table
            // they were for is gone.
            drainWritesError(t, { code: 'DROPPED' });
            var replies = t.writeCacheReplies;
            t.writeCache = Object.create(null); t.writeCacheCount = 0; t.writeCacheReplies = [];
            for (var r = 0; r < replies.length; r++) replies[r]({ code: 'DROPPED' });
            // Closed first, and only once nothing is using it: a table still
            // opening, closing, or in the middle of a batch / read / scan
            // chunk holds its files (LOCK, an iterator), and on Windows a held
            // file cannot be removed — the drop failed with EBUSY.
            whenIdle(t, function() {
                closeTable(t, function() {
                    t.db = null;
                    t.status = 'closed';
                    delete openTables[dbPath];
                    rmrf(dbPath, cb);
                });
            });
        } else {
            rmrf(dbPath, cb);
        }
    }

    // cb once the table is neither opening, closing, nor busy with a batch,
    // a read or a scan chunk.
    function whenIdle(t, cb) {
        if (t.status === 'opening' || t.status === 'closing' || t.processing || t.scanning) {
            setTimeout(function() { whenIdle(t, cb); }, 10);
            return;
        }
        cb();
    }

    function close(cb) {
        shuttingDown = true;
        var allPaths = Object.keys(openTables);
        var remaining = 0;
        var allCounted = false;

        function onTableDone() {
            remaining--;
            if (remaining === 0 && allCounted) cb(null);
        }

        for (var i = 0; i < allPaths.length; i++) {
            var t = openTables[allPaths[i]];
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
    //   offset  — skip this many rows first, by key only (values not read)
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
    // Table Open / Close / Repair
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
        if (createIfMissing) ensureDir(path.dirname(t.dbPath));
        // A table that does not exist yet starts with 0 rows — known
        // without counting.
        var fresh = !fs.existsSync(path.join(t.dbPath, 'CURRENT'));

        // A read of a table that does not exist does not create it. LevelDB
        // makes the directory and its LOCK before it checks, even when told
        // not to create — so it is not asked. 'closed', not 'error': the
        // next read looks again (a write may have created it meanwhile).
        if (fresh && !createIfMissing) {
            t.status = 'closed';
            return cb({ code: 'TABLE_NOT_FOUND' });
        }

        try {
            t.db = new ClassicLevel(t.dbPath, { keyEncoding: 'view', valueEncoding: 'view' });
        } catch (err) {
            t.status = 'error'; t.db = null; return cb(err);
        }

        t.db.open({ createIfMissing: createIfMissing, compression: false, maxOpenFiles: 500, maxFileSize: 30 * 1024 * 1024 })
        .then(function() { t.status = 'open'; t.repairAttempts = 0; loadCount(t, fresh); cb(null); })
        .catch(function(err) {
            // classic-level 2 and later wrap every open failure as
            // LEVEL_DATABASE_NOT_OPEN, with the real one in err.cause. That
            // wrapper code was read as "does not exist" — so a corrupt table
            // was never repaired, just left in error.
            var cause = err.cause || err;
            var errStr = String(cause);
            var code = cause.code || '';
            var corrupt = code.indexOf('LEVEL_CORRUPTION') >= 0 || errStr.indexOf('Corruption:') >= 0;

            if (!corrupt || t.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
                t.db.close().then(function() { t.db = null; t.status = 'error'; cb(err); })
                .catch(function() { t.db = null; t.status = 'error'; cb(err); });
                return;
            }

            t.repairAttempts++;
            t.db.close().then(function() {
                t.db = null;
                // classic-level 1 takes a callback; 2 and later return a
                // promise and ignore one — with only the callback, the
                // table never reopened after a repair.
                var repaired = false;
                var afterRepair = function(repairErr) {
                    if (repaired) return;
                    repaired = true;
                    if (repairErr) { t.status = 'error'; return cb(repairErr); }
                    // A repair can drop records: the stored count is no
                    // longer known to be right. Counted again when asked;
                    // the write stats are kept.
                    writeCountFile(t.dbPath, null, 'open', readCountFile(t.dbPath).stats);
                    t.status = 'closed'; openTable(t, createIfMissing, cb);
                };
                var r = ClassicLevel.repair(t.dbPath, afterRepair);
                if (r && typeof r.then === 'function') r.then(function() { afterRepair(null); }, afterRepair);
            }).catch(function() { t.status = 'error'; cb(err); });
        });
    }

    function closeTable(t, cb) {
        if (t.status !== 'open' || !t.db) return cb();
        cancelIdle(t);
        t.status = 'closing';
        t.db.close().then(function() {
            t.db = null; t.status = 'closed';
            if (t.count !== null) writeCount(t, 'clean');   // every write is in — the number is final
            cb();
        })
        .catch(function() { t.db = null; t.status = 'closed'; cb(); });
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
    // batch carrying it has been written — "done" means in the database,
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
    // Flush Writes — batch
    // =====================================================================

    // One batch at a time per table: the count's delta is worked out from
    // what is in the table before the batch, so two in flight that touch
    // the same key would both count it. A flush asked for while one runs
    // waits for it, then takes what has queued since.
    function flushWrites(t, cb) {
        if (t.flushing) { t.flushWaiters.push(cb); return; }
        if (t.writeQueue.length === 0) return cb();
        // quiesce(): no batch starts until resume — see Snapshots.
        if (paused) { pausedFlushes.push(function() { flushWrites(t, cb); }); return; }
        t.flushing = true;
        activeFlushes++;
        var batch = t.writeQueue; t.writeQueue = [];

        function settled() {
            t.flushing = false;
            if (--activeFlushes === 0 && quiesceWaiters.length) {
                var q = quiesceWaiters; quiesceWaiters = [];
                for (var x = 0; x < q.length; x++) q[x]();
            }
            var waiters = t.flushWaiters; t.flushWaiters = [];
            cb();
            if (waiters.length) flushWrites(t, function() {
                for (var w = 0; w < waiters.length; w++) waiters[w]();
            });
        }

        var ops = [];
        for (var i = 0; i < batch.length; i++) {
            var rows = batch[i].data;
            for (var j = 0; j < rows.length; j++) {
                var key = keys.toKeyBuffer(rows[j][0]);
                if (rows[j][1] === null) ops.push({ type: 'del', key: key });
                else ops.push({ type: 'put', key: key, value: rows[j][1] });   // LevelDB copies it
            }
        }
        var puts = 0;
        for (var k = 0; k < ops.length; k++) if (ops[k].type === 'put') puts++;
        countDelta(t, ops, function(err, delta, dels) {
            if (err) {
                for (var e = 0; e < batch.length; e++) batch[e].reply(err, 0);
                return settled();
            }
            // The counter rides in the same batch as the rows it numbers.
            var counter = t.counterWanted > t.counterSaved ? t.counterWanted : 0;
            if (counter) ops.push({ type: 'put', key: EMPTY, value: keys.bigintToBytes(counter) });
            t.db.batch(ops).then(function() {
                t.writeGen++;
                if (counter > t.counterSaved) t.counterSaved = counter;
                if (t.count !== null) t.count = delta === null ? null : t.count + delta;
                t.stats.tx_count++;
                t.stats.put_count += puts;
                t.stats.del_count += dels;
                t.stats.last_write = Date.now();
                for (var i = 0; i < batch.length; i++) batch[i].reply(null, batch[i].data.length);
                settled();
            }).catch(function(err) {
                for (var i = 0; i < batch.length; i++) batch[i].reply(err, 0);
                settled();
            });
        });
    }

    // =====================================================================
    // Process Reads — batch
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

        t.db.getMany(toFetch.map(keys.toKeyBuffer)).then(function(values) {
            var dbResults = Object.create(null);
            for (var i = 0; i < toFetch.length; i++) {
                // classic-level returns each value in a Buffer of its own —
                // seen as a plain Uint8Array, not copied.
                dbResults[toFetch[i]] = values[i] !== undefined ? new Uint8Array(values[i].buffer, values[i].byteOffset, values[i].byteLength) : null;
            }
            replyReads(batch, cached, dbResults);
            cb();
        }).catch(function() {
            replyReads(batch, cached, {});
            cb();
        });
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
    // Scan
    // =====================================================================

    function scanChunk(t, o, cb) {
        t.scanning = true;
        // The first chunk of a scan sees every write queued before it.
        var pre = (o.after === null && o.before === null) ? flushWrites : noop;
        pre(t, function() {
            var range = { gt: EMPTY };   // past the counter
            if (o.after  !== null) range.gt = keys.toKeyBuffer(o.after);
            if (o.before !== null) range.lt = keys.toKeyBuffer(o.before);

            skipKeys(t, range, o, function(err, from) {
                if (err) { t.scanning = false; return cb(err, [], null, true); }
                if (from === false) { t.scanning = false; return cb(null, [], null, true); }   // offset past the end
                if (from) { if (o.reverse) range.lt = from; else range.gt = from; }
                readRows(t, range, o, cb);
            });
        });
    }

    // offset: walk past that many keys — keys only, no value is read — and
    // hand back the last one, to read on from. false: the range has fewer.
    function skipKeys(t, range, o, cb) {
        if (o.offset === 0) return cb(null, null);
        var skipOpts = { values: false, fillCache: false, reverse: o.reverse, limit: o.offset };
        if (range.gt) skipOpts.gt = range.gt;
        if (range.lt) skipOpts.lt = range.lt;
        var it = t.db.iterator(skipOpts);
        var left = o.offset, last = null;
        // nextv(n) gives at most n — classic-level hands them over ~1000 at
        // a time — so it is asked again until the offset is walked or the
        // range ends.
        (function more() {
            it.nextv(left).then(function(entries) {
                if (entries.length > 0) { last = entries[entries.length - 1][0]; left -= entries.length; }
                if (left > 0 && entries.length > 0) return more();
                return it.close().then(function() { cb(null, left === 0 ? last : false); });
            }).catch(function(err) {
                it.close().then(function() { cb(err); }).catch(function() { cb(err); });
            });
        })();
    }

    // With a limit: exactly that many rows (or fewer at the end), whatever
    // their size — the caller chose the page. Without one: chunks of about
    // CHUNK_BYTES, at least one row each.
    function readRows(t, range, o, cb) {
        var iterOpts = { fillCache: false, reverse: o.reverse, values: o.values };
        if (range.gt) iterOpts.gt = range.gt;
        if (range.lt) iterOpts.lt = range.lt;
        if (o.limit > 0) iterOpts.limit = o.limit;
        var iterator = t.db.iterator(iterOpts);
        var rows = []; var bytes = 0; var lastKey = null; var lastBuf = null;
        readNext();

        function readNext() {
            iterator.next().then(function(pair) {
                if (!pair || pair[0] === undefined) return finish(true);
                lastKey = o.raw ? pair[0] : keys.fromKeyBuffer(pair[0]);
                lastBuf = pair[0];
                if (o.values) {
                    var value = new Uint8Array(pair[1].buffer, pair[1].byteOffset, pair[1].byteLength);   // own Buffer — not copied
                    rows.push([lastKey, value]);
                    bytes += pair[1].byteLength;
                } else {
                    rows.push(lastKey);
                    bytes += pair[0].byteLength;
                }
                if (o.limit > 0 ? rows.length >= o.limit : bytes >= CHUNK_BYTES) return finish(false);
                readNext();
            }).catch(function(err) {
                iterator.close().then(function() { t.scanning = false; cb(err, rows, null, true); })
                .catch(function() { t.scanning = false; cb(err, rows, null, true); });
            });
        }

        function finish(exhausted) {
            iterator.close().then(function() {
                if (exhausted || !(o.limit > 0 && o.more)) return end(exhausted);
                // more: is there a key past the last row, in the same
                // direction and range? Keys only.
                var probeOpts = { values: false, fillCache: false, reverse: o.reverse, limit: 1 };
                if (o.reverse) { probeOpts.lt = lastBuf; if (range.gt) probeOpts.gt = range.gt; }
                else           { probeOpts.gt = lastBuf; if (range.lt) probeOpts.lt = range.lt; }
                var probe = t.db.iterator(probeOpts);
                probe.next().then(function(next) {
                    var none = !next || next[0] === undefined;
                    return probe.close().then(function() { end(none); });
                }).catch(function() {
                    probe.close().then(function() { end(false); }).catch(function() { end(false); });
                });
            }).catch(function(err) { t.scanning = false; cb(err, rows, null, true); });
        }

        function end(done) {
            t.scanning = false;
            cb(null, rows, done ? null : lastKey, done);
        }
    }

    function noop(t, cb) { cb(); }

    // =====================================================================
    // Count — count.txt, beside the table's own files
    // =====================================================================
    //
    // LevelDB keeps no row count, and counting means walking every key. So
    // the engine keeps one: t.count, moved by every batch — a put of a key
    // that was not there +1, a del of one that was −1 (hasMany, keys only,
    // tells which) — and, with it, the write stats the IndexedDB engine
    // keeps: tx_count (batches), put_count (puts), del_count (deletes of
    // keys that were there), last_write (ms). One line of JSON in count.txt:
    //
    //   {"count":120,"state":"clean",...}   written on close, after every
    //                                       write is in
    //   {"count":120,"state":"open",...}    written on open — while the table
    //                                       is open the file is not the
    //                                       truth; if the process dies, it
    //                                       stays 'open'
    //
    // Opening a table whose file says 'clean' takes the count as it is. One
    // that says 'open' (a crash), or has no file, leaves the count unknown
    // until it is asked for, then counts once by walking the keys. A table
    // that did not exist before starts at 0. The stats cannot be walked
    // again: after a crash they are the ones of the last clean close.
    //
    // LevelDB ignores files it did not write (it removes only its own, by
    // name), and drop removes the whole directory, count.txt with it.

    function newStats() {
        return { tx_count: 0, put_count: 0, del_count: 0, last_write: null };
    }

    // → { count: n | null, stats }. count only from a clean close.
    function readCountFile(dbPath) {
        var out = { count: null, stats: newStats() };
        var text;
        try { text = fs.readFileSync(path.join(dbPath, COUNT_FILE), 'utf8').trim(); }
        catch (e) { return out; }
        var j = null;
        try { j = JSON.parse(text); } catch (e) {
            var m = /^(\d+) clean$/.exec(text);   // the first form: '<n> clean'
            if (m) out.count = Number(m[1]);
            return out;
        }
        if (!j || typeof j !== 'object') return out;
        if (j.state === 'clean' && typeof j.count === 'number' && j.count >= 0) out.count = j.count;
        var st = out.stats;
        if (j.tx_count  >= 0) st.tx_count  = j.tx_count;
        if (j.put_count >= 0) st.put_count = j.put_count;
        if (j.del_count >= 0) st.del_count = j.del_count;
        if (typeof j.last_write === 'number') st.last_write = j.last_write;
        return out;
    }

    function writeCountFile(dbPath, count, state, st) {
        try {
            fs.writeFileSync(path.join(dbPath, COUNT_FILE), JSON.stringify({
                count: count, state: state,
                tx_count: st.tx_count, put_count: st.put_count,
                del_count: st.del_count, last_write: st.last_write
            }));
        } catch (e) { /* the count is a convenience — never fail a table over it */ }
    }

    function loadCount(t, fresh) {
        if (fresh) {
            t.count = 0;
            t.stats = newStats();
        } else {
            var saved = readCountFile(t.dbPath);
            t.count = saved.count;
            t.stats = saved.stats;
        }
        writeCount(t, 'open');
    }

    function writeCount(t, state) {
        writeCountFile(t.dbPath, t.count, state, t.stats);
    }

    // What a batch does: cb(delta, dels).
    //   delta — the change to the count: +1 for each key it puts that was
    //           not there, −1 for each it deletes that was. A key that occurs
    //           more than once counts by its last op. null: not known (the
    //           count is unknown, or hasMany failed) — the count becomes
    //           unknown and is walked again when asked.
    //   dels  — deletes of keys that were there (del_count).
    //
    // While an export watches the table (t.watchers), the values themselves
    // are read — getMany instead of hasMany — and each watcher is told every
    // key's value before the batch changes it (undefined: not there). Then
    // a failed read fails the batch (cb(err)): a change the snapshot did not
    // see first must not go in.
    function countDelta(t, ops, cb) {
        var lastOp = Object.create(null), uniq = [], ids = [];
        for (var i = 0; i < ops.length; i++) {
            var id = Buffer.from(ops[i].key.buffer, ops[i].key.byteOffset, ops[i].key.byteLength).toString('latin1');
            if (!(id in lastOp)) { uniq.push(ops[i].key); ids.push(id); }
            lastOp[id] = ops[i].type;
        }
        var watching = t.watchers.length > 0;
        if (uniq.length === 0) return cb(null, 0, 0);
        var has = watching
            ? t.db.getMany(uniq).then(function(vals) {
                var exists = new Array(vals.length);
                for (var j = 0; j < vals.length; j++) {
                    var v = vals[j];
                    exists[j] = v !== undefined;
                    var old = exists[j] ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : undefined;
                    for (var w = 0; w < t.watchers.length; w++) t.watchers[w](uniq[j], old);
                }
                return exists;
            })
            : typeof t.db.hasMany === 'function'
            ? t.db.hasMany(uniq)
            : t.db.getMany(uniq).then(function(vals) { return vals.map(function(v) { return v !== undefined; }); });
        has.then(function(exists) {
            var delta = 0, dels = 0;
            for (var j = 0; j < uniq.length; j++) {
                if (!exists[j] && lastOp[ids[j]] === 'put') delta++;
                else if (exists[j] && lastOp[ids[j]] === 'del') { delta--; dels++; }
            }
            cb(null, t.count === null ? null : delta, dels);
        }).catch(function(err) {
            if (watching) return cb({ code: 'WRITE_FAILED', message: err && err.message });
            cb(null, null, 0);
        });
    }

    // The count, walking the keys when it is not known. A batch committed
    // while walking makes the walk's number stale (writeGen moved): it is
    // returned, but not kept — the next ask walks again.
    function ensureCount(t, cb) {
        if (t.count !== null) return cb(t.count);
        var gen = t.writeGen;
        countRecords(t, function(n) {
            if (t.count === null && t.writeGen === gen) t.count = n;
            cb(n);
        });
    }

    function countRecords(t, cb) {
        var n = 0;
        var iterator = t.db.iterator({ values: false, gt: EMPTY });
        (function readNext() {
            iterator.next().then(function(pair) {
                if (!pair || pair[0] === undefined) {
                    return iterator.close().then(function() { cb(n); })
                    .catch(function() { cb(n); });
                }
                n++;
                readNext();
            }).catch(function() {
                iterator.close().then(function() { cb(n); })
                .catch(function() { cb(n); });
            });
        })();
    }

    // =====================================================================
    // Stat
    // =====================================================================

    function collectStat(t, cb) {
        ensureCount(t, function(n) {
            cb(buildStat(n, getDirSize(t.dbPath), t.status, t.stats));
        });
    }

    // Same shape as the IndexedDB engine's stat().
    function buildStat(count, size, status, st) {
        return {
            count:      count,
            size:       size,
            status:     status,
            tx_count:   st.tx_count,
            put_count:  st.put_count,
            del_count:  st.del_count,
            last_write: st.last_write
        };
    }

    function getDirSize(dirPath) {
        var total = 0;
        try {
            var files = fs.readdirSync(dirPath);
            for (var i = 0; i < files.length; i++) {
                var fp = path.join(dirPath, files[i]);
                var s = fs.statSync(fp);
                total += s.isFile() ? s.size : s.isDirectory() ? getDirSize(fp) : 0;
            }
        } catch (e) {}
        return total;
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
            t.db.get(EMPTY).then(function(v) {
                var n = v !== undefined && v !== null ? keys.numericValue(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : -1;
                if (n >= 0) { if (n > t.counterSaved) t.counterSaved = n; return done(n); }
                maxNumericKey(t, done);
            }, function(e) {
                if (e && (e.code === 'LEVEL_NOT_FOUND' || e.notFound)) return maxNumericKey(t, done);
                cb(e);
            });
        });
        function done(n) {
            startIdle(t);
            cb(null, Math.max(n, t.counterWanted));
        }
    }

    function maxNumericKey(t, cb) {
        var it = t.db.iterator({ values: false, reverse: true, lte: MAX_NUMERIC, gt: EMPTY, fillCache: false });
        (function next() {
            it.next().then(function(k) {
                if (k === undefined || (Array.isArray(k) && k[0] === undefined)) return it.close().then(function() { cb(0); }, function() { cb(0); });
                var key = Array.isArray(k) ? k[0] : k;
                if (key.length !== 8) return next();   // a text key that starts with \0
                it.close().then(function() { cb(keys.numericValue(new Uint8Array(key.buffer, key.byteOffset, key.byteLength))); },
                                function() { cb(keys.numericValue(key)); });
            }).catch(function() { it.close().then(function() { cb(0); }, function() { cb(0); }); });
        })();
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
    // table — once per key in the batch. → unwatch().
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
    // Helpers
    // =====================================================================

    function ensureDir(dirPath) {
        try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) {}
    }

    // maxRetries: on Windows a file another process has open for a moment (an
    // indexer, an antivirus scan) fails the remove with EBUSY / EPERM; fs.rm
    // tries again on those, retryDelay ms apart (growing).
    function rmrf(p, cb) {
        (fs.rm || fs.rmdir).call(fs, p, { recursive: true, maxRetries: 10, retryDelay: 100 }, function(err) {
            if (err && err.code === 'ENOENT') return cb(null);
            cb(err ? { code: 'DROP_FAILED', message: err.message } : null);
        });
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