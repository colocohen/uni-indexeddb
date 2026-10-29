/**
 * binary.js — the .udb file format of export / import / exportAll / restore
 *
 * v2 (written):
 *   Header:  "UDB" 0x02
 *   0x02 table   [varint name_len] [name UTF-8] [varint autoinc]
 *   0x01 record  [varint key_len]  [key bytes]  [varint val_len] [val bytes]
 *   0x03 end     [varint count] [CRC32, 4 bytes big-endian]
 *   0x04 eof     [varint tables]
 *
 *   A file is: header, then for each table its 0x02 frame, its records and
 *   its 0x03 frame, then one 0x04 frame. The key is the bytes as stored, so
 *   every key comes back exactly (a number stays a number, binary keys stay
 *   binary). CRC32 covers the table's record frames, byte for byte; count
 *   is how many there are. A file cut anywhere — inside a table or between
 *   two — lacks its 0x04 frame: TRUNCATED.
 *
 * v1 (still read):
 *   Header:  "UDB" 0x01
 *   Record:  [varint key_len] [key UTF-8 text] [varint val_len] [val bytes]
 *   ...to the end of the file. One table without a name, no checksum.
 *
 * Varint: unsigned LEB128 (as protobuf), up to 2^53.
 *
 * Errors are thrown as { code, message }: INVALID (not a .udb file, or a
 * frame out of place), CHECKSUM (count or CRC32 of a table do not match),
 * TRUNCATED (the file ends early — from finish()).
 */

var _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var _dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

var MAGIC = [0x55, 0x44, 0x42];
var HEADER = new Uint8Array([0x55, 0x44, 0x42, 0x02]);

var F_RECORD = 0x01, F_TABLE = 0x02, F_END = 0x03, F_EOF = 0x04;

// =========================================================================
// CRC32 (IEEE)
// =========================================================================

var CRC_TABLE = (function() {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

// crc: the running value (start with 0); returns the next one.
function crc32(crc, buf, start, end) {
    var c = (crc ^ 0xFFFFFFFF) >>> 0;
    for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// =========================================================================
// Varint — arithmetic, so that it holds 53 bits
// =========================================================================

function varintSize(n) {
    var size = 1;
    while (n > 0x7F) { size++; n = Math.floor(n / 128); }
    return size;
}

function writeVarint(buf, pos, n) {
    while (n > 0x7F) {
        buf[pos++] = (n % 128) | 0x80;
        n = Math.floor(n / 128);
    }
    buf[pos++] = n;
    return pos;
}

// [n, nextPos], null when the buffer ends inside it. Throws on more than
// 8 bytes (past 2^56 — not a varint this format writes).
function readVarint(buf, pos) {
    var n = 0, mul = 1, b, i = 0;
    do {
        if (pos >= buf.length) return null;
        if (++i > 8) throw fail('INVALID', 'varint too long');
        b = buf[pos++];
        n += (b & 0x7F) * mul;
        mul *= 128;
    } while (b & 0x80);
    return [n, pos];
}

function fail(code, message) {
    return { code: code, message: message };
}

function concat(parts, total) {
    if (parts.length === 1) return parts[0];
    if (total === undefined) { total = 0; for (var i = 0; i < parts.length; i++) total += parts[i].length; }
    var out = new Uint8Array(total), pos = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], pos); pos += parts[j].length; }
    return out;
}

// =========================================================================
// Encoder — writes a v2 file piece by piece
// =========================================================================

function createEncoder() {
    var crc = 0, count = 0, tables = 0;

    return {
        header: function() { return HEADER.slice(); },

        table: function(name, autoinc) {
            crc = 0; count = 0; tables++;
            var nb = _enc.encode(name);
            var buf = new Uint8Array(1 + varintSize(nb.length) + nb.length + varintSize(autoinc));
            buf[0] = F_TABLE;
            var pos = writeVarint(buf, 1, nb.length);
            buf.set(nb, pos); pos += nb.length;
            writeVarint(buf, pos, autoinc);
            return buf;
        },

        // rows: [[keyBytes, valueBytes], ...]
        records: function(rows) {
            var size = 0;
            for (var i = 0; i < rows.length; i++) {
                var kl = rows[i][0].length, vl = rows[i][1].length;
                size += 1 + varintSize(kl) + kl + varintSize(vl) + vl;
            }
            var buf = new Uint8Array(size), pos = 0;
            for (var j = 0; j < rows.length; j++) {
                buf[pos++] = F_RECORD;
                pos = writeVarint(buf, pos, rows[j][0].length);
                buf.set(rows[j][0], pos); pos += rows[j][0].length;
                pos = writeVarint(buf, pos, rows[j][1].length);
                buf.set(rows[j][1], pos); pos += rows[j][1].length;
            }
            crc = crc32(crc, buf, 0, buf.length);
            count += rows.length;
            return buf;
        },

        endTable: function() {
            var buf = new Uint8Array(1 + varintSize(count) + 4);
            buf[0] = F_END;
            var pos = writeVarint(buf, 1, count);
            buf[pos] = crc >>> 24; buf[pos + 1] = (crc >>> 16) & 0xFF;
            buf[pos + 2] = (crc >>> 8) & 0xFF; buf[pos + 3] = crc & 0xFF;
            return buf;
        },

        endFile: function() {
            var buf = new Uint8Array(1 + varintSize(tables));
            buf[0] = F_EOF;
            writeVarint(buf, 1, tables);
            return buf;
        }
    };
}

// =========================================================================
// Parser — streaming decoder of v1 and v2
// =========================================================================
//
// parse(chunk) → events, in file order:
//   { t: 'table', name, autoinc }   name null for a v1 file
//   { t: 'row', key, value }        key: Uint8Array (v2) or string (v1);
//                                   both are views into the chunks given
//   { t: 'end', name, count }       the table's count and CRC32 checked
//   { t: 'eof', tables }
// finish() → the events still owed (v1: its end and eof), or throws
// TRUNCATED when the file stopped early.
//
// A frame cut between two chunks waits for the next — kept as a list of
// pieces, joined once it is whole (a large value arriving in many chunks is
// not copied again with each one).

function createParser() {
    var version = 0;
    var pending = [], pendingLen = 0, need = 0;
    var inTable = false, tableName = null, crc = 0, count = 0;
    var tablesSeen = 0, sawEof = false;

    function parse(chunk) {
        var events = [];
        if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
        if (chunk.length === 0) return events;
        pending.push(chunk); pendingLen += chunk.length;
        if (pendingLen < need) return events;
        var buf = concat(pending, pendingLen);
        pending = []; pendingLen = 0; need = 0;

        var pos = 0;
        if (version === 0) {
            if (buf.length < 4) return keep(buf, 0, 4, events);
            if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] || buf[2] !== MAGIC[2]) throw fail('INVALID', 'not a .udb file');
            version = buf[3];
            if (version !== 1 && version !== 2) throw fail('INVALID', 'unknown .udb version ' + version);
            pos = 4;
            if (version === 1) { inTable = true; events.push({ t: 'table', name: null, autoinc: 0 }); }
        }

        while (pos < buf.length) {
            var start = pos;
            if (version === 1) {
                var r = readRecord(buf, pos, false);
                if (r === null) return keep(buf, start, 0, events);
                if (typeof r === 'number') return keep(buf, start, r, events);
                events.push({ t: 'row', key: _dec.decode(r[0]), value: r[1] });
                pos = r[2];
                continue;
            }

            if (sawEof) throw fail('INVALID', 'data after the end of the file');
            var type = buf[pos];

            if (type === F_RECORD) {
                if (!inTable) throw fail('INVALID', 'record outside a table');
                var rec = readRecord(buf, pos + 1, true);
                if (rec === null) return keep(buf, start, 0, events);
                if (typeof rec === 'number') return keep(buf, start, rec + 1, events);
                crc = crc32(crc, buf, start, rec[2]);
                count++;
                events.push({ t: 'row', key: rec[0], value: rec[1] });
                pos = rec[2];
            } else if (type === F_TABLE) {
                if (inTable) throw fail('INVALID', 'table started inside a table');
                var nl = readVarint(buf, pos + 1);
                if (!nl) return keep(buf, start, 0, events);
                if (nl[1] + nl[0] > buf.length) return keep(buf, start, nl[1] + nl[0] - start + 1, events);
                var name = _dec.decode(buf.subarray(nl[1], nl[1] + nl[0]));
                var ai = readVarint(buf, nl[1] + nl[0]);
                if (!ai) return keep(buf, start, 0, events);
                inTable = true; tableName = name; crc = 0; count = 0; tablesSeen++;
                events.push({ t: 'table', name: name, autoinc: ai[0] });
                pos = ai[1];
            } else if (type === F_END) {
                if (!inTable) throw fail('INVALID', 'table end outside a table');
                var cn = readVarint(buf, pos + 1);
                if (!cn) return keep(buf, start, 0, events);
                if (cn[1] + 4 > buf.length) return keep(buf, start, cn[1] + 4 - start, events);
                var fileCrc = ((buf[cn[1]] << 24) | (buf[cn[1] + 1] << 16) | (buf[cn[1] + 2] << 8) | buf[cn[1] + 3]) >>> 0;
                if (cn[0] !== count) throw fail('CHECKSUM', 'table ' + JSON.stringify(tableName) + ': ' + count + ' records, the file says ' + cn[0]);
                if (fileCrc !== crc) throw fail('CHECKSUM', 'table ' + JSON.stringify(tableName) + ': CRC32 does not match');
                inTable = false;
                events.push({ t: 'end', name: tableName, count: count });
                pos = cn[1] + 4;
            } else if (type === F_EOF) {
                if (inTable) throw fail('INVALID', 'end of file inside a table');
                var tn = readVarint(buf, pos + 1);
                if (!tn) return keep(buf, start, 0, events);
                if (tn[0] !== tablesSeen) throw fail('CHECKSUM', tablesSeen + ' tables, the file says ' + tn[0]);
                sawEof = true;
                events.push({ t: 'eof', tables: tablesSeen });
                pos = tn[1];
            } else {
                throw fail('INVALID', 'unknown frame 0x' + type.toString(16));
            }
        }
        return events;
    }

    // The rest of buf, from start, waits for more. min: bytes it must reach
    // before it is worth parsing again (0: any more).
    function keep(buf, start, min, events) {
        var rest = buf.subarray(start);
        pending = [rest]; pendingLen = rest.length;
        need = min > rest.length ? min : rest.length + 1;
        return events;
    }

    function finish() {
        if (version === 0) throw fail(pendingLen ? 'TRUNCATED' : 'INVALID', pendingLen ? 'file ends inside its header' : 'empty file');
        if (pendingLen) throw fail('TRUNCATED', 'file ends inside a frame');
        if (version === 1) {
            if (!inTable) return [];
            inTable = false; sawEof = true;
            return [{ t: 'end', name: null, count: -1 }, { t: 'eof', tables: 1 }];
        }
        if (!sawEof) throw fail('TRUNCATED', inTable ? 'file ends inside table ' + JSON.stringify(tableName) : 'file ends before its end frame');
        return [];
    }

    return { parse: parse, finish: finish };
}

// [key, value, nextPos]; null when the buffer ends inside a length; a
// number — the bytes (from pos) the record needs — when inside its data.
function readRecord(buf, pos, rawKey) {
    var r1 = readVarint(buf, pos);
    if (!r1) return null;
    var kEnd = r1[1] + r1[0];
    if (kEnd > buf.length) return kEnd - pos + 1;
    var r2 = readVarint(buf, kEnd);
    if (!r2) return null;
    var vEnd = r2[1] + r2[0];
    if (vEnd > buf.length) return vEnd - pos;
    return [buf.subarray(r1[1], kEnd), buf.subarray(r2[1], vEnd), vEnd];
}

module.exports = {
    HEADER: HEADER,
    createEncoder: createEncoder,
    createParser: createParser,
    concat: concat,
    crc32: crc32
};
