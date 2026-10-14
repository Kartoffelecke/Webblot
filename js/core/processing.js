// Geometric preparation of a blot image. The raw image is never modified.
// An image is { w, h, data: Float32Array } in row order.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const num = WB.num;
  const processing = (WB.processing = {});

  processing.image = (w, h, data) => ({ w, h, data: data || new Float32Array(w * h) });

  // k quarter turns counter-clockwise
  function rot90(img, k) {
    k = ((k % 4) + 4) % 4;
    let cur = img;
    for (let t = 0; t < k; t++) {
      const { w, h, data } = cur;
      const out = processing.image(h, w);
      for (let i = 0; i < w; i++)
        for (let j = 0; j < h; j++) out.data[i * h + j] = data[j * w + (w - 1 - i)];
      cur = out;
    }
    return cur;
  }

  // How a w x h image lies in its rotated picture: the picture's size, and the
  // numbers that take a point of the picture to the point of the image it shows:
  // [c * y + s * x + offY, -s * y + c * x + offX].
  function frame(w, h, angleDeg) {
    const rad = (((angleDeg % 360) + 360) % 360) * (Math.PI / 180);
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    // bounds of the rotated input plane
    const ys = [0, s * w, c * h, c * h + s * w];
    const xs = [0, c * w, -s * h, -s * h + c * w];
    const oh = Math.floor(num.max(ys) - num.min(ys) + 0.5);
    const ow = Math.floor(num.max(xs) - num.min(xs) + 0.5);
    const cy = (oh - 1) / 2;
    const cx = (ow - 1) / 2;
    return { c, s, ow, oh, offY: (h - 1) / 2 - (c * cy + s * cx), offX: (w - 1) / 2 - (-s * cy + c * cx) };
  }

  // { w, h } of a w x h image rotated by an angle
  processing.rotatedSize = function (w, h, angleDeg) {
    const f = frame(w, h, angleDeg);
    return { w: f.ow, h: f.oh };
  };

  // The point [y, x] of a w x h image that a point of its rotated picture shows, and back.
  processing.fromRotated = function (w, h, angleDeg, [y, x]) {
    const f = frame(w, h, angleDeg);
    return [f.c * y + f.s * x + f.offY, -f.s * y + f.c * x + f.offX];
  };

  processing.toRotated = function (w, h, angleDeg, [y, x]) {
    const f = frame(w, h, angleDeg);
    return [f.c * (y - f.offY) - f.s * (x - f.offX), f.s * (y - f.offY) + f.c * (x - f.offX)];
  };

  // Rotate with canvas expansion and bilinear interpolation; corners are
  // filled with the median.
  processing.rotate = function (img, angleDeg) {
    const angle = ((angleDeg % 360) + 360) % 360;
    if (angle === 0) return img;
    if (angle % 90 === 0) return rot90(img, angle / 90);
    const { w, h, data } = img;
    const { c, s, ow, oh, offY, offX } = frame(w, h, angle);
    const fill = num.median(data);
    const out = processing.image(ow, oh);
    for (let oy = 0; oy < oh; oy++) {
      for (let ox = 0; ox < ow; ox++) {
        const iy = c * oy + s * ox + offY;
        const ix = -s * oy + c * ox + offX;
        let v = fill;
        if (iy >= 0 && iy <= h - 1 && ix >= 0 && ix <= w - 1) {
          const y0 = Math.min(Math.floor(iy), h - 2 < 0 ? 0 : h - 2);
          const x0 = Math.min(Math.floor(ix), w - 2 < 0 ? 0 : w - 2);
          const fy = iy - y0;
          const fx = ix - x0;
          const y1 = Math.min(y0 + 1, h - 1);
          const x1 = Math.min(x0 + 1, w - 1);
          v =
            (1 - fy) * ((1 - fx) * data[y0 * w + x0] + fx * data[y0 * w + x1]) +
            fy * ((1 - fx) * data[y1 * w + x0] + fx * data[y1 * w + x1]);
        }
        out.data[oy * ow + ox] = v;
      }
    }
    return out;
  };

  // Extra rotation (degrees) that makes the line start -> end straight.
  // Points are [y, x]. The line is turned to whichever is nearer, horizontal or
  // vertical, so it can follow a band or the edge of a lane.
  processing.levelingAngle = function (start, end) {
    const angle = (Math.atan2(end[0] - start[0], end[1] - start[1]) * 180) / Math.PI;
    return ((((angle + 45) % 90) + 90) % 90) - 45;
  };

  // Round a [y0, x0, y1, x1] box and clip it to the image; null if empty.
  processing.clipCrop = function (crop, w, h) {
    let [y0, x0, y1, x1] = crop.map(Math.round);
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (x0 > x1) [x0, x1] = [x1, x0];
    y0 = Math.max(y0, 0);
    x0 = Math.max(x0, 0);
    y1 = Math.min(y1, h);
    x1 = Math.min(x1, w);
    if (y1 - y0 < 2 || x1 - x0 < 2) return null;
    return [y0, x0, y1, x1];
  };

  processing.crop = function (img, box) {
    const [y0, x0, y1, x1] = box;
    const out = processing.image(x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++)
      out.data.set(img.data.subarray(y * img.w + x0, y * img.w + x1), (y - y0) * out.w);
    return out;
  };

  // Rotate, then crop.
  processing.applyTransform = function (img, transform) {
    let out = processing.rotate(img, transform.rotation_deg);
    if (transform.crop) {
      const box = processing.clipCrop(transform.crop, out.w, out.h);
      if (box) out = processing.crop(out, box);
    }
    return out;
  };

  // Bilinear resize (used when a brightfield image differs in size from its blot).
  processing.resize = function (img, w, h) {
    const out = processing.image(w, h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(Math.max(((y + 0.5) * img.h) / h - 0.5, 0), img.h - 1);
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, img.h - 1);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(Math.max(((x + 0.5) * img.w) / w - 0.5, 0), img.w - 1);
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, img.w - 1);
        const fy = sy - y0;
        const fx = sx - x0;
        out.data[y * w + x] =
          (1 - fy) * ((1 - fx) * img.data[y0 * img.w + x0] + fx * img.data[y0 * img.w + x1]) +
          fy * ((1 - fx) * img.data[y1 * img.w + x0] + fx * img.data[y1 * img.w + x1]);
      }
    }
    return out;
  };

  processing.autoContrast = function (img, low = 0.5, high = 99.8) {
    let [lo, hi] = num.percentiles(img.data, [low, high]);
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  };

  // Image in which bands are always brighter than background.
  processing.signalImage = function (img, bandsDark) {
    if (!bandsDark) return img;
    const top = num.max(img.data);
    const out = processing.image(img.w, img.h);
    for (let i = 0; i < out.data.length; i++) out.data[i] = top - img.data[i];
    return out;
  };

  // 8-bit grey levels of a blot as it is shown, merged with its brightfield
  // image if `bf` is given. `t` is the blot's transform (exposure of both
  // images, polarity). The brightfield is shown with the same polarity as the
  // blot: bright marker bands next to bright blot bands, or dark next to dark.
  processing.compose = function (wb, bf, t) {
    const [lo, hi] = t.contrast_limits || processing.autoContrast(wb);
    const gray = processing.toGray8(wb, lo, hi, t.gamma, t.invert_lut);
    if (!bf) return gray;
    const shownDark = t.bands_dark !== t.invert_lut; // bands appear dark
    // a brightfield image has dark marker bands unless "Invert" says otherwise
    const bfDark = shownDark !== t.bf_invert;
    const [bfLo, bfHi] = t.bf_contrast_limits || processing.autoContrast(bf, 0.5, 99.5);
    const under = processing.toGray8(bf, bfLo, bfHi, t.bf_gamma, !bfDark);
    // dark on light: the darker one wins; bright on dark: they add up
    for (let i = 0; i < gray.length; i++)
      gray[i] = shownDark ? Math.min(gray[i], under[i]) : gray[i] + under[i]; // clamped at 255
    return gray;
  };

  // 8-bit grey levels for display: contrast limits, gamma, optional inversion.
  processing.toGray8 = function (img, lo, hi, gamma = 1, invert = false) {
    const out = new Uint8ClampedArray(img.data.length);
    const span = hi - lo || 1;
    for (let i = 0; i < out.length; i++) {
      let t = (img.data[i] - lo) / span;
      t = t <= 0 ? 0 : t >= 1 ? 1 : gamma === 1 ? t : Math.pow(t, gamma);
      // matplotlib's 256-level grey map: floor(t * 256), top level clamped
      const level = Math.min(Math.floor(t * 256), 255);
      out[i] = invert ? 255 - level : level;
    }
    return out;
  };
})();
