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
 *   db.put('users', [[key, value], ...], function(err, count, ids) {});
 *   db.put('orders', [[null, value]], cb);   // auto-increment: ids = [1]
 *   db.get('users', [key1, key2], function(err, rows) {});
 *   db.scan('users', null, function(err, rows, cursor, done) {});
 *   db.scan('users', { limit: 100 }, function(err, rows, cursor, done) {});
 *
 *   // Paging — exact pages, either direction:
 *   db.scan('users', { after: lastKey, limit: 50, more: true }, cb);           // next
 *   db.scan('users', { before: firstKey, limit: 50, reverse: true, more: true }, cb);  // previous
 *   db.scan('users', { limit: 50, reverse: true }, cb);                        // last page
 *   db.scan('users', { offset: 1800, limit: 50 }, cb);                         // page 37
 *
 *   scan options (all optional; a bare key is shorthand for { after }):
 *     after    start past this key            before   stop before this key
 *     reverse  high keys to low               offset   skip N rows (keys only)
 *     limit    exactly N rows — no size cap; without it, chunks of ~64KB
 *     more     with limit: check (key only) whether a row follows, so
 *              `done` is exact — otherwise a limit stop says done: false
 *     values   false: keys only — rows is [key, ...], no value read
 *   rows come in the order read (descending with reverse).
 *
 *   db.count('users', function(err, count) {});   // LevelDB: count.txt
 *   db.stat('users', function(err, info) {});
 *   db.tables(function(err, list) {});
 *   db.drop('users', function(err) {});
 *   db.export('users', function(err, chunk, done, next) {});   // next(): backpressure
 *   db.import('users', buf, function(err, count) {});
 *   db.exportAll(function(err, chunk, done, next) {});        // whole database, one moment
 *   db.restoreAll(buf | stream, function(err, staged) {});    // staged.commit / cancel
 *   db.restore('users', buf | stream, cb);  db.rollback(cb);  db.dropPrevious(cb);
 *   db.close(function(err) {});
 *
 * One instance per database: everything goes through it (see src/core.js).
 */

var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
var keys = require('./src/keys');
var createCore = require('./src/core');

module.exports = function createDB(opts) {
    var engine;
    if (isNode) {
        engine = require('./src/engine-leveldb')(opts);
    } else {
        engine = require('./src/engine-indexeddb')(opts);
    }
    return createCore(engine);
};

// Key order as stored — for code that walks a table and must know where a
// key falls (uniIndexedDB.compareKeys in the browser bundle). Needs no
// instance: nothing is opened.
module.exports.compareKeys = keys.compareKeys;
