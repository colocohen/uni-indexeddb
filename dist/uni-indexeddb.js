/**
 * uni-indexeddb — Browser bundle
 * Unified key-value storage. IndexedDB backend.
 *
 * Usage:
 *   <script src="uni-indexeddb.js"></script>
 *   <script>
 *     var db = uniIndexedDB({ prefix: 'myapp' });
 *     db.put('users', [['key1', value1]], function(err, count) {});
 *   </script>
 */
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.uniIndexedDB = factory();
})(typeof self !== 'undefined' ? self : this, function() {
'use strict';

// =========================================================================
// Key Encoding
// =========================================================================

var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();

function isNumericKey(key) {
    if (typeof key === 'bigint') return true;
    if (typeof key === 'number') return isFinite(key) && key >= 0 && key === Math.floor(key);
    if (typeof key === 'string' && key.length > 0 && key.length <= 20) {
        for (var i = 0; i < key.length; i++) {
            var c = key.charCodeAt(i);
            if (c < 48 || c > 57) return false;
        }
        return true;
    }
    return false;
}

function bigintToBytes(n) {
    if (typeof n !== 'bigint') n = BigInt(n);
    var buf = new Uint8Array(8);
    for (var i = 7; i >= 0; i--) {
        buf[i] = Number(n & 0xFFn);
        n >>= 8n;
    }
    return buf;
}

function bytesToBigint(buf) {
    var n = 0n;
    for (var i = 0; i < buf.byteLength; i++) {
        n = (n << 8n) | BigInt(buf[i]);
    }
    return n;
}

function toKeyBuffer(key) {
    if (key instanceof Uint8Array) return key;
    if (isNumericKey(key)) return bigintToBytes(key);
    if (typeof key === 'string') return textEncoder.encode(key);
    return textEncoder.encode(String(key));
}

function fromKeyBuffer(buf) {
    var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (bytes.byteLength === 8) {
        var n = bytesToBigint(bytes);
        if (n <= 9007199254740991n) return String(n);
    }
    return textDecoder.decode(bytes);
}

// Keys and values are stored as Uint8Array

// =========================================================================
// Engine
// =========================================================================

var CHUNK_BYTES = 64 * 1024;
var IDLE_CLOSE_MS = 15 * 1000;
var STORE_NAME = 'data';

function createEngine(opts) {
    var prefix = (opts && opts.prefix) ? opts.prefix : '';
    var shuttingDown = false;
    var tables = Object.create(null);

    function createTableState(name) {
        return {
            name: name, db: null, status: 'closed',
            writeQueue: [], readQueue: [],
            writeCache: Object.create(null), writeCacheCount: 0,
            scanning: false, processing: false, onClosed: null, closeTimer: null
        };
    }

    function getTable(table) {
        var name = prefix ? prefix + '_' + table : table;
        if (!tables[name]) tables[name] = createTableState(name);
        return tables[name];
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    function put(table, data, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        if (t.scanning) {
            addToWriteCache(t, data);
            return cb(null, data.length);
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
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, [], null, true);
            scanChunk(t, cursor, function(err2, rows, nextCursor, done) {
                if (err2) return cb(null, [], null, true);
                startIdle(t);
                cb(null, rows, nextCursor, done);
            });
        });
    }

    function stat(table, cb) {
        if (shuttingDown) return cb({ code: 'SHUTTING_DOWN' });
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, { count: 0, size: 0, status: t.status });
            countRecords(t, function(count) {
                startIdle(t);
                cb(null, { count: count, size: 0, status: t.status });
            });
        });
    }

    function close(cb) {
        shuttingDown = true;
        var allNames = Object.keys(tables);
        var remaining = 0;
        var allCounted = false;

        function onTableDone() {
            remaining--;
            if (remaining === 0 && allCounted) cb(null);
        }

        for (var i = 0; i < allNames.length; i++) {
            var t = tables[allNames[i]];
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

    // -----------------------------------------------------------------
    // Processing Scheduler
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // Table Open / Close
    // -----------------------------------------------------------------

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

        var request = idb.open(t.name, 1);

        request.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
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

        request.onerror = function() {
            t.db = null; t.status = 'error';
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

    // -----------------------------------------------------------------
    // Idle Timer
    // -----------------------------------------------------------------

    function startIdle(t) {
        cancelIdle(t);
        t.closeTimer = setTimeout(function() {
            if (t.status === 'open' && !t.processing && t.writeQueue.length === 0 && t.readQueue.length === 0) {
                closeTable(t, function() {});
            }
        }, IDLE_CLOSE_MS);
    }

    function cancelIdle(t) {
        if (t.closeTimer) { clearTimeout(t.closeTimer); t.closeTimer = null; }
    }

    // -----------------------------------------------------------------
    // Write Cache (during scan)
    // -----------------------------------------------------------------

    function addToWriteCache(t, data) {
        for (var i = 0; i < data.length; i++) {
            t.writeCache[data[i][0]] = data[i][1];
            t.writeCacheCount++;
        }
    }

    function flushWriteCache(t, cb) {
        if (t.writeCacheCount === 0) return cb();
        var data = [];
        for (var key in t.writeCache) data.push([key, t.writeCache[key]]);
        t.writeCache = Object.create(null);
        t.writeCacheCount = 0;
        t.writeQueue.push({ data: data, reply: function() {} });
        flushWrites(t, cb);
    }

    // -----------------------------------------------------------------
    // Flush Writes
    // -----------------------------------------------------------------

    function flushWrites(t, cb) {
        if (t.writeQueue.length === 0) return cb();
        var batch = t.writeQueue; t.writeQueue = [];

        var tx;
        try {
            tx = t.db.transaction(STORE_NAME, 'readwrite');
        } catch (e) {
            for (var i = 0; i < batch.length; i++) batch[i].reply(e, 0);
            return cb();
        }

        var store = tx.objectStore(STORE_NAME);

        for (var i = 0; i < batch.length; i++) {
            var rows = batch[i].data;
            for (var j = 0; j < rows.length; j++) {
                var keyBuf = toKeyBuffer(rows[j][0]);
                if (rows[j][1] === null) {
                    store.delete(keyBuf);
                } else {
                    var val = rows[j][1] instanceof Uint8Array ? rows[j][1] : new Uint8Array(rows[j][1]);
                    store.put(val, keyBuf);
                }
            }
        }

        tx.oncomplete = function() {
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

    // -----------------------------------------------------------------
    // Process Reads
    // -----------------------------------------------------------------

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
                var keyBuf = toKeyBuffer(fetchKey);
                var req = store.get(keyBuf);
                req.onsuccess = function() {
                    dbResults[fetchKey] = req.result !== undefined ? new Uint8Array(req.result) : null;
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
        for (var i = 0; i < keyList.length; i++) {
            if (keyList[i] in t.writeCache) found[keyList[i]] = t.writeCache[keyList[i]];
        }
        return found;
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

    // -----------------------------------------------------------------
    // Scan
    // -----------------------------------------------------------------

    function scanChunk(t, cursor, cb) {
        t.scanning = true;
        var pre = cursor === null ? flushWrites : noop;
        pre(t, function() {
            var tx;
            try {
                tx = t.db.transaction(STORE_NAME, 'readonly');
            } catch (e) {
                t.scanning = false;
                return cb(e, [], null, true);
            }

            var store = tx.objectStore(STORE_NAME);
            var range = null;
            if (cursor !== null) {
                range = IDBKeyRange.lowerBound(toKeyBuffer(cursor), true);
            }

            var request = store.openCursor(range);
            var rows = [];
            var bytes = 0;

            request.onsuccess = function(e) {
                var idbCursor = e.target.result;
                if (!idbCursor) {
                    t.scanning = false;
                    return cb(null, rows, null, true);
                }

                var key = fromKeyBuffer(new Uint8Array(idbCursor.key));
                var value = new Uint8Array(idbCursor.value);
                rows.push([key, value]);
                bytes += value.byteLength;

                if (bytes >= CHUNK_BYTES) {
                    t.scanning = false;
                    return cb(null, rows, key, false);
                }

                idbCursor.continue();
            };

            request.onerror = function() {
                t.scanning = false;
                cb(request.error, rows, null, true);
            };
        });
    }

    function noop(t, cb) { cb(); }

    // -----------------------------------------------------------------
    // Count
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // Drain helpers
    // -----------------------------------------------------------------

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

    return {
        put: put,
        get: get,
        scan: scan,
        stat: stat,
        close: close
    };
}

return createEngine;
});
