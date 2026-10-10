// Writing and reading zip files, for the library file: a zip of project files.
// Entries are compressed with pako. Files above 4 GB (zip64) are not handled.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const zip = (WB.zip = {});

  const LOCAL = 0x04034b50;
  const CENTRAL = 0x02014b50;
  const END = 0x06054b50;
  const LIMIT = 0xffffffff;

  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }

  zip.crc32 = function (bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  // A header of `size` bytes, filled by `write(view)`; all numbers little endian.
  function record(size, write) {
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    return bytes;
  }

  // A zip file as a Blob. `entries`: [{ name, data: Uint8Array | string }].
  zip.write = function (entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
      const packed = pako.deflateRaw(data);
      const crc = zip.crc32(data);
      // what the local header and the directory both say about the entry
      const common = (view, at) => {
        view.setUint16(at, 20, true); // version needed
        view.setUint16(at + 2, 0x0800, true); // names are UTF-8
        view.setUint16(at + 4, 8, true); // deflate
        view.setUint16(at + 6, time, true);
        view.setUint16(at + 8, date, true);
        view.setUint32(at + 10, crc, true);
        view.setUint32(at + 14, packed.length, true);
        view.setUint32(at + 18, data.length, true);
        view.setUint16(at + 22, name.length, true);
      };
      const start = offset;
      parts.push(record(30, (view) => {
        view.setUint32(0, LOCAL, true);
        common(view, 4);
      }), name, packed);
      offset += 30 + name.length + packed.length;
      directory.push(record(46, (view) => {
        view.setUint32(0, CENTRAL, true);
        view.setUint16(4, 20, true); // version made by
        common(view, 6);
        view.setUint32(42, start, true);
      }), name);
      if (data.length >= LIMIT || offset >= LIMIT || entries.length >= 0xffff)
        throw new Error("This is more than a zip file of 4 GB can hold.");
    }
    const size = directory.reduce((sum, part) => sum + part.length, 0);
    const end = record(22, (view) => {
      view.setUint32(0, END, true);
      view.setUint16(8, entries.length, true);
      view.setUint16(10, entries.length, true);
      view.setUint32(12, size, true);
      view.setUint32(16, offset, true);
    });
    return new Blob([...parts, ...directory, end], { type: "application/zip" });
  };

  // The entries of a zip file: [{ name, data: Uint8Array }].
  zip.read = function (buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== END) end--;
    if (end < 0) throw new Error("This is not a zip file.");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    if (count === 0xffff || at === LIMIT) throw new Error("Zip files above 4 GB are not supported.");
    const decoder = new TextDecoder();
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) throw new Error("The zip file is damaged.");
      const method = view.getUint16(at + 10, true);
      const crc = view.getUint32(at + 16, true);
      const packedSize = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      if (name.endsWith("/")) continue; // a folder
      if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL) throw new Error("The zip file is damaged.");
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const packed = bytes.subarray(start, start + packedSize);
      if (method !== 0 && method !== 8) throw new Error(`'${name}' is compressed in a way that is not supported.`);
      const data = method === 8 ? pako.inflateRaw(packed) : packed.slice();
      if (zip.crc32(data) !== crc) throw new Error(`'${name}' in the zip file is damaged.`);
      entries.push({ name, data });
    }
    return entries;
  };
})();
