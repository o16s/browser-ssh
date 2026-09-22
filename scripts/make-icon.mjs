// Draws the 512x512 application icon and writes it as a PNG.
//
// The script has no dependencies. It builds the PNG chunks itself, because a
// picture library is not worth one icon.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SIZE = 512;
const BACKGROUND = [11, 13, 18, 255]; // the --bg colour of the application
const INK = [79, 156, 249, 255]; // the --accent colour

// One RGBA pixel for each point of the picture.
const pixels = new Uint8Array(SIZE * SIZE * 4);

function put(x, y, colour) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
    return;
  }
  const at = (y * SIZE + x) * 4;
  pixels.set(colour, at);
}

function fillRect(x0, y0, w, h, colour) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      put(x, y, colour);
    }
  }
}

// A line of the given thickness between two points.
function line(x0, y0, x1, y1, thickness, colour) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const half = Math.floor(thickness / 2);
  for (let i = 0; i <= steps; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    fillRect(x - half, y - half, thickness, thickness, colour);
  }
}

fillRect(0, 0, SIZE, SIZE, BACKGROUND);

// The shell prompt sign ">" and the cursor "_", the two marks of a terminal.
const T = 26;
line(170, 170, 268, 256, T, INK);
line(268, 256, 170, 342, T, INK);
fillRect(296, 326, 150, T, INK);

// The PNG format needs one filter byte in front of each row.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter 0: no filter
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(
    raw,
    y * (SIZE * 4 + 1) + 1,
  );
}

// CRC-32, as the PNG format defines it.
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // 8 bits for each colour
header[9] = 6; // colour type 6: RGBA
header[10] = 0; // deflate
header[11] = 0; // the only filter method
header[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2];
if (!out) {
  console.error('Give the output path as the first argument.');
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
