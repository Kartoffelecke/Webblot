// Reading image files into { w, h, data: Float32Array } greyscale images.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const imageio = (WB.imageio = {});

  // First page of a TIFF: 8- or 16-bit, grey or RGB (channels are averaged).
  imageio.decodeTiff = function (buffer) {
    const ifds = UTIF.decode(buffer);
    const ifd = ifds.find((d) => d.t256 && d.t257) || ifds[0];
    if (!ifd) throw new Error("No image found in the TIFF file.");
    UTIF.decodeImage(buffer, ifd);
    const w = ifd.width;
    const h = ifd.height;
    const bits = ifd.t258 ? ifd.t258[0] : 8;
    const channels = ifd.t277 ? ifd.t277[0] : 1;
    const bytes = ifd.data;
    if (bits !== 8 && bits !== 16) throw new Error(`${bits}-bit TIFF files are not supported.`);
    if ((ifd.t284 ? ifd.t284[0] : 1) !== 1) throw new Error("Planar TIFF files are not supported.");
    const step = bits / 8;
    if (bytes.length < w * h * channels * step) throw new Error("The TIFF file is incomplete.");
    const value =
      bits === 8 ? (i) => bytes[i] : (i) => bytes[2 * i] | (bytes[2 * i + 1] << 8); // little endian
    const used = Math.min(channels, 3);
    const data = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (channels === 1) data[p] = value(p);
      else {
        let s = 0;
        for (let c = 0; c < used; c++) s += value(p * channels + c);
        data[p] = s / used;
      }
    }
    return { w, h, data };
  };

  // The image as a TIFF file: one strip of 16-bit grey values, not compressed.
  // This is the one format images are kept in, whatever they were read from.
  // Values are rounded to whole numbers and kept within 0 to 65535.
  imageio.encodeTiff = function (img) {
    const n = img.w * img.h;
    const TAGS = 11;
    const start = 8 + 2 + TAGS * 12 + 4; // header, directory, then the pixels
    const out = new Uint8Array(start + 2 * n);
    const view = new DataView(out.buffer);
    out.set([0x49, 0x49, 42, 0]); // "II": little endian
    view.setUint32(4, 8, true);
    view.setUint16(8, TAGS, true);
    let at = 10;
    const tag = (id, type, value) => {
      view.setUint16(at, id, true);
      view.setUint16(at + 2, type, true); // 3: 16-bit, 4: 32-bit
      view.setUint32(at + 4, 1, true);
      if (type === 3) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
      at += 12;
    };
    tag(256, 4, img.w); // width
    tag(257, 4, img.h); // height
    tag(258, 3, 16); // bits per sample
    tag(259, 3, 1); // no compression
    tag(262, 3, 1); // black is zero
    tag(273, 4, start); // where the strip is
    tag(277, 3, 1); // one sample per pixel
    tag(278, 4, img.h); // rows in the strip
    tag(279, 4, 2 * n); // bytes in the strip
    tag(284, 3, 1); // chunky
    tag(339, 3, 1); // unsigned whole numbers
    const pixels = new Uint16Array(n);
    for (let i = 0; i < n; i++) pixels[i] = Math.min(Math.max(Math.round(img.data[i]), 0), 65535);
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) out.set(new Uint8Array(pixels.buffer), start);
    else for (let i = 0; i < n; i++) view.setUint16(start + 2 * i, pixels[i], true);
    return out;
  };

  // PNG, JPEG, ... through the browser's own decoder (8 bits per channel).
  imageio.decodeBitmap = async function (blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const data = new Float32Array(canvas.width * canvas.height);
    for (let p = 0; p < data.length; p++)
      data[p] = (rgba[4 * p] + rgba[4 * p + 1] + rgba[4 * p + 2]) / 3;
    return { w: canvas.width, h: canvas.height, data };
  };

  imageio.readFile = async function (file) {
    if (/\.tiff?$/i.test(file.name)) return imageio.decodeTiff(await file.arrayBuffer());
    return imageio.decodeBitmap(file);
  };

  // The name an image goes by, to tell whether it has been written. An image
  // is never modified once it has been read, so the key it gets here stays its key.
  imageio.key = function (img) {
    if (!img.key) img.key = WB.model.newId();
    return img.key;
  };
})();
