/**
 * engine-leveldb.js — LevelDB backend for uni-indexeddb
 *
 * Each table = separate LevelDB instance (database-per-table).
 * Auto-creates on first put. Idle close after inactivity.
 * Write batching, read dedup, scan with write cache.
 */

var path = require('path');
var fs = require('fs');
var keys = require('./keys');

var CHUNK_BYTES = 64 * 1024;
var IDLE_CLOSE_MS = 15 * 1000;
var MAX_REPAIR_ATTEMPTS = 1;

module.exports = function createEngine(opts) {
    var ClassicLevel = require('classic-level').ClassicLevel;
    var dir = opts && opts.dir ? opts.dir : './data';
    var shuttingDown = false;
    var openTables = Object.create(null);

    // =====================================================================
    // Table state
    // =====================================================================

    function createTableState(dbPath) {
        return {
            dbPath: dbPath, db: null, status: 'closed',
            repairAttempts: 0, writeQueue: [], readQueue: [],
            writeCache: Object.create(null), writeCacheCount: 0,
            scanning: false, processing: false, onClosed: null, closeTimer: null
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
        var o = parseScanOpts(cursor);
        var t = getTable(table);
        ensureOpen(t, false, function(err) {
            if (err) return cb(null, [], null, true);
            scanChunk(t, o.after, o.limit, function(err2, rows, nextCursor, done) {
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
            collectStat(t, function(info) { startIdle(t); cb(null, info); });
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
            var doRemove = function() {
                delete openTables[dbPath];
                rmrf(dbPath, cb);
            };
            if (t.status === 'open' && t.db) {
                closeTable(t, doRemove);
            } else {
                t.db = null;
                t.status = 'closed';
                doRemove();
            }
        } else {
            rmrf(dbPath, cb);
        }
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

    function parseScanOpts(cursor) {
        if (cursor === null || cursor === undefined) return { after: null, limit: 0 };
        if (typeof cursor === 'string' || typeof cursor === 'number') return { after: cursor, limit: 0 };
        return { after: cursor.after || null, limit: cursor.limit || 0 };
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

        try {
            t.db = new ClassicLevel(t.dbPath, { keyEncoding: 'view', valueEncoding: 'view' });
        } catch (err) {
            t.status = 'error'; t.db = null; return cb(err);
        }

        t.db.open({ createIfMissing: createIfMissing, compression: false, maxOpenFiles: 500, maxFileSize: 30 * 1024 * 1024 })
        .then(function() { t.status = 'open'; t.repairAttempts = 0; cb(null); })
        .catch(function(err) {
            var errStr = String(err);
            var code = err.code || '';

            if (errStr.indexOf('does not exist') >= 0 || code.indexOf('LEVEL_DATABASE_NOT_OPEN') >= 0) {
                t.db.close().then(function() { t.db = null; t.status = 'error'; cb(err); })
                .catch(function() { t.db = null; t.status = 'error'; cb(err); });
                return;
            }

            if (code.indexOf('LEVEL_CORRUPTION') >= 0 && t.repairAttempts < MAX_REPAIR_ATTEMPTS) {
                t.repairAttempts++;
                t.db.close().then(function() {
                    t.db = null;
                    ClassicLevel.repair(t.dbPath, function(repairErr) {
                        if (repairErr) { t.status = 'error'; return cb(repairErr); }
                        t.status = 'closed'; openTable(t, createIfMissing, cb);
                    });
                }).catch(function() { t.status = 'error'; cb(err); });
                return;
            }

            t.db.close().then(function() { t.db = null; t.status = 'error'; cb(err); })
            .catch(function() { t.db = null; t.status = 'error'; cb(err); });
        });
    }

    function closeTable(t, cb) {
        if (t.status !== 'open' || !t.db) return cb();
        cancelIdle(t);
        t.status = 'closing';
        t.db.close().then(function() { t.db = null; t.status = 'closed'; cb(); })
        .catch(function() { t.db = null; t.status = 'closed'; cb(); });
    }

    // =====================================================================
    // Idle Timer
    // =====================================================================

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

    // =====================================================================
    // Write Cache (during scan)
    // =====================================================================

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

    // =====================================================================
    // Flush Writes — batch
    // =====================================================================

    function flushWrites(t, cb) {
        if (t.writeQueue.length === 0) return cb();
        var batch = t.writeQueue; t.writeQueue = [];
        var ops = [];
        for (var i = 0; i < batch.length; i++) {
            var rows = batch[i].data;
            for (var j = 0; j < rows.length; j++) {
                var key = keys.toKeyBuffer(rows[j][0]);
                if (rows[j][1] === null) ops.push({ type: 'del', key: key });
                else ops.push({ type: 'put', key: key, value: new Uint8Array(rows[j][1]) });
            }
        }
        t.db.batch(ops).then(function() {
            for (var i = 0; i < batch.length; i++) batch[i].reply(null, batch[i].data.length);
            cb();
        }).catch(function(err) {
            for (var i = 0; i < batch.length; i++) batch[i].reply(err, 0);
            cb();
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
                dbResults[toFetch[i]] = values[i] !== undefined ? new Uint8Array(values[i]) : null;
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

    // =====================================================================
    // Scan
    // =====================================================================

    function scanChunk(t, after, limit, cb) {
        t.scanning = true;
        var pre = after === null ? flushWrites : noop;
        pre(t, function() {
            var iterOpts = { fillCache: false };
            if (after !== null) iterOpts.gt = keys.toKeyBuffer(after);
            var iterator = t.db.iterator(iterOpts);
            var rows = []; var bytes = 0;
            readNext();
            function readNext() {
                iterator.next().then(function(pair) {
                    if (!pair || pair[0] === undefined) {
                        return iterator.close().then(function() { t.scanning = false; cb(null, rows, null, true); });
                    }
                    var key = keys.fromKeyBuffer(pair[0]);
                    var value = new Uint8Array(pair[1]);
                    rows.push([key, value]);
                    bytes += pair[1].byteLength;
                    if (bytes >= CHUNK_BYTES || (limit > 0 && rows.length >= limit)) {
                        return iterator.close().then(function() { t.scanning = false; cb(null, rows, key, false); });
                    }
                    readNext();
                }).catch(function(err) {
                    iterator.close().then(function() { t.scanning = false; cb(err, rows, null, true); })
                    .catch(function() { t.scanning = false; cb(err, rows, null, true); });
                });
            }
        });
    }

    function noop(t, cb) { cb(); }

    // =====================================================================
    // Count — O(n), keys-only iterator
    // =====================================================================

    function countRecords(t, cb) {
        var n = 0;
        var iterator = t.db.iterator({ values: false });
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
        countRecords(t, function(n) {
            cb({ count: n, size: getDirSize(t.dbPath), status: t.status });
        });
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

    function rmrf(p, cb) {
        (fs.rm || fs.rmdir).call(fs, p, { recursive: true }, function(err) {
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
        close: close
    };
};
