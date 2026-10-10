// Reading image files into { w, h, data: Float32Array } greyscale images, and
// packing images into project files.
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

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // The name an image goes by in a saved project. An image is never modified
  // once it has been read, so the key it gets here stays its key.
  imageio.key = function (img) {
    if (!img.key) img.key = WB.model.newId();
    return img.key;
  };

  // Image as stored in the browser: { w, h, dtype, buffer }. Whole-number
  // images up to 16 bits (every file an imager writes) take two bytes per
  // pixel, anything else four.
  imageio.toBinary = function (img) {
    let integer = true;
    for (let i = 0; i < img.data.length && integer; i++) {
      const v = img.data[i];
      integer = v >= 0 && v <= 65535 && Math.floor(v) === v;
    }
    const typed = integer ? Uint16Array.from(img.data) : Float32Array.from(img.data);
    return { w: img.w, h: img.h, dtype: integer ? "uint16" : "float32", buffer: typed.buffer };
  };

  imageio.fromBinary = function (binary) {
    const data =
      binary.dtype === "uint16"
        ? Float32Array.from(new Uint16Array(binary.buffer))
        : new Float32Array(binary.buffer.slice(0));
    if (data.length !== binary.w * binary.h) throw new Error("The stored image is damaged.");
    return { w: binary.w, h: binary.h, data };
  };

  // The stored form as a JSON-friendly object for project files, and back.
  imageio.binaryToPacked = (binary) =>
    ({ w: binary.w, h: binary.h, dtype: binary.dtype, data: toBase64(new Uint8Array(binary.buffer)) });

  imageio.packedToBinary = function (packed) {
    const bytes = fromBase64(packed.data);
    if (bytes.length !== packed.w * packed.h * (packed.dtype === "uint16" ? 2 : 4))
      throw new Error("The stored image is damaged.");
    return { w: packed.w, h: packed.h, dtype: packed.dtype, buffer: bytes.buffer };
  };

  imageio.pack = (img) => imageio.binaryToPacked(imageio.toBinary(img));
  imageio.unpack = (packed) => imageio.fromBinary(imageio.packedToBinary(packed));
})();
