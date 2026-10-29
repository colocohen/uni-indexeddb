/**
 * keys.js — Binary key encoding for uni-indexeddb
 *
 * Numbers → 8-byte big-endian Uint8Array (correct sort order)
 * Strings → UTF-8 encoded Uint8Array
 * Uint8Array → passed through
 *
 * This ensures identical ordering on LevelDB (byte comparison)
 * and IndexedDB (ArrayBuffer comparison).
 *
 * A numeric key is a non-negative integer up to 2^53 − 1 (Number.MAX_SAFE_
 * INTEGER) — a number, a bigint, or a string of digits ('2024', up to 20
 * digits). It is stored as 8 bytes and comes back from a scan as a number.
 * Larger ones cannot come back as the same number, and are refused
 * (checkKey). Negative and fractional numbers are stored as their text.
 */

var textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

var MAX_SAFE = 9007199254740991;
var MAX_SAFE_BIG = BigInt(MAX_SAFE);

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

// Why a key cannot be stored — null when it can. null (the auto-increment
// key) is the caller's business: it is refused here.
//   null / undefined-free: only null is special; other values keep their
//   old meaning (String(key)).
//   ''  and an empty Uint8Array: reserved — LevelDB keeps the table's
//   auto-increment counter under the empty key.
function checkKey(key) {
    if (key === null) return 'key is null';
    if (key instanceof Uint8Array) return key.length === 0 ? 'empty key is reserved' : null;
    if (key === '') return 'empty key is reserved';
    if (typeof key === 'bigint') {
        if (key < 0n || key > MAX_SAFE_BIG) return 'numeric key out of range 0..2^53-1';
        return null;
    }
    if (typeof key === 'number') {
        if (isNumericKey(key) && key > MAX_SAFE) return 'numeric key above 2^53-1';
        return null;
    }
    if (typeof key === 'string' && isNumericKey(key) && key.length >= 16 && Number(key) > MAX_SAFE) {
        return 'numeric key above 2^53-1';
    }
    return null;
}

// The key's value as a number when it is numeric (as stored), else −1. A
// Uint8Array of 8 bytes in the numeric range is the stored form of one.
function numericValue(key) {
    if (typeof key === 'number') return isNumericKey(key) ? key : -1;
    if (typeof key === 'string') return isNumericKey(key) ? Number(key) : -1;
    if (typeof key === 'bigint') return key >= 0n ? Number(key) : -1;
    if (key instanceof Uint8Array && key.length === 8 && key[0] === 0 && key[1] < 0x20) {
        var n = 0;
        for (var i = 1; i < 8; i++) n = n * 256 + key[i];
        return n;
    }
    return -1;
}

// The key as a scan returns it: a number when numeric, otherwise as given
// (a Uint8Array stays one). For the ids put() hands back.
function normalizeKey(key) {
    if (key instanceof Uint8Array) return key;
    if (typeof key === 'string') return isNumericKey(key) ? Number(key) : key;
    if (typeof key === 'bigint') return Number(key);
    if (typeof key === 'number') return key;
    return String(key);
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

// Stored bytes → the key: a number for 8 bytes in the numeric range,
// otherwise the UTF-8 text.
function fromKeyBuffer(buf) {
    var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (bytes.byteLength === 8 && bytes[0] === 0 && bytes[1] < 0x20) return numericValue(bytes);
    return textDecoder.decode(bytes);
}

// Order of two keys as the databases store them — byte order of their
// encoded form, the same on LevelDB and IndexedDB. −1, 0 or 1. Numeric keys
// order as numbers, and before every text key.
function compareKeys(a, b) {
    return compareBytes(toKeyBuffer(a), toKeyBuffer(b));
}

function compareBytes(x, y) {
    var n = Math.min(x.length, y.length);
    for (var i = 0; i < n; i++) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length === y.length ? 0 : (x.length < y.length ? -1 : 1);
}

// Stored bytes → a string usable as an object property, one per distinct
// key (one char per byte).
function bytesId(b) {
    if (b.length <= 4096) return String.fromCharCode.apply(null, b);
    var s = '';
    for (var i = 0; i < b.length; i += 4096) s += String.fromCharCode.apply(null, b.subarray(i, i + 4096));
    return s;
}

module.exports = {
    MAX_SAFE: MAX_SAFE,
    compareKeys: compareKeys,
    compareBytes: compareBytes,
    toKeyBuffer: toKeyBuffer,
    fromKeyBuffer: fromKeyBuffer,
    isNumericKey: isNumericKey,
    checkKey: checkKey,
    numericValue: numericValue,
    normalizeKey: normalizeKey,
    bytesId: bytesId,
    bigintToBytes: bigintToBytes,
    bytesToBigint: bytesToBigint
};
