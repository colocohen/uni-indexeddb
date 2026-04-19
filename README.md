# uni-indexeddb

Unified key-value storage for browser and server. Same API everywhere.

- **Browser / Service Worker** → IndexedDB
- **Node.js** → LevelDB (via classic-level)

## Features

- **Database-per-table** — each table is an isolated database
- **Auto-create** — tables are created on first `put`
- **Binary keys & values** — everything is `Uint8Array`
- **Batch operations** — multiple reads/writes coalesced into single transactions
- **Chunked scan** — iterate all records without loading everything into memory
- **Export / Import** — binary backup format with streaming support
- **Idle close** — unused tables close automatically after 15 seconds
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

Returns an object with `put`, `get`, `scan`, `stat`, `count`, `tables`, `drop`, `export`, `import`, `close`.

### `db.put(table, data, callback)`

Batch write. Creates the table if it doesn't exist.

- `table` — table name (string)
- `data` — array of `[key, value]` pairs. Keys are strings or numbers. Values are `Uint8Array` or `null` (delete)
- `callback(err, count)` — count of operations

```js
db.put('users', [
    ['user:1', new Uint8Array([1, 2, 3])],
    ['user:2', new Uint8Array([4, 5, 6])],
    ['user:3', null]  // delete
], function(err, count) {
    console.log(count); // 3
});
```

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

Iterate all records in sort order, chunked by ~64KB or by limit.

- `table` — table name
- `cursor` — `null` to start, a key string to continue, or an options object
- `callback(err, rows, nextCursor, done)` — rows is `[[key, value], ...]`

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
| `after` | Key to start after (same as passing a string cursor) |
| `limit` | Max records per chunk. 0 or omitted = byte-based chunking (~64KB) |

A table that doesn't exist returns `(null, [], null, true)` — same as an empty table. This is by design.

### `db.count(table, callback)`

Count records in a table.

- `callback(err, count)` — number of records

In IndexedDB this is O(1) (native `store.count()`). In LevelDB this is O(n) (iterator scan).

```js
db.count('users', function(err, n) {
    console.log(n); // 1500
});
```

### `db.stat(table, callback)`

Table statistics.

- `callback(err, info)` — `{ count, size, status }`

`size` is bytes on disk (LevelDB only, 0 in browser). `status` is `'open'`, `'closed'`, or `'error'`.

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

In LevelDB this removes the directory. In IndexedDB this calls `deleteDatabase()`.

```js
db.drop('sessions', function(err) {
    // table gone
});
```

### `db.export(table, callback)`

Streaming export to binary format. Callback is called once per scan chunk (~64KB).

- `callback(err, chunk, done)` — chunk is `Uint8Array`, done is boolean

```js
// Node.js — export to file
var fs = require('fs');
var out = fs.createWriteStream('users.udb');
db.export('users', function(err, chunk, done) {
    if (err) return console.error(err);
    if (chunk) out.write(chunk);
    if (done) out.end();
});

// Browser — export to download
var chunks = [];
db.export('users', function(err, chunk, done) {
    if (chunk) chunks.push(chunk);
    if (done) {
        var blob = new Blob(chunks);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'users.udb';
        a.click();
    }
});
```

The export is best-effort — not an atomic snapshot. If writes happen during export, the result may contain a mix of old and new data. Stop writes before export if you need consistency.

### `db.import(table, ...)`

Import from binary format. Two modes: one-shot and streaming.

**One-shot** — entire buffer in memory:

```js
db.import('users', buf, function(err, count) {
    console.log('imported', count, 'records');
});

// With replace — delete keys not in the backup after import
db.import('users', buf, { replace: true }, function(err, count) {});
```

**Streaming** — for large files:

```js
var w = db.import('users', { replace: true }, function(err, count) {
    console.log('imported', count, 'records');
});
w.write(chunk1);
w.write(chunk2);
w.end();

// Node.js — import from file
var w = db.import('users', function(err, count) {});
var stream = fs.createReadStream('users.udb');
stream.on('data', function(chunk) { w.write(chunk); });
stream.on('end', function() { w.end(); });
```

Import options:

| Option | Default | Description |
|--------|---------|-------------|
| `replace` | `false` | After import, delete any keys that were not in the backup |

Without `replace`, import is a merge — existing keys not in the backup are kept, existing keys in the backup are overwritten.

With `replace: true`, the table will contain exactly what was in the backup. There is no "empty window" — all records are written first, then extras are deleted.

For a clean slate (drop + import), call `db.drop` then `db.import` explicitly.

### `db.close(callback)`

Flush pending writes and close all tables.

## Binary Format (.udb)

Export/import uses a compact binary format:

```
Header:  0x55 0x44 0x42 0x01     ("UDB" + version 1)
Record:  [varint key_len] [key UTF-8] [varint val_len] [val bytes]
...records repeat until end of file
```

Varint is unsigned LEB128 (same as protobuf). The format is streaming-friendly — chunks can be concatenated to form a valid file.

## Key Encoding

Keys are encoded to `Uint8Array` for binary sorting:

- **Numbers** (and numeric strings like `"123"`) → 8-byte big-endian. Sorts correctly as binary
- **Strings** → UTF-8 encoded bytes
- **Uint8Array** → passed through as-is

This ensures identical sort order on both IndexedDB and LevelDB.

## Architecture

```
uni-indexeddb/
├── index.js                  ← entry point, auto-detects environment
│                               adds export/import on top of engine
└── src/
    ├── engine-leveldb.js     ← Node.js backend (classic-level)
    ├── engine-indexeddb.js   ← Browser/SW backend (IndexedDB)
    ├── keys.js               ← shared key encoding
    └── binary.js             ← export/import binary format (varint + encode/decode)
```

Each table maps to:
- **Server**: a separate LevelDB directory under `opts.dir`
- **Browser**: a separate IndexedDB database

## License

MIT
