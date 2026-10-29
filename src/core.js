/**
 * core.js — what uni-indexeddb does the same on every engine
 *
 * Sits between the public API (index.js) and an engine (engine-leveldb.js
 * in Node, engine-indexeddb.js in the browser). Everything here is written
 * once, so the two behave alike by construction; an engine only stores:
 *
 *   put(table, rows, cb, counter)   rows with checked keys; counter: the
 *                                   auto-increment value to store with them
 *   get / scan / stat / count / tables / drop / close
 *   readCounter(table, cb)          the stored counter (or the largest
 *                                   numeric key when none is stored)
 *   quiesce(cb(resume))             no batch running, none starts until resume
 *   watch(table, fn) → unwatch      fn(key, oldValue) before a batch changes a key
 *   hold(table, ±1)                 no idle close while > 0
 *
 * Precondition: ONE instance per database — on a server the one process or
 * thread that owns the files, in a browser the Service Worker. Everything
 * here (the counters, the catalog, snapshots, the switch of a restore)
 * holds only if every write goes through it.
 *
 * Tables (see Catalog): a table's name is what callers use; where its rows
 * live is a physical table — the same name, or 'name~N' after a restore.
 * Names with '~' are the library's own: refused from callers.
 */

var keys = require('./keys');
var binary = require('./binary');

var IMPORT_BATCH = 500;
var CATALOG = '~catalog';
var GEN_KEY = '~gen';

var _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var _dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function invalid(message) { return { code: 'INVALID', message: message }; }

function checkTable(table) {
    if (typeof table !== 'string' || table.length === 0) return invalid('table must be a non-empty string');
    if (table.indexOf('~') >= 0) return invalid('table names with ~ are reserved');
    return null;
}

module.exports = function createCore(engine) {

    // =====================================================================
    // Gate — every call waits here while the catalog loads or switches
    // =====================================================================

    var gated = 1;            // closed until the catalog is loaded
    var gateQueue = [];
    var fatal = null;         // the catalog could not be read: every call fails

    // fn now, or once the gate opens. cb: where a fatal error goes.
    function run(cb, fn) {
        if (fatal) return cb(fatal);
        if (gated === 0) return fn();
        gateQueue.push([cb, fn]);
    }

    function closeGate() { gated++; }

    function openGate() {
        if (--gated > 0) return;
        while (gated === 0 && gateQueue.length) {
            var q = gateQueue; gateQueue = [];
            for (var i = 0; i < q.length; i++) {
                if (gated > 0) { gateQueue = q.slice(i).concat(gateQueue); break; }
                if (fatal) q[i][0](fatal); else q[i][1]();
            }
        }
    }

    // =====================================================================
    // Catalog — table name → physical table
    // =====================================================================
    //
    // A physical table of its own ('~catalog'), one row per table that a
    // restore has touched: name → { cur, prev }. cur holds the rows now;
    // prev the ones before the last restore (rollback swaps them). A table
    // with no row lives under its own name — nothing moves for a database
    // that has never been restored. '~gen' holds the last N given out.
    //
    // Every change is one put to '~catalog' — one batch / one transaction:
    // all of it, or none.

    var catalog = Object.create(null);
    var gen = 0;

    loadCatalog(function(err) {
        if (err) fatal = { code: 'CATALOG_FAILED', message: err.message || err.code };
        openGate();
    });

    function loadCatalog(cb) {
        (function next(after) {
            engine.scan(CATALOG, after === null ? null : { after: after }, function(err, rows, cursor, done) {
                if (err) return cb(err);
                for (var i = 0; i < rows.length; i++) {
                    var v;
                    try { v = JSON.parse(_dec.decode(rows[i][1])); } catch (e) { return cb({ code: 'CATALOG_FAILED', message: 'bad catalog row' }); }
                    var name = String(rows[i][0]);
                    if (name === GEN_KEY) gen = v;
                    else catalog[name] = v;
                }
                if (done) return cb(null);
                next(cursor);
            });
        })(null);
    }

    function phys(name) {
        var e = catalog[name];
        return e ? e.cur : name;
    }

    // changes: { name: {cur, prev} | null }. One write; memory follows it.
    function writeCatalog(changes, newGen, cb) {
        var rows = [];
        for (var name in changes) {
            rows.push([name, changes[name] ? _enc.encode(JSON.stringify(changes[name])) : null]);
        }
        if (newGen !== null) rows.push([GEN_KEY, _enc.encode(JSON.stringify(newGen))]);
        if (rows.length === 0) return cb(null);
        engine.put(CATALOG, rows, function(err) {
            if (err) return cb(err);
            for (var n in changes) {
                if (changes[n]) catalog[n] = changes[n];
                else delete catalog[n];
            }
            if (newGen !== null) gen = newGen;
            cb(null);
        });
    }

    // An entry back to "lives under its own name" is no entry at all.
    function entry(name, cur, prev) {
        return (cur === name && !prev) ? null : { cur: cur, prev: prev || null };
    }

    // Logical names of the tables there are.
    function logicalTables(cb) {
        engine.tables(function(err, list) {
            if (err) return cb(err);
            var exists = Object.create(null), out = [];
            for (var i = 0; i < list.length; i++) exists[list[i]] = true;
            for (var j = 0; j < list.length; j++) {
                if (list[j].indexOf('~') < 0 && !catalog[list[j]]) out.push(list[j]);
            }
            for (var name in catalog) {
                if (exists[catalog[name].cur]) out.push(name);
            }
            cb(null, out.sort(), exists);
        });
    }

    // =====================================================================
    // Auto-increment
    // =====================================================================
    //
    // As in MySQL: a row put with key null gets the next number — from 1,
    // one up each time, never given twice, also after a delete. A numeric
    // key put by hand above the counter moves it up to that key.
    //
    // Numbers are given out here, in the order put() is called, and the
    // counter goes to the engine with the rows: it is stored in the same
    // batch / transaction as they are. A number is given back only once its
    // row is in; one whose batch failed is skipped, never given again.
    //
    // counters[physical] — n: the last number given (null: not read yet);
    // queue: puts waiting while it is read (all of them, to keep order).

    var counters = Object.create(null);

    function putPhys(p, data, needCounter, minCounter, cb) {
        var c = counters[p];
        if (c && c.queue) { c.queue.push([data, needCounter, minCounter, cb]); return; }
        if (!needCounter) return engine.put(p, data, idsReply(data, data, cb));
        if (!c || c.n === null) {
            c = counters[p] = { n: null, queue: [[data, needCounter, minCounter, cb]] };
            engine.readCounter(p, function(err, n) {
                var q = c.queue; c.queue = null;
                if (err) {
                    for (var i = 0; i < q.length; i++) q[i][3](err);
                    return;
                }
                c.n = n;
                for (var j = 0; j < q.length; j++) putPhys(p, q[j][0], q[j][1], q[j][2], q[j][3]);
            });
            return;
        }
        var rows = data;
        for (var i = 0; i < data.length; i++) {
            var k = data[i][0];
            if (k === null) {
                if (c.n >= keys.MAX_SAFE) return cb(invalid('auto-increment is at 2^53-1 — no number left'));
                if (rows === data) rows = data.slice();
                rows[i] = [++c.n, data[i][1]];
            } else {
                var nv = keys.numericValue(k);
                if (nv > c.n) c.n = nv;
            }
        }
        if (minCounter > c.n) c.n = minCounter;
        engine.put(p, rows, idsReply(data, rows, cb), c.n);
    }

    // cb(err, count, ids): ids[i] — the key of row i, as a scan gives it
    // back (a number for a numeric key, the number given for null).
    function idsReply(data, rows, cb) {
        return function(err, count) {
            if (err) return cb(err);
            var ids = new Array(rows.length);
            for (var i = 0; i < rows.length; i++) ids[i] = keys.normalizeKey(rows[i][0]);
            cb(null, count, ids);
        };
    }

    // =====================================================================
    // Rows
    // =====================================================================

    function put(table, data, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad);
        if (!Array.isArray(data)) return cb(invalid('rows must be an array of [key, value|null]'));
        var needCounter = false;
        for (var i = 0; i < data.length; i++) {
            var row = data[i];
            if (!Array.isArray(row)) return cb(invalid('row ' + i + ' is not [key, value]'));
            if (row[0] === null) {
                if (row[1] === null || row[1] === undefined) return cb(invalid('row ' + i + ': [null, null] — nothing to insert, nothing to delete'));
                needCounter = true;
                continue;
            }
            var msg = keys.checkKey(row[0]);
            if (msg) return cb(invalid('row ' + i + ': ' + msg));
            if (!needCounter && keys.numericValue(row[0]) >= 0) needCounter = true;
        }
        run(cb, function() { putPhys(phys(table), data, needCounter, 0, cb); });
    }

    function get(table, list, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad);
        if (!Array.isArray(list)) return cb(invalid('keys must be an array'));
        for (var i = 0; i < list.length; i++) {
            var msg = keys.checkKey(list[i]);
            if (msg) return cb(invalid('key ' + i + ': ' + msg));
        }
        run(cb, function() { engine.get(phys(table), list, cb); });
    }

    function scan(table, cursor, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad);
        if (cursor !== null && cursor !== undefined) {
            var after = typeof cursor === 'object' ? cursor.after : cursor;
            var before = typeof cursor === 'object' ? cursor.before : null;
            var msg = (after != null && keys.checkKey(after)) || (before != null && keys.checkKey(before));
            if (msg) return cb(invalid(msg));
        }
        run(cb, function() { engine.scan(phys(table), cursor, cb); });
    }

    function stat(table, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad);
        run(cb, function() {
            var p = phys(table);
            engine.stat(p, function(err, info) {
                if (err) return cb(err);
                // The auto-increment counter: the last number given (0: none).
                counterOf(p, function(err2, n) {
                    info.autoinc = err2 ? null : n;
                    cb(null, info);
                });
            });
        });
    }

    function count(table, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad);
        run(cb, function() { engine.count(phys(table), cb); });
    }

    function tables(cb) {
        run(cb, function() {
            logicalTables(function(err, list) { cb(err || null, err ? [] : list); });
        });
    }

    // The table, and what a restore kept of it (prev), are gone.
    function drop(table, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad);
        run(cb, function() {
            var e = catalog[table];
            var targets = [table];
            if (e) { if (e.cur !== table) targets.push(e.cur); if (e.prev && e.prev !== table) targets.push(e.prev); }
            if (exporting(targets)) return cb({ code: 'BUSY', message: 'an export is reading ' + table });
            dropAll(targets, function(err) {
                if (err) return cb(err);
                if (!e) return cb(null);
                var ch = {}; ch[table] = null;
                writeCatalog(ch, null, cb);
            });
        });
    }

    function dropAll(list, cb) {
        var i = 0, firstErr = null;
        (function next() {
            if (i >= list.length) return cb(firstErr);
            var p = list[i++];
            delete counters[p];
            engine.drop(p, function(err) { if (err && !firstErr) firstErr = err; next(); });
        })();
    }

    function close(cb) {
        engine.close(cb);
    }

    // =====================================================================
    // Export — export(table), exportAll()
    // =====================================================================
    //
    // cb(err, chunk, done, next) — chunks of a .udb v2 file (binary.js).
    // With a callback of four parameters the next chunk is read only after
    // next() (next(false): stop here — the snapshot is let go); with fewer,
    // they follow one another as fast as they are read.
    //
    // A snapshot, the same on both engines: at one moment (quiesce — no
    // batch running anywhere, none starting) every table to export is
    // watched; from then on, a batch that changes a key the export has not
    // read yet hands over that key's value from before it (watch). The
    // export reads the live table and, for those keys, puts in the value
    // kept. Writes are never held up past that moment; memory grows only by
    // the keys changed while the export runs.

    var exportingPhys = Object.create(null);   // physical → exports reading it

    function exporting(list) {
        for (var i = 0; i < list.length; i++) if (exportingPhys[list[i]]) return true;
        return false;
    }

    function exportTable(table, cb) {
        var bad = checkTable(table);
        if (bad) return cb(bad, null, true);
        exportImpl([table], cb);
    }

    function exportAll(cb) {
        exportImpl(null, cb);
    }

    function exportImpl(names, cb) {
        var manual = cb.length >= 4;
        var failed = function(err) { cb(err, null, true); };
        run(failed, function() {
            closeGate();
            if (names) return start(names);
            logicalTables(function(err, list) {
                if (err) { openGate(); return failed(err); }
                start(list);
            });
        });

        function start(list) {
            engine.quiesce(function(resume) {
                // ---- the snapshot's moment ----
                var snaps = [];
                for (var i = 0; i < list.length; i++) snaps.push(snapshot(list[i], phys(list[i])));
                resume();
                openGate();
                write(snaps);
            });
        }

        function write(snaps) {
            var enc = binary.createEncoder();
            var ti = 0, released = false;
            var pieces = [enc.header()];

            function release() {
                if (released) return;
                released = true;
                for (var i = 0; i < snaps.length; i++) snaps[i].release();
            }

            function deliver(chunk, done, cont) {
                if (done) release();
                if (!manual) { cb(null, chunk, done); if (!done) cont(); return; }
                var called = false;
                cb(null, chunk, done, function(go) {
                    if (called || done) return;
                    called = true;
                    if (go === false) return release();
                    cont();
                });
            }

            function fail(err) { release(); cb(err, null, true); }

            (function nextTable() {
                if (ti >= snaps.length) {
                    pieces.push(enc.endFile());
                    return deliver(binary.concat(pieces), true);
                }
                var s = snaps[ti++];
                counterOf(s.phys, function(err, autoinc) {
                    if (err) return fail(err);
                    pieces.push(enc.table(s.name, autoinc));
                    readTable(s);
                });

                function readTable(s) {
                    (function chunk(after) {
                        engine.scan(s.phys, { after: after, raw: true }, function(err, rows, cursor, done) {
                            if (err) return fail(err);
                            var out = s.take(rows, done);
                            if (out.length) pieces.push(enc.records(out));
                            if (done) {
                                s.release();
                                pieces.push(enc.endTable());
                                // Small tables share a chunk with the next.
                                var size = 0;
                                for (var i = 0; i < pieces.length; i++) size += pieces[i].length;
                                if (size < 64 * 1024 && ti < snaps.length) return nextTable();
                                var c = binary.concat(pieces); pieces = [];
                                return ti < snaps.length ? deliver(c, false, nextTable) : (pieces.push(c), nextTable());
                            }
                            var c2 = binary.concat(pieces); pieces = [];
                            deliver(c2, false, function() { chunk(cursor); });
                        });
                    })(null);
                }
            })();
        }
    }

    // The counter to write in a table's frame: the one in memory when there
    // is one (it may be ahead of the stored one — never behind).
    function counterOf(p, cb) {
        var c = counters[p];
        if (c && c.n !== null && !c.queue) return cb(null, c.n);
        engine.readCounter(p, cb);
    }

    // One table's snapshot. take(rows, done) → the rows to write, values as
    // they were at the moment: a key changed since then gets its kept
    // value; one that was not there then is left out; at the end, keys
    // deleted since are written from what was kept.
    function snapshot(name, p) {
        var kept = Object.create(null);   // id → [keyBytes, value | undefined]
        var last = null;                  // the last key read — keys ≤ it are passed
        var finished = false;
        exportingPhys[p] = (exportingPhys[p] || 0) + 1;
        engine.hold(p, 1);
        var unwatch = engine.watch(p, function(key, old) {
            if (finished) return;
            if (last !== null && keys.compareBytes(key, last) <= 0) return;
            var id = keys.bytesId(key);
            if (id in kept) return;
            kept[id] = [new Uint8Array(key), old];
        });
        var released = false;

        return {
            name: name, phys: p,
            take: function(rows, done) {
                if (rows.length) last = rows[rows.length - 1][0];
                var out = [];
                for (var i = 0; i < rows.length; i++) {
                    var id = keys.bytesId(rows[i][0]);
                    if (id in kept) {
                        var k = kept[id];
                        delete kept[id];
                        if (k[1] !== undefined) out.push([rows[i][0], k[1]]);
                    } else {
                        out.push(rows[i]);
                    }
                }
                if (done) {
                    finished = true;
                    for (var rest in kept) if (kept[rest][1] !== undefined) out.push(kept[rest]);
                    kept = Object.create(null);
                }
                return out;
            },
            release: function() {
                if (released) return;
                released = true; finished = true; kept = null;
                unwatch();
                engine.hold(p, -1);
                if (--exportingPhys[p] === 0) delete exportingPhys[p];
            }
        };
    }

    // =====================================================================
    // Reading a .udb stream — shared by import and restore
    // =====================================================================
    //
    // write(chunk, cb) — cb once the chunk is taken in (its rows written, up
    // to the last part-batch): a caller that waits for it never runs ahead
    // of the database. end(cb). Chunks are worked one at a time, in order.
    //
    // handler: { table(ev, cb), row(ev, cb), end(ev, cb), finish(cb) } —
    // every step is called in file order and waited for.

    function createStream(handler, onDone) {
        var parser = binary.createParser();
        var queue = [], busy = false, ended = false, finished = false;
        var error = null, endCbs = [];

        function pump() {
            if (busy || finished) return;
            if (error) {
                // Failed: over now — not when the caller gets round to end().
                finished = true;
                var q = queue; queue = [];
                for (var i = 0; i < q.length; i++) if (q[i][1]) q[i][1](error);
                return done(error);
            }
            if (queue.length) {
                var item = queue.shift();
                busy = true;
                var events;
                try { events = parser.parse(item[0]); }
                catch (e) { events = null; error = normalize(e); }
                runEvents(events || [], function(err) {
                    busy = false;
                    if (err && !error) error = err;
                    if (item[1]) item[1](error);
                    pump();
                });
                return;
            }
            if (!ended) return;
            finished = true;
            var tail;
            try { tail = parser.finish(); } catch (e) { return done(normalize(e)); }
            busy = true;
            runEvents(tail, function(err) {
                if (err) return done(err);
                handler.finish(done);
            });
        }

        function runEvents(events, cb) {
            var i = 0;
            (function next(err) {
                if (err) return cb(err);
                if (i >= events.length) return cb(null);
                var ev = events[i++];
                if (ev.t === 'row') return handler.row(ev, next);
                if (ev.t === 'table') return handler.table(ev, next);
                if (ev.t === 'end') return handler.end(ev, next);
                next(null);   // eof: finish() checks it was there
            })(null);
        }

        var doneCalled = false;
        function done(err) {
            if (doneCalled) return;
            doneCalled = true;
            var args = Array.prototype.slice.call(arguments);
            onDone.apply(null, args);
            for (var i = 0; i < endCbs.length; i++) endCbs[i](err || null);
        }

        return {
            write: function(chunk, cb) {
                if (finished && error) { if (cb) cb(error); return; }
                if (ended) { if (cb) cb({ code: 'ENDED' }); return; }
                if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
                queue.push([chunk, cb]);
                pump();
            },
            end: function(cb) {
                if (doneCalled) { if (cb) cb(error || null); return; }
                if (cb) endCbs.push(cb);
                if (ended) return;
                ended = true;
                pump();
            },
            // Stop: nothing more is written; the outcome is err.
            abort: function(err) {
                if (!error) error = err || { code: 'ABORTED' };
                ended = true;
                pump();
            }
        };
    }

    function normalize(e) {
        if (e && typeof e.code === 'string') return e;
        return { code: 'INVALID', message: e && e.message ? e.message : String(e) };
    }

    // import(buf, opts?, cb) or import(opts?, cb) → writer
    function parseArgs(a, b, c) {
        if (isBuffer(a)) {
            if (typeof b === 'function') return { buf: a, opts: {}, cb: b };
            return { buf: a, opts: b || {}, cb: c };
        }
        if (typeof a === 'function') return { buf: null, opts: {}, cb: a };
        return { buf: null, opts: a || {}, cb: b };
    }

    function isBuffer(v) {
        return v instanceof Uint8Array || v instanceof ArrayBuffer ||
               (typeof Buffer !== 'undefined' && Buffer.isBuffer(v));
    }

    function feed(stream, buf) {
        stream.write(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
        stream.end();
    }

    // =====================================================================
    // Import — into the live table, row by row
    // =====================================================================
    //
    // import(table, buf | stream, { replace }, cb(err, count)). From a v2
    // file: the table of that name in it (others are skipped, still
    // checked); from v1: all of it. Not atomic — rows go in as they come;
    // for an all-or-nothing swap see restore(). replace: afterwards, rows
    // not in the file are deleted — only when everything before went well.

    function importTable(table, a, b, c) {
        var args = parseArgs(a, b, c);
        var cb = args.cb, opts = args.opts;
        var bad = checkTable(table);
        if (bad) {
            if (args.buf) return cb(bad);
            var s0 = createStream({ table: noop2, row: noop2, end: noop2, finish: function(d) { d(bad); } }, cb);
            s0.abort(bad);
            return s0;
        }

        var taking = false, found = false, pending = [], total = 0, autoinc = 0;
        var importedKeys = opts.replace ? Object.create(null) : null;

        function flush(cb2) {
            if (pending.length === 0) return cb2(null);
            var batch = pending; pending = [];
            put(table, batch, function(err) {
                if (err) return cb2(err);
                total += batch.length;
                cb2(null);
            });
        }

        var stream = createStream({
            table: function(ev, cb2) {
                taking = ev.name === null || ev.name === table;
                if (taking) { found = true; autoinc = ev.autoinc; }
                cb2(null);
            },
            row: function(ev, cb2) {
                if (!taking) return cb2(null);
                if (importedKeys) importedKeys[keys.bytesId(keys.toKeyBuffer(ev.key))] = true;
                pending.push([ev.key, ev.value]);
                if (pending.length >= IMPORT_BATCH) return flush(cb2);
                cb2(null);
            },
            end: function(ev, cb2) {
                if (!taking) return cb2(null);
                taking = false;
                flush(cb2);
            },
            finish: function(cb2) {
                if (!found) return cb2({ code: 'NOT_FOUND', message: 'no table ' + JSON.stringify(table) + ' in the file' });
                // The file's counter: never lower the table's.
                run(cb2, function() {
                    putPhys(phys(table), [], true, autoinc, function(err) {
                        if (err) return cb2(err);
                        if (!importedKeys) return cb2(null, total);
                        deleteExtras(table, importedKeys, function(err2) { cb2(err2, total); });
                    });
                });
            }
        }, function(err, n) { cb(err || null, err ? total : n); });

        if (args.buf) return feed(stream, args.buf);
        return stream;
    }

    function deleteExtras(table, importedKeys, cb) {
        var toDelete = [];
        (function next(after) {
            scan(table, after === null ? { values: false, raw: true } : { after: after, values: false, raw: true }, function(err, rows, cursor, done) {
                if (err) return cb(err);
                for (var i = 0; i < rows.length; i++) {
                    if (!importedKeys[keys.bytesId(rows[i])]) toDelete.push([rows[i], null]);
                }
                if (!done) return next(cursor);
                if (toDelete.length === 0) return cb(null);
                put(table, toDelete, function(err2) { cb(err2); });
            });
        })(null);
    }

    function noop2(ev, cb) { cb(null); }

    // =====================================================================
    // Restore — restoreAll(), restore(table): staged, checked, switched
    // =====================================================================
    //
    // restoreAll(buf | stream, cb(err, staged))
    // restore(table, buf | stream, cb(err, staged))
    //
    // 1. The file's tables are written into new physical tables
    //    ('name~N'); the live ones are not touched.
    // 2. Each is checked: CRC32 and count from the file, and the count
    //    in the database after writing.
    // 3. cb(null, staged): staged = { tables: [{ name, count }], rows,
    //    commit(cb), cancel(cb) }. Nothing has changed yet.
    // 4. commit(): one catalog write switches every table at once; calls
    //    arriving meanwhile wait. restoreAll: tables not in the file become
    //    empty. What was live is kept as prev — rollback() returns to it,
    //    dropPrevious() deletes it; the prev of the restore before is
    //    deleted now.
    //
    // On any error in 1–2 the new tables are deleted, nothing live changed.
    // One restore at a time (BUSY); a staged one not committed is cancelled
    // when the next begins.

    var restoring = false;
    var staged = null;

    function restoreAll(a, b) {
        return restoreImpl(null, a, b);
    }

    function restoreOne(table, a, b) {
        var bad = checkTable(table);
        if (bad) {
            var args = parseArgs(a, b);
            if (args.buf) return args.cb(bad);
            var s0 = createStream({ table: noop2, row: noop2, end: noop2, finish: function(d) { d(bad); } }, args.cb);
            s0.abort(bad);
            return s0;
        }
        return restoreImpl(table, a, b);
    }

    function restoreImpl(only, a, b) {
        var args = parseArgs(a, b);
        var cb = args.cb;
        var busyErr = restoring ? { code: 'BUSY', message: 'a restore is running' } : null;
        if (!busyErr) restoring = true;

        var G = 0;               // N of the new physical tables
        var made = [];           // physical tables made — dropped on failure
        var done = [];           // [{ name, phys, count }]
        var seen = Object.create(null);
        var cur = null;          // { name, phys, pending, maxKey, autoinc } — the table being written
        var skipping = false;
        var ready = false, readyWaiters = [];

        // Before the first row: the staged restore not committed, and
        // leftovers of one cut short, are cleared away.
        function whenReady(cb2) {
            if (ready) return cb2(null);
            readyWaiters.push(cb2);
        }

        if (!busyErr) {
            run(function(err) { fireReady(err); }, function() {
                var prev = staged; staged = null;
                (prev ? prev.dropStaging : function(c) { c(); })(function() {
                    collectGarbage(function() {
                        G = gen + 1;
                        fireReady(null);
                    });
                });
            });
        }

        function fireReady(err) {
            ready = !err;
            var w = readyWaiters; readyWaiters = [];
            for (var i = 0; i < w.length; i++) w[i](err || null);
            if (err) readyErr = err;
        }
        var readyErr = null;

        function flush(cb2) {
            var batch = cur.pending; cur.pending = [];
            engine.put(cur.phys, batch, function(err) { cb2(err || null); });
        }

        var stream = createStream({
            table: function(ev, cb2) {
                if (busyErr) return cb2(busyErr);
                whenReady(function(err) {
                    if (err || readyErr) return cb2(err || readyErr);
                    var name = ev.name === null ? only : ev.name;
                    if (name === null) return cb2(invalid('a v1 file has no table names — restore(table, …) it'));
                    var bad = checkTable(name);
                    if (bad) return cb2(bad);
                    if (seen[name]) return cb2(invalid('table ' + JSON.stringify(name) + ' twice in the file'));
                    seen[name] = true;
                    if (only !== null && name !== only) { skipping = true; return cb2(null); }
                    skipping = false;
                    var p = name + '~' + G;
                    made.push(p);
                    delete counters[p];
                    cur = { name: name, phys: p, pending: [], maxKey: 0, autoinc: ev.autoinc };
                    cb2(null);
                });
            },
            row: function(ev, cb2) {
                if (skipping) return cb2(null);
                var k = ev.key;
                var msg = keys.checkKey(k);
                if (msg) return cb2(invalid('table ' + JSON.stringify(cur.name) + ': ' + msg));
                var nv = keys.numericValue(k);
                if (nv > cur.maxKey) cur.maxKey = nv;
                cur.pending.push([k, ev.value]);
                if (cur.pending.length >= IMPORT_BATCH) return flush(cb2);
                cb2(null);
            },
            end: function(ev, cb2) {
                if (skipping) { skipping = false; return cb2(null); }
                var t = cur; cur = null;
                // Last rows, with the counter — also for an empty table, so
                // that it exists.
                var counter = Math.max(t.autoinc, t.maxKey);
                engine.put(t.phys, t.pending, function(err) {
                    if (err) return cb2(err);
                    engine.count(t.phys, function(err2, n) {
                        if (err2) return cb2(err2);
                        if (ev.count >= 0 && n !== ev.count) {
                            return cb2({ code: 'CHECKSUM', message: 'table ' + JSON.stringify(t.name) + ': ' + n + ' rows written, the file has ' + ev.count });
                        }
                        done.push({ name: t.name, phys: t.phys, count: n });
                        cb2(null);
                    });
                }, counter);
            },
            finish: function(cb2) {
                if (only !== null && !done.length) return cb2({ code: 'NOT_FOUND', message: 'no table ' + JSON.stringify(only) + ' in the file' });
                cb2(null);
            }
        }, function(err) {
            if (busyErr) return cb(busyErr);
            if (err) {
                restoring = false;
                return dropAll(made, function() { cb(err); });
            }
            restoring = false;
            staged = makeStaged(only, G, done, made);
            cb(null, staged);
        });

        if (args.buf) return feed(stream, args.buf);
        return stream;
    }

    function makeStaged(only, G, done, made) {
        var rows = 0, list = [];
        for (var i = 0; i < done.length; i++) { rows += done[i].count; list.push({ name: done[i].name, count: done[i].count }); }
        var s = {
            tables: list,
            rows: rows,
            commit: function(cb) { commitStaged(s, only, G, done, cb); },
            cancel: function(cb) {
                if (staged !== s) return cb && cb({ code: 'STALE', message: 'not the staged restore' });
                staged = null;
                dropAll(made, function(err) { if (cb) cb(err || null); });
            },
            dropStaging: function(cb) { dropAll(made, function() { cb(); }); }
        };
        return s;
    }

    function commitStaged(s, only, G, done, cb) {
        run(cb, function() {
            if (staged !== s) return cb({ code: 'STALE', message: 'not the staged restore' });
            if (restoring) return cb({ code: 'BUSY', message: 'a restore is running' });

            // Every prev now is dropped after the switch — it must not be
            // what an export is reading.
            var oldPrevs = [];
            for (var n in catalog) if (catalog[n].prev) oldPrevs.push(catalog[n].prev);
            if (exporting(oldPrevs)) return cb({ code: 'BUSY', message: 'an export is reading a table this restore would delete' });

            staged = null;
            closeGate();
            logicalTables(function(err, live) {
                if (err) { openGate(); return cb(err); }
                var changes = {};
                // Tables untouched by this restore lose their prev.
                for (var n2 in catalog) {
                    if (catalog[n2].prev) changes[n2] = entry(n2, catalog[n2].cur, null);
                }
                var inFile = Object.create(null);
                for (var i = 0; i < done.length; i++) {
                    inFile[done[i].name] = true;
                    changes[done[i].name] = entry(done[i].name, done[i].phys, phys(done[i].name));
                }
                if (only === null) {
                    // Not in the file: empty now — a physical table not made
                    // until something is written to it.
                    for (var j = 0; j < live.length; j++) {
                        if (!inFile[live[j]]) changes[live[j]] = entry(live[j], live[j] + '~' + G, phys(live[j]));
                    }
                }
                writeCatalog(changes, G, function(err2) {
                    openGate();
                    if (err2) return cb(err2);
                    dropAll(oldPrevs.filter(function(p) { return !isReferenced(p); }), function() {
                        cb(null);
                    });
                });
            });
        });
    }

    function isReferenced(p) {
        for (var n in catalog) if (catalog[n].cur === p || catalog[n].prev === p) return true;
        return false;
    }

    // Physical 'name~N' tables nothing points to — what a restore cut short
    // (or a crash) left behind.
    function collectGarbage(cb) {
        engine.tables(function(err, list) {
            if (err) return cb();
            var junk = [];
            for (var i = 0; i < list.length; i++) {
                var p = list[i];
                if (p === CATALOG || p.indexOf('~') < 0) continue;
                if (!isReferenced(p) && !exportingPhys[p]) junk.push(p);
            }
            dropAll(junk, function() { cb(); });
        });
    }

    // Back to what was live before the last restore (and, called again,
    // forward to it). Nothing is deleted.
    function rollback(cb) {
        run(cb, function() {
            var changes = {}, any = false;
            for (var n in catalog) {
                var e = catalog[n];
                if (!e.prev) continue;
                any = true;
                changes[n] = { cur: e.prev, prev: e.cur };
            }
            if (!any) return cb({ code: 'NO_PREVIOUS', message: 'nothing to roll back to' });
            closeGate();
            writeCatalog(changes, null, function(err) {
                openGate();
                cb(err || null);
            });
        });
    }

    // The tables a rollback would switch back — those the last restore kept
    // a previous version of. cb(err, [name, ...]); [] — nothing to roll back.
    function previous(cb) {
        run(cb, function() {
            var list = [];
            for (var n in catalog) if (catalog[n].prev) list.push(n);
            cb(null, list.sort());
        });
    }

    // Delete what the last restore kept (prev).
    function dropPrevious(cb) {
        run(cb, function() {
            var changes = {}, prevs = [];
            for (var n in catalog) {
                var e = catalog[n];
                if (!e.prev) continue;
                prevs.push(e.prev);
                changes[n] = entry(n, e.cur, null);
            }
            if (!prevs.length) return cb(null);
            if (exporting(prevs)) return cb({ code: 'BUSY', message: 'an export is reading a previous table' });
            writeCatalog(changes, null, function(err) {
                if (err) return cb(err);
                dropAll(prevs.filter(function(p) { return !isReferenced(p); }), cb);
            });
        });
    }

    return {
        put: put,
        get: get,
        scan: scan,
        stat: stat,
        count: count,
        tables: tables,
        drop: drop,
        close: close,
        export: exportTable,
        exportAll: exportAll,
        import: importTable,
        restoreAll: restoreAll,
        restore: restoreOne,
        rollback: rollback,
        previous: previous,
        dropPrevious: dropPrevious
    };
};
