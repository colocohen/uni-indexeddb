# uni-indexeddb

Unified key-value storage for browser and server. Same API everywhere.

- **Browser / Service Worker** → IndexedDB
- **Node.js** → LevelDB (via classic-level)

## Features

- **Database-per-table** — each table is an isolated database
- **Auto-create** — tables are created on first `put`; reading a table that doesn't exist never creates it
- **Keys** — numbers, strings, or `Uint8Array`; values are `Uint8Array`. Stored as bytes, in the same order on both engines
- **Auto-increment** — `put` with key `null` gets the next number, as in MySQL
- **Batch operations** — multiple reads/writes coalesced into single transactions
- **Chunked scan** — iterate all records without loading everything into memory
- **Paging** — exact pages forward and back, jump to page N, keys-only reads
- **Export / Import** — binary backup format, streaming with backpressure, checksummed
- **Backup of the whole database at one moment** — `exportAll`, while writes go on
- **Atomic restore** — `restoreAll` / `restore`: staged, checked, switched in one write; `rollback`
- **Idle close** — unused tables close automatically after 15 seconds
- **Row count** — kept per table, read without scanning (LevelDB: `count.txt`)
- **Self-repair** — a corrupted LevelDB table is repaired once on open
- **Callback-first** — no promises, no async/await
- **Zero dependencies** — `classic-level` required on server (optional dependency)

## Install

```
npm install uni-indexeddb
```

On Node.js, also install the LevelDB binding:

```
npm install classic-level
```

## Usage

### Node.js

```js
var db = require('uni-indexeddb')({ dir: './data' });
```

### Browser (script tag)

```html
<script src="dist/uni-indexeddb.js"></script>
<script>
var db = uniIndexedDB();
</script>
```

### Browser (bundler)

```js
var db = require('uni-indexeddb')();
```

### ESM

```js
import createDB from 'uni-indexeddb';
var db = createDB({ dir: './data' });
```

## API

### `require('uni-indexeddb')(opts)`

Creates a database instance.

| Option | Default | Description |
|--------|---------|-------------|
| `dir` | `'./data'` | Server only. Directory for LevelDB files |

Returns an object with `put`, `get`, `scan`, `stat`, `count`, `tables`, `drop`, `export`, `import`, `exportAll`, `restoreAll`, `restore`, `rollback`, `dropPrevious`, `close`.

**One instance per database.** Every write must go through the same instance — on a server the one process or thread that owns the files, in a browser the Service Worker. The auto-increment counters, the snapshot of `exportAll` and the switch of a restore hold only then. The library does not coordinate several instances opening the same database.

Table names are any non-empty string without `~` — names with `~` are the library's own (see Restore).

All errors are objects with a `code`: `INVALID` (bad argument), `BUSY`, `NOT_FOUND`, `TRUNCATED`, `CHECKSUM`, `NO_PREVIOUS`, `STALE`, `SHUTTING_DOWN`, `DROPPED`, `SCAN_FAILED`, …

### `db.put(table, data, callback)`

Batch write. Creates the table if it doesn't exist.

- `table` — table name (string)
- `data` — array of `[key, value]` pairs. Values are `Uint8Array` or `null` (delete). Keys — see [Keys](#keys); `null` = auto-increment
- `callback(err, count, ids)` — count of operations; `ids[i]` is the key of row `i` as a scan returns it (the number given, for `null`). Called once the write is **in the database** (LevelDB batch committed / IndexedDB transaction complete) — never earlier, also when the put arrived while a scan was running.

A bad key fails the whole put with `INVALID`, nothing written.

Durability: LevelDB commits to its log without `fsync`, so a committed write survives a crash of the process, not a power loss of the machine. IndexedDB durability is the browser's.

```js
db.put('users', [
    ['user:1', new Uint8Array([1, 2, 3])],
    ['user:2', new Uint8Array([4, 5, 6])],
    ['user:3', null]  // delete
], function(err, count) {
    console.log(count); // 3
});
```

**Auto-increment** — as in MySQL:

```js
db.put('orders', [[null, a], [null, b], [555, c]], function(err, count, ids) {
    // ids = [1, 2, 555]
});
```

- Starts at 1, goes up by 1, and **never gives a number twice** — also after the row is deleted, after a restart, or after a put that failed (that number is skipped).
- A numeric key put by hand above the counter moves the counter up to it.
- The counter is stored **in the same batch / transaction** as the rows it numbers (LevelDB: under the empty key, hidden from every read; IndexedDB: the `meta` store).
- A table from before counters starts from its largest numeric key + 1.
- `[null, null]` is `INVALID`; so is a `null` when the counter is at 2^53 − 1.
- Numbers are given in the order `put` is called.

### `db.get(table, keys, callback)`

Batch read.

- `table` — table name
- `keys` — array of keys to fetch
- `callback(err, rows)` — rows is an object `{ key: Uint8Array|null }`

```js
db.get('users', ['user:1', 'user:2'], function(err, rows) {
    rows['user:1']; // Uint8Array([1, 2, 3])
    rows['user:2']; // Uint8Array([4, 5, 6])
});
```

### `db.scan(table, cursor, callback)`

Read records in key order — a whole table in chunks of ~64KB, or exact pages.

- `table` — table name
- `cursor` — `null` to start, a key to continue after, or an options object
- `callback(err, rows, nextCursor, done)` — rows is `[[key, value], ...]` (or `[key, ...]` with `values: false`), in the order read: ascending, descending with `reverse`. `nextCursor` is the last key read (`null` when `done`).

```js
// Full scan
db.scan('users', null, function(err, rows, cursor, done) {
    // rows: [[key, Uint8Array], ...]
    if (!done) db.scan('users', cursor, cb); // continue
});

// Scan with limit
db.scan('users', { limit: 100 }, function(err, rows, cursor, done) {
    // at most 100 records per call
    if (!done) db.scan('users', { limit: 100, after: cursor }, cb);
});
```

Cursor options:

| Option | Description |
|--------|-------------|
| `after` | Start past this key — exclusive (same as passing a bare key). `0` is a key |
| `before` | Stop before this key — exclusive |
| `reverse` | Read from high keys to low. `after`/`before` still mean key order, not reading direction |
| `limit` | Exactly this many records (fewer only at the end), whatever their size. 0 or omitted = byte-based chunks (~64KB, at least one record each) |
| `offset` | Skip this many records first — by key only, skipped values are never read (LevelDB: keys-only iterator; IndexedDB: `cursor.advance`). Cost grows with the offset |
| `more` | With `limit`: check, by key only, whether another record follows — `done` is then exact. Without it, a stop at the limit returns `done: false` ("there may be more") |
| `values` | `false` = keys only: rows is `[key, ...]` and no value is read |

**Paging:**

```js
db.scan('users', { limit: 50, more: true }, cb);                                  // first page
db.scan('users', { after: lastKeyOfPage, limit: 50, more: true }, cb);            // next
db.scan('users', { before: firstKeyOfPage, limit: 50, reverse: true, more: true }, cb);  // previous (rows descending)
db.scan('users', { limit: 50, reverse: true }, cb);                               // last page (rows descending)
db.scan('users', { offset: 36 * 50, limit: 50 }, cb);                             // page 37
db.scan('users', { values: false }, cb);                                          // keys only
```

Pages by key (`after`/`before`) cost the same anywhere in the table; `offset` walks the keys it skips.

A table that doesn't exist returns `(null, [], null, true)` — same as an empty table — and is not created. Any other failure is an error: `callback(err)` with a `code` (a scan never reports a failure as "empty, done").

### `db.count(table, callback)`

Count records in a table.

- `callback(err, count)` — number of records

In IndexedDB this is the native `store.count()`. In LevelDB the engine keeps the count itself: every batch moves it (a put of a new key +1, a delete of an existing one −1 — checked by key only), and it is stored in `count.txt` in the table's directory, one line of JSON with the write stats (see `stat`) — `"state":"clean"` after a clean close, `"state":"open"` while the table is open. A table opened after a crash (`open`), a table without the file, or one just repaired, is counted once by walking its keys, the first time a count is asked for.

```js
db.count('users', function(err, n) {
    console.log(n); // 1500
});
```

### `db.stat(table, callback)`

Table statistics.

- `callback(err, info)` — `{ count, size, status, tx_count, put_count, del_count, last_write, autoinc }`

| Field | Meaning |
|-------|---------|
| `count` | records in the table |
| `size` | LevelDB: bytes on disk. IndexedDB: bytes of keys and values, kept by every write |
| `status` | `'open'`, `'closed'`, or `'error'` |
| `tx_count` | write batches committed since the table was created |
| `put_count` | puts (inserts and updates) |
| `del_count` | deletes of keys that existed |
| `last_write` | time of the last committed write (ms), or `null` |
| `autoinc` | the auto-increment counter — the last number given (0: none yet) |

Both engines return the same fields. IndexedDB keeps them in its `meta` store, in the same transaction as each write. LevelDB keeps them in memory and writes them to `count.txt` on open and close — after a crash they are those of the last clean close.

### `db.tables(callback)`

List all existing tables.

- `callback(err, tables)` — sorted array of table names

In LevelDB this reads the data directory. In IndexedDB this uses `indexedDB.databases()`.

```js
db.tables(function(err, list) {
    console.log(list); // ['sessions', 'users']
});
```

### `db.drop(table, callback)`

Delete a table and all its data.

In LevelDB this removes the directory. In IndexedDB this calls `deleteDatabase()`. What a restore kept of the table (see `rollback`) goes too. `BUSY` while an export is reading the table.

```js
db.drop('sessions', function(err) {
    // table gone
});
```

### `db.export(table, callback)` / `db.exportAll(callback)`

Streaming export to a `.udb` file — one table, or every table of the database.

- `callback(err, chunk, done, next)` — `chunk` is a `Uint8Array`; the chunks in order are the file
- **Backpressure:** with a callback that takes `next`, the next chunk is read only after `next()`. `next(false)` stops the export (it must be stopped or finished — while it runs, changed keys are kept in memory). A callback without `next` gets the chunks one after another, as fast as they are read

```js
// Node.js — to a file, at the pace of the disk
var out = fs.createWriteStream('backup.udb');
db.exportAll(function(err, chunk, done, next) {
    if (err) return out.destroy(err);
    if (done) return out.end(chunk);
    if (out.write(chunk)) next();
    else out.once('drain', next);
});
```

**A snapshot of one moment.** The file is the database as it was when the export began — while writes go on, and on both engines alike:

1. For a moment no write batch is running anywhere (the ones running finish; new ones wait). That moment is the snapshot.
2. From then on, a batch that changes a key the export has not read yet hands the export that key's value from before it (copy-on-write).
3. The export reads the live tables and writes, for those keys, the value from the moment.

Writes are held up only for that moment. Extra memory: only the keys changed during the export. The tables being read are not closed for idling until it ends.

### `db.import(table, ...)`

Import a `.udb` file into a live table, row by row. From a v2 file: the table of that name in it (`NOT_FOUND` if none); from v1: all of it. Not atomic — rows go in as they come; for an all-or-nothing replacement use `restore`.

**One-shot** — entire buffer in memory:

```js
db.import('users', buf, function(err, count) {});
db.import('users', buf, { replace: true }, function(err, count) {});
```

**Streaming** — `write(chunk, cb)`: `cb(err)` once the chunk is taken in (its rows written), so a caller that waits for it never runs ahead of the database. `end(cb)`.

```js
var w = db.import('users', { replace: true }, function(err, count) {});
stream.on('data', function(chunk) {
    stream.pause();
    w.write(chunk, function(err) { if (err) stream.destroy(); else stream.resume(); });
});
stream.on('end', function() { w.end(); });
```

| Option | Default | Description |
|--------|---------|-------------|
| `replace` | `false` | After import, delete any keys that were not in the file — only if everything before went well |

Errors: `TRUNCATED` (the file ends early — anywhere, also between tables), `CHECKSUM` (a table's count or CRC32 does not match), `INVALID`. After an error `replace` deletes nothing. The table's auto-increment counter becomes the file's, if that is higher.

### `db.restoreAll(source, callback)` / `db.restore(table, source, callback)`

Replace the whole database (or one table) with a `.udb` file, all at once. `source` is a buffer, or omitted — then a writer is returned (`write(chunk, cb)`, `end(cb)`, `abort(err)`), as with `import`.

1. The file's tables are written to **new** tables; the live ones are not touched.
2. Each is checked: CRC32 and count from the file, then the count in the database.
3. `callback(err, staged)` — `staged = { tables: [{ name, count }], rows, commit(cb), cancel(cb) }`. Nothing has changed yet: show `staged`, then commit or cancel.
4. `staged.commit(cb)` switches every table in **one write**; calls arriving meanwhile wait. With `restoreAll`, tables not in the file become empty.

On any error in 1–2 the new tables are deleted and the database is as it was. One restore at a time (`BUSY`); a staged one not committed is cancelled when the next begins. A writer whose source goes away must be stopped with `abort()`.

```js
db.restoreAll(buf, function(err, staged) {
    if (err) return;                     // nothing changed
    console.log(staged.tables, staged.rows);
    staged.commit(function(err) {});     // or staged.cancel()
});
```

### `db.rollback(callback)` / `db.dropPrevious(callback)`

After a commit, the tables that were live are kept. `rollback` switches back to them (and, called again, forward); nothing is deleted. `NO_PREVIOUS` when there is nothing. `dropPrevious` deletes them. `db.previous(cb)` → `cb(err, [name, ...])`: the tables a rollback would switch (`[]`: nothing to roll back). The next commit deletes them too — only the last restore can be rolled back.

**How it works:** neither IndexedDB nor LevelDB can rename a database, so the library keeps a small catalog (a table of its own, `~catalog`) from a table's name to where its rows are: `users` → `users~4`. A table without an entry is under its own name — nothing moves in a database that was never restored. A switch is one write to the catalog. Tables with `~` in their name are the library's; `tables()` does not list them.

### `db.close(callback)`

Flush pending writes and close all tables.

## Binary Format (.udb)

Version 2 (written):

```
"UDB" 0x02
0x02 table   [varint name_len] [name UTF-8] [varint autoinc]
0x01 record  [varint key_len]  [key bytes]  [varint val_len] [val bytes]
0x03 end     [varint count] [CRC32, 4 bytes]      ← per table
0x04 eof     [varint tables]                      ← once, last
```

The key is the bytes as stored, so every key comes back as it was — numeric, text or binary. CRC32 covers a table's record frames; a file cut anywhere lacks its `0x04` frame. Varint: unsigned LEB128, up to 2^53.

Version 1 (`"UDB" 0x01`, records `[varint key_len] [key UTF-8] [varint val_len] [val]` to the end of file) is still read by `import` and `restore(table)`.

## Keys

Stored as bytes, compared byte by byte — the same order on IndexedDB and LevelDB:

- **Numeric keys** — non-negative integers up to 2^53 − 1: a number, a bigint, or a string of digits (`'2024'`, up to 20 digits; leading zeros are lost). Stored as 8 bytes big-endian, so they sort as numbers, before every text key. **A scan returns them as numbers** (`555`, not `'555'`). Larger ones are `INVALID` — they could not come back as the same number.
- **Strings** — UTF-8 bytes. Negative or fractional numbers are stored as their text (`'-5'`).
- **Uint8Array** — the bytes as they are (a scan returns them decoded as UTF-8).
- `''` and an empty `Uint8Array` are `INVALID` (the empty key is reserved). `null` is auto-increment in `put`, `INVALID` elsewhere.

`get` answers in an object, so its keys are strings there (`rows['555']`, which is also `rows[555]`).

`require('uni-indexeddb').compareKeys(a, b)` (in the browser `uniIndexedDB.compareKeys`) orders two keys as stored: −1, 0 or 1.

## Architecture

```
uni-indexeddb/
├── index.js                  ← entry point, picks the engine
└── src/
    ├── core.js               ← everything the same on both engines: key checks,
    │                           auto-increment, catalog, export/import, snapshot, restore
    ├── engine-leveldb.js     ← Node.js backend (classic-level)
    ├── engine-indexeddb.js   ← Browser/SW backend (IndexedDB)
    ├── keys.js               ← shared key encoding
    └── binary.js             ← the .udb format (encoder, streaming parser, CRC32)
```

Tests run the same cases on both engines (IndexedDB through `fake-indexeddb`): `npm test`.

Each table maps to:
- **Server**: a separate LevelDB directory under `opts.dir` (plus the engine's `count.txt`, which LevelDB ignores)
- **Browser**: a separate IndexedDB database (a `data` store and a `meta` store with the running stats)

## Ordering

Per table, queued writes are committed before queued reads are answered, so a `get` after a `put` sees it. LevelDB batches go one at a time. The first chunk of a scan sees every write queued before it; a write that arrives while a chunk is being read is visible to `get` at once, goes in when that chunk is done, and is not seen by the chunk already in progress.

## Corruption (LevelDB)

A table that fails to open with `LEVEL_CORRUPTION` is repaired once (`ClassicLevel.repair`) and reopened. A repair can drop records, so its count is recounted; the write stats are kept. Works with classic-level 1 (callback API) and 2+ (promise API, open errors wrapped in `err.cause`).

## License

MIT
