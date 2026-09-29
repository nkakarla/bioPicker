// BioPicker — minimal zip writer/reader for project backups (no dependencies). Copyright (c) 2026 ePerf
import zlib from "node:zlib";

const DOS_EPOCH = (d) => {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
};
// already-compressed formats are stored as-is; everything else is deflated
const STORE_EXT = /\.(jpe?g|png|gif|webp|heic|mp4|m4v|mov|webm|mp3|m4a|aac|ogg|opus|zip|pdf)$/i;

/** entries: [{ name, data: Buffer, mtime?: Date }] -> Buffer (zip archive) */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const raw = e.data;
    const crc = zlib.crc32(raw) >>> 0;
    let method = 0;
    let body = raw;
    if (!STORE_EXT.test(e.name) && raw.length > 64) {
      const d = zlib.deflateRawSync(raw, { level: 6 });
      if (d.length < raw.length) (method = 8), (body = d);
    }
    const { time, date } = DOS_EPOCH(e.mtime || new Date());
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // utf-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
    if (offset > 0xffffffff) throw new Error("Backup is larger than 4 GB; too big for a zip without Zip64.");
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Buffer (zip archive) -> [{ name, data }] ; reads via the central directory */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw Object.assign(new Error("Not a zip file"), { status: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error("Corrupt zip file"), { status: 400 });
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw Object.assign(new Error(`Unsupported zip compression in ${name}`), { status: 400 });
    if ((zlib.crc32(data) >>> 0) !== crc) throw Object.assign(new Error(`Damaged file in backup: ${name}`), { status: 400 });
    out.push({ name, data });
  }
  return out;
}
