#!/usr/bin/env node
// Builds the Chrome Web Store upload: agent-connector-<version>.zip at the repository root.
//
//   node scripts/pack-extension.mjs [--key path/to/key.pem] [--out file.zip]
//
// The zip holds what the extension runs and its LICENSE and PRIVACY.md; the notes for
// maintainers (STORE.md, REVIEW.md, PROTOCOL.md, README.md) stay out. The manifest goes
// without "key": the store refuses it. With --key, key.pem goes in the zip's root, so the
// first upload keeps the unpacked id (extension/STORE.md, "The extension id").
// No dependency: the zip is written here (deflate from node:zlib, CRC-32 below).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension");
const LEFT_OUT = new Set(["STORE.md", "REVIEW.md", "PROTOCOL.md", "README.md"]);

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** Every file of the extension folder, as zip paths with "/". */
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(relative(src, p).split(sep).join("/"));
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of [path, bytes] entries, deflated, with fixed times so the same input gives the same zip. */
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const [path, data] of entries) {
    const name = Buffer.from(path, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBytes, end]);
}

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
const { key: _key, ...uploaded } = manifest;
const entries = [];
for (const path of files(src)) {
  if (LEFT_OUT.has(path)) continue;
  entries.push([path, path === "manifest.json" ? Buffer.from(`${JSON.stringify(uploaded, null, 2)}\n`) : readFileSync(join(src, path))]);
}
const keyFile = arg("--key");
if (keyFile) entries.push(["key.pem", readFileSync(keyFile)]);

const out = resolve(arg("--out") ?? join(root, `agent-connector-${manifest.version}.zip`));
writeFileSync(out, zip(entries));
console.log(`${out}: ${entries.length} files${keyFile ? ", with key.pem (first upload)" : ", without key.pem"}`);
for (const [path] of entries) console.log(`  ${path}`);
