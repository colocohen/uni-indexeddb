/**
 * uni-indexeddb — Unified key-value storage for browser and server
 *
 * Browser/SW: IndexedDB (database-per-table)
 * Node.js:    LevelDB via classic-level (database-per-table)
 *
 * Same API everywhere. Binary keys and values.
 * Callback-first. Zero dependencies (classic-level required on server).
 *
 * Usage:
 *   var db = require('uni-indexeddb')({ dir: './data' });
 *
 *   db.put('users', [[key, value], ...], function(err, count) {});
 *   db.get('users', [key1, key2], function(err, rows) {});
 *   db.scan('users', null, function(err, rows, cursor, done) {});
 *   db.scan('users', { limit: 100 }, function(err, rows, cursor, done) {});
 *   db.count('users', function(err, count) {});
 *   db.stat('users', function(err, info) {});
 *   db.tables(function(err, list) {});
 *   db.drop('users', function(err) {});
 *   db.export('users', function(err, chunk, done) {});
 *   db.import('users', buf, function(err, count) {});
 *   db.close(function(err) {});
 */

var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
var binary = require('./src/binary');

module.exports = function createDB(opts) {
    var engine;
    if (isNode) {
        engine = require('./src/engine-leveldb')(opts);
    } else {
        engine = require('./src/engine-indexeddb')(opts);
    }

    var IMPORT_BATCH = 500;

    // =====================================================================
    // Export — streaming, binary format
    // =====================================================================

    function exportTable(table, cb) {
        var first = true;
        (function next(cursor) {
            engine.scan(table, cursor, function(err, rows, nextCursor, done) {
                if (err) return cb(err, null, true);
                if (rows.length === 0 && first) {
                    // Empty table — still produce valid header
                    cb(null, binary.encodeChunk([], true), true);
                    return;
                }
                var chunk = binary.encodeChunk(rows, first);
                first = false;
                cb(null, chunk, done);
                if (!done) next(nextCursor);
            });
        })(null);
    }

    // =====================================================================
    // Import — one-shot or streaming, with optional replace
    // =====================================================================

    function importTable(table, a, b, c) {
        var buf, opts, cb;

        if (isBuffer(a)) {
            buf = a;
            if (typeof b === 'function') { opts = {}; cb = b; }
            else { opts = b || {}; cb = c; }
        } else if (typeof a === 'function') {
            opts = {}; cb = a;
        } else {
            opts = a || {};
            cb = b;
        }

        var writer = createWriter(table, opts, cb);

        if (buf) {
            writer.write(buf);
            writer.end();
            return;
        }

        return writer;
    }

    function createWriter(table, opts, cb) {
        var parser = binary.createParser();
        var pendingRecords = [];
        var importedKeys = opts.replace ? Object.create(null) : null;
        var totalCount = 0;
        var error = null;
        var flushing = false;
        var ended = false;

        function addRecords(records) {
            for (var i = 0; i < records.length; i++) {
                pendingRecords.push(records[i]);
                if (importedKeys) importedKeys[records[i][0]] = true;
            }
            tryFlush();
        }

        function tryFlush() {
            if (flushing) return;
            if (pendingRecords.length < IMPORT_BATCH && !ended) return;
            if (pendingRecords.length === 0) {
                if (ended) finish();
                return;
            }
            flushing = true;
            var batch = pendingRecords.splice(0, IMPORT_BATCH);
            engine.put(table, batch, function(err) {
                flushing = false;
                if (err && !error) error = err;
                totalCount += batch.length;
                tryFlush();
            });
        }

        function finish() {
            if (error) return cb(error, totalCount);
            if (!importedKeys) return cb(null, totalCount);
            deleteExtras(table, importedKeys, function(err) {
                cb(err, totalCount);
            });
        }

        return {
            write: function(chunk) {
                if (error || ended) return;
                try {
                    var buf = (chunk instanceof Uint8Array) ? chunk : new Uint8Array(chunk);
                    var records = parser.parse(buf);
                    if (records.length > 0) addRecords(records);
                } catch (e) {
                    error = { code: 'PARSE_ERROR', message: e.message };
                }
            },
            end: function() {
                if (ended) return;
                ended = true;
                tryFlush();
            }
        };
    }

    function deleteExtras(table, importedKeys, cb) {
        var toDelete = [];
        (function next(cursor) {
            engine.scan(table, cursor, function(err, rows, nextCursor, done) {
                if (err) return cb(err);
                for (var i = 0; i < rows.length; i++) {
                    if (!importedKeys[rows[i][0]]) {
                        toDelete.push([rows[i][0], null]);
                    }
                }
                if (done) {
                    if (toDelete.length === 0) return cb(null);
                    engine.put(table, toDelete, function(err2) { cb(err2); });
                } else {
                    next(nextCursor);
                }
            });
        })(null);
    }

    function isBuffer(v) {
        return v instanceof Uint8Array ||
               (typeof Buffer !== 'undefined' && Buffer.isBuffer(v));
    }

    // =====================================================================
    // Return public API
    // =====================================================================

    return {
        put: engine.put,
        get: engine.get,
        scan: engine.scan,
        stat: engine.stat,
        count: engine.count,
        tables: engine.tables,
        drop: engine.drop,
        close: engine.close,
        export: exportTable,
        import: importTable
    };
};
