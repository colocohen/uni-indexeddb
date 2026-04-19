/**
 * binary.js — Binary format for uni-indexeddb export/import
 *
 * Format:
 *   Header:  [0x55 0x44 0x42] "UDB" + [0x01] version
 *   Record:  [varint key_len] [key UTF-8] [varint val_len] [val bytes]
 *   ...repeat until end of buffer
 *
 * Varint: unsigned LEB128 (same as protobuf)
 *   0–127        → 1 byte
 *   128–16383    → 2 bytes
 *   16384–2M     → 3 bytes
 *   up to 268MB  → 4 bytes
 */

var _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var _dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

var HEADER = new Uint8Array([0x55, 0x44, 0x42, 0x01]);

// =========================================================================
// Varint
// =========================================================================

function varintSize(n) {
    if (n < 0) n = 0;
    var size = 1;
    while (n > 0x7F) { size++; n >>>= 7; }
    return size;
}

function writeVarint(buf, pos, n) {
    while (n > 0x7F) {
        buf[pos++] = (n & 0x7F) | 0x80;
        n >>>= 7;
    }
    buf[pos++] = n;
    return pos;
}

function readVarint(buf, pos) {
    var n = 0, shift = 0, b;
    do {
        if (pos >= buf.length) return null;
        b = buf[pos++];
        n |= (b & 0x7F) << shift;
        shift += 7;
    } while (b & 0x80);
    return [n, pos];
}

// =========================================================================
// Encode — rows [[key, value], ...] → Uint8Array
// =========================================================================

function encodeChunk(rows, includeHeader) {
    var encodedKeys = new Array(rows.length);
    var size = includeHeader ? HEADER.length : 0;

    for (var i = 0; i < rows.length; i++) {
        encodedKeys[i] = _enc.encode(String(rows[i][0]));
        var valLen = rows[i][1].length;
        size += varintSize(encodedKeys[i].length) + encodedKeys[i].length
              + varintSize(valLen) + valLen;
    }

    var buf = new Uint8Array(size);
    var pos = 0;

    if (includeHeader) {
        buf.set(HEADER, 0);
        pos = HEADER.length;
    }

    for (var i = 0; i < rows.length; i++) {
        pos = writeVarint(buf, pos, encodedKeys[i].length);
        buf.set(encodedKeys[i], pos); pos += encodedKeys[i].length;
        pos = writeVarint(buf, pos, rows[i][1].length);
        buf.set(rows[i][1], pos); pos += rows[i][1].length;
    }

    return buf;
}

// =========================================================================
// Parser — streaming decoder, handles partial chunks
// =========================================================================

function createParser() {
    var remainder = null;
    var headerChecked = false;

    return {
        parse: function(chunk) {
            var buf;
            if (remainder) {
                buf = new Uint8Array(remainder.length + chunk.length);
                buf.set(remainder);
                buf.set(chunk, remainder.length);
                remainder = null;
            } else {
                buf = chunk;
            }

            var pos = 0;
            var records = [];

            if (!headerChecked) {
                if (buf.length < 4) { remainder = buf; return records; }
                if (buf[0] !== 0x55 || buf[1] !== 0x44 || buf[2] !== 0x42) {
                    throw new Error('Invalid UDB format');
                }
                // buf[3] = version (currently 1)
                pos = 4;
                headerChecked = true;
            }

            while (pos < buf.length) {
                var saved = pos;

                var r1 = readVarint(buf, pos);
                if (!r1) { remainder = buf.slice(saved); return records; }
                var keyLen = r1[0]; pos = r1[1];

                if (pos + keyLen > buf.length) { remainder = buf.slice(saved); return records; }
                var key = _dec.decode(buf.slice(pos, pos + keyLen));
                pos += keyLen;

                var r2 = readVarint(buf, pos);
                if (!r2) { remainder = buf.slice(saved); return records; }
                var valLen = r2[0]; pos = r2[1];

                if (pos + valLen > buf.length) { remainder = buf.slice(saved); return records; }
                var value = buf.slice(pos, pos + valLen);
                pos += valLen;

                records.push([key, value]);
            }

            return records;
        }
    };
}

module.exports = {
    HEADER: HEADER,
    encodeChunk: encodeChunk,
    createParser: createParser
};
