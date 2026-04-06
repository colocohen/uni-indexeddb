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
var db = uniIndexedDB({ prefix: 'myapp' });
</script>
```

### Browser (bundler)

```js
var db = require('uni-indexeddb')();
// Bundler auto-swaps LevelDB engine for IndexedDB via "browser" field
```

### ESM

```js
import createDB from 'uni-indexeddb';
var db = createDB({ dir: './data' });
```

### API

```js Write (batch) — value=null deletes the key
db.put('users', [
    ['user:1', new Uint8Array([1, 2, 3])],
    ['user:2', new Uint8Array([4, 5, 6])],
    ['user:3', null]  // delete
], function(err, count) {
    console.log(count); // 3
});

// Read (batch)
db.get('users', ['user:1', 'user:2'], function(err, rows) {
    rows['user:1']; // Uint8Array([1, 2, 3])
    rows['user:2']; // Uint8Array([4, 5, 6])
});

// Scan (chunked iteration)
function scanAll(cursor) {
    db.scan('users', cursor, function(err, rows, nextCursor, done) {
        for (var i = 0; i < rows.length; i++) {
            var key = rows[i][0];
            var value = rows[i][1];
            // process each record
        }
        if (!done) scanAll(nextCursor);
    });
}
scanAll(null);

// Stats
db.stat('users', function(err, info) {
    info.count;  // number of records
    info.size;   // bytes on disk (server only, 0 in browser)
    info.status; // 'open' | 'closed' | 'error'
});

// Close all tables
db.close(function(err) {});
```

## API

### `require('uni-indexeddb')(opts)`

Creates a database instance.

| Option | Default | Description |
|--------|---------|-------------|
| `dir` | `'./data'` | Server only. Directory for LevelDB files |
| `prefix` | `''` | Browser only. Prefix for IndexedDB database names |

Returns an object with `put`, `get`, `scan`, `stat`, `close`.

### `db.put(table, data, callback)`

Batch write. Creates the table if it doesn't exist.

- `table` — table name (string)
- `data` — array of `[key, value]` pairs. Keys are strings or numbers. Values are `Uint8Array` or `null` (delete)
- `callback(err, count)` — count of operations

### `db.get(table, keys, callback)`

Batch read.

- `table` — table name
- `keys` — array of keys to fetch
- `callback(err, rows)` — rows is an object `{ key: Uint8Array|null }`

### `db.scan(table, cursor, callback)`

Iterate all records in sort order, chunked by ~64KB.

- `table` — table name
- `cursor` — `null` for start, or the cursor from a previous scan
- `callback(err, rows, nextCursor, done)` — rows is `[[key, value], ...]`

### `db.stat(table, callback)`

Table statistics.

- `callback(err, info)` — `{ count, size, status }`

### `db.close(callback)`

Flush pending writes and close all tables.

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
└── src/
    ├── engine-leveldb.js     ← Node.js backend (classic-level)
    ├── engine-indexeddb.js   ← Browser/SW backend (IndexedDB)
    └── keys.js               ← shared key encoding
```

Each table maps to:
- **Server**: a separate LevelDB directory under `opts.dir`
- **Browser**: a separate IndexedDB database (no version management needed)

## License

MIT
