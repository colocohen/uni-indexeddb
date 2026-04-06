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
 *   db.stat('users', function(err, info) {});
 *   db.close(function(err) {});
 */

var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

module.exports = function createDB(opts) {
    if (isNode) {
        return require('./src/engine-leveldb')(opts);
    } else {
        return require('./src/engine-indexeddb')(opts);
    }
};
