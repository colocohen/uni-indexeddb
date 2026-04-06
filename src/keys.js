/**
 * keys.js — Binary key encoding for uni-indexeddb
 *
 * Numbers → 8-byte big-endian Uint8Array (correct sort order)
 * Strings → UTF-8 encoded Uint8Array
 * Uint8Array → passed through
 *
 * This ensures identical ordering on LevelDB (byte comparison)
 * and IndexedDB (ArrayBuffer comparison).
 */

var textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

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

module.exports = {
    toKeyBuffer: toKeyBuffer,
    fromKeyBuffer: fromKeyBuffer,
    isNumericKey: isNumericKey,
    bigintToBytes: bigintToBytes,
    bytesToBigint: bytesToBigint
};
