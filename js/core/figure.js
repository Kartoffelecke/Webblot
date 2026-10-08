// Builds the figure as SVG: one panel per blot, stacked, with lane labels and
// side markers. All lengths are in points (1/72 inch); the gel of every panel
// is drawn at the same width, so panels showing the same lanes line up.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { num, processing, lanes } = WB;
  const figure = (WB.figure = {});

  const MM = 72 / 25.4; // points per millimetre
  const FONT = "Arial, Helvetica, sans-serif";
  const DESCENT = 0.22; // of the font size, below the baseline
  const ASCENT = 0.78;

  const escape = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const f = (v) => Number(v.toFixed(3));

  let measureContext = null;
  function textWidth(text, fontSize) {
    if (!measureContext) measureContext = document.createElement("canvas").getContext("2d");
    measureContext.font = `${fontSize}px ${FONT}`;
    return measureContext.measureText(text).width;
  }

  // Collects SVG elements and the box they occupy.
  class Canvas {
    constructor() {
      this.items = [];
      this.box = [Infinity, Infinity, -Infinity, -Infinity]; // x0, y0, x1, y1
    }
    grow(x0, y0, x1, y1) {
      const b = this.box;
      this.box = [Math.min(b[0], x0, x1), Math.min(b[1], y0, y1), Math.max(b[2], x0, x1), Math.max(b[3], y0, y1)];
    }
    line(x1, y1, x2, y2, width) {
      this.items.push(
        `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#000" stroke-width="${width}" stroke-linecap="square"/>`
      );
      this.grow(x1, y1, x2, y2);
    }
    // `y` is the bottom of the text (valign "bottom") or its middle ("center")
    text(x, y, string, { size, anchor = "middle", valign = "bottom", rotate = 0, cls = "" }) {
      const width = textWidth(string, size);
      const baseline = valign === "bottom" ? -DESCENT * size : (ASCENT - DESCENT) * 0.5 * size;
      const ax = anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0;
      // corners of the text box before rotation, relative to the anchor point
      const corners = [
        [ax, baseline - ASCENT * size],
        [ax + width, baseline - ASCENT * size],
        [ax, baseline + DESCENT * size],
        [ax + width, baseline + DESCENT * size],
      ];
      const r = (-rotate * Math.PI) / 180; // screen y points down
      for (const [cx, cy] of corners) {
        const px = x + cx * Math.cos(r) - cy * Math.sin(r);
        const py = y + cx * Math.sin(r) + cy * Math.cos(r);
        this.grow(px, py, px, py);
      }
      const turn = rotate ? ` transform="rotate(${-rotate} ${f(x)} ${f(y)})"` : "";
      this.items.push(
        `<text x="${f(x)}" y="${f(y + baseline)}" font-size="${size}" text-anchor="${anchor}"${turn}${cls ? ` class="${cls}"` : ""}>${escape(string)}</text>`
      );
    }
  }

  // [y0, x0, y1, x1] pixel indices of the part of the image shown in the figure
  figure.cropBox = function (session, img) {
    if (session.figure.crop) {
      // shape corners are pixel-edge coordinates; +0.5 converts to slice indices
      const box = processing.clipCrop(session.figure.crop.map((v) => v + 0.5), img.w, img.h);
      if (box) return box;
    }
    return [0, 0, img.h, img.w];
  };

  // Indices of the lanes that run through the figure crop. Only the horizontal
  // position counts: the crop is usually a strip around one band.
  figure.lanesInFigure = function (session, img) {
    const [y0, x0, , x1] = figure.cropBox(session, img);
    return session.lanes
      .map((lane, i) => [lanes.xAt(lane, y0 - 0.5), i])
      .filter(([x]) => x >= x0 - 0.5 && x <= x1 - 0.5)
      .map(([, i]) => i);
  };

  // Resolution (dpi) at which one image pixel is one output pixel.
  figure.nativeDpi = function (session, img, style) {
    const [, x0, , x1] = figure.cropBox(session, img);
    return (x1 - x0) / (style.gel_width_mm / 25.4);
  };

  // merge equal neighbours: [first, last, text]
  function spans(values) {
    const out = [];
    values.forEach((v, i) => {
      const last = out[out.length - 1];
      if (last && last[2] === v && last[1] === i - 1) last[1] = i;
      else out.push([i, i, v]);
    });
    return out;
  }
  figure.spans = spans;

  // Geometry of one panel: where its pixels go on the page.
  function geometry(panel, style, top) {
    const [y0, x0, y1, x1] = figure.cropBox(panel.session, panel.image);
    const width = style.gel_width_mm * MM;
    const scale = width / (x1 - x0); // points per image pixel
    return {
      box: [y0, x0, y1, x1],
      width,
      height: (y1 - y0) * scale,
      top,
      scale,
      x: (px) => (px - (x0 - 0.5)) * scale,
      y: (py) => top + (py - (y0 - 0.5)) * scale,
    };
  }

  function laneLabels(canvas, panel, style, g) {
    const { session, image } = panel;
    const rows = session.figure.label_rows;
    const idx = figure.lanesInFigure(session, image);
    if (!idx.length || !rows.length) return;
    const fs = style.font_size;
    const yTop = g.box[0] - 0.5;
    const picked = idx.map((i) => session.lanes[i]);
    const xs = picked.map((lane) => g.x(lanes.xAt(lane, yTop)));
    const valuesOf = (row) => idx.map((i) => (i < row.values.length ? row.values[i] : ""));

    if (style.label_style === "table") {
      // boxed cells sitting on the gel, aligned with the lanes
      const gelLeft = 0;
      const gelRight = g.width;
      const firstPitch = xs.length > 1 ? xs[1] - xs[0] : 1.25 * picked[0].width * g.scale;
      const lastPitch = xs.length > 1 ? xs[xs.length - 1] - xs[xs.length - 2] : firstPitch;
      let left = xs[0] - 0.5 * firstPitch;
      let right = xs[xs.length - 1] + 0.5 * lastPitch;
      if (left < gelLeft || left - gelLeft < 0.15 * firstPitch) left = gelLeft;
      if (right > gelRight || gelRight - right < 0.15 * lastPitch) right = gelRight;
      const edges = [left, ...xs.slice(1).map((x, i) => 0.5 * (x + xs[i])), right];
      const h = 1.7 * fs;
      const pad = 0.5 * fs;
      const lw = style.line_width;
      const rowCenter = (r) => g.top - (rows.length - r - 0.5) * h;
      const titled = rows.map((row, r) => [r, row.title]).filter(([, title]) => title);
      let outerLeft = left;
      if (titled.length) {
        const widest = Math.max(...titled.map(([, title]) => textWidth(title, fs)));
        outerLeft = left - widest - 2 * pad;
        for (const [r, title] of titled)
          canvas.text(outerLeft + pad, rowCenter(r), title, { size: fs, anchor: "start", valign: "center", cls: "row-title" });
      }
      rows.forEach((row, r) => {
        const values = valuesOf(row);
        const cells = row.collapse ? spans(values) : values.map((v, i) => [i, i, v]);
        const yBottom = g.top - (rows.length - 1 - r) * h;
        for (const [a, b, value] of cells) {
          if (value) canvas.text(0.5 * (edges[a] + edges[b + 1]), rowCenter(r), value, { size: fs, valign: "center", cls: "lane-label" });
          if (b + 1 < values.length) canvas.line(edges[b + 1], yBottom, edges[b + 1], yBottom - h, lw);
        }
        canvas.line(outerLeft, yBottom - h, right, yBottom - h, lw);
      });
      const tableTop = g.top - rows.length * h;
      canvas.line(right, g.top, right, tableTop, lw);
      canvas.line(left, g.top, left, tableTop, lw);
      if (titled.length) {
        canvas.line(outerLeft, g.top, outerLeft, tableTop, lw);
        canvas.line(outerLeft, g.top, left, g.top, lw);
      }
      return;
    }

    const half = 0.5 * num.median(picked.map((lane) => lane.width)) * g.scale;
    let offset = 0.5 * fs; // above the gel border
    // rows are listed top to bottom, so stack them from the last one upwards
    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r];
      const values = valuesOf(row);
      const isSpan = !!row.collapse;
      const textOffset = offset + (isSpan ? 0.45 * fs : 0);
      const y = g.top - textOffset;
      if (isSpan) {
        for (const [a, b, value] of spans(values)) {
          if (!value) continue;
          const lineY = g.top - (offset + 0.1 * fs);
          canvas.line(xs[a] - 0.9 * half, lineY, xs[b] + 0.9 * half, lineY, style.line_width);
          canvas.text(0.5 * (xs[a] + xs[b]), y, value, { size: fs, cls: "lane-label" });
        }
      } else {
        const rot = r === 0 ? style.label_rotation : 0;
        values.forEach((value, k) => {
          if (!value) return;
          // rotated text starts at the anchor, or it would reach down into the gel
          canvas.text(xs[k], y, value, {
            size: fs,
            anchor: rot === 0 ? "middle" : "start",
            valign: rot === 90 ? "center" : "bottom",
            rotate: rot,
            cls: "lane-label",
          });
        });
      }
      if (row.title) canvas.text(-0.6 * fs, y, row.title, { size: fs, anchor: "end", cls: "row-title" });
      offset += (isSpan ? 1.9 : 1.35) * fs;
    }
  }

  // Tick plus text outside the gel for every marker inside the crop. `header`
  // (the MW unit) is written once above the topmost label; with `blockedAbove`
  // it goes below the lowest label when it would not fit under the gel's top.
  function markers(canvas, list, side, style, g, { suffix = "", header = "", blockedAbove = false, cls }) {
    const fs = style.font_size;
    const [y0, , y1] = g.box;
    const inside = list.filter((m) => m.y >= y0 - 0.5 && m.y <= y1 - 0.5);
    if (!inside.length) return;
    const left = side === "left";
    const edge = left ? 0 : g.width;
    const sign = left ? -1 : 1;
    const tick = 0.5 * fs;
    const textX = edge + sign * (tick + 0.3 * fs);
    const anchor = left ? "end" : "start";
    if (header) {
      const gap = 1.4 * fs;
      const ys = inside.map((m) => g.y(m.y));
      const first = Math.min(...ys);
      const above = !blockedAbove || first - g.top >= gap + 0.6 * fs;
      canvas.text(textX, above ? first - gap : Math.max(...ys) + gap, header, { size: fs, anchor, valign: "center", cls: "mw-unit" });
    }
    for (const m of inside) {
      const y = g.y(m.y);
      const label = m.text ? `${m.text}${suffix}` : "";
      if (label) canvas.text(textX, y, label, { size: fs, anchor, valign: "center", cls });
      canvas.line(edge, y, edge + sign * tick, y, style.line_width);
    }
  }

  // The crop as a canvas of its own pixels, with the blot's exposure settings applied.
  figure.cropCanvas = function (panel, box) {
    const [y0, x0, y1, x1] = box;
    const t = panel.session.transform;
    const limits = t.contrast_limits || processing.autoContrast(panel.image);
    // with `panel.bf`, the brightfield is merged in exactly as on the blot's card
    const gray = processing.compose(
      processing.crop(panel.image, box),
      panel.bf ? processing.crop(panel.bf, box) : null,
      { ...t, contrast_limits: limits }
    );
    const canvas = document.createElement("canvas");
    canvas.width = x1 - x0;
    canvas.height = y1 - y0;
    const data = new ImageData(canvas.width, canvas.height);
    for (let i = 0; i < gray.length; i++) {
      data.data[4 * i] = data.data[4 * i + 1] = data.data[4 * i + 2] = gray[i];
      data.data[4 * i + 3] = 255;
    }
    canvas.getContext("2d").putImageData(data, 0, 0);
    return canvas;
  };

  function drawPanel(canvas, panel, style, top, withImage = true) {
    const g = geometry(panel, style, top);
    const fig = panel.session.figure;
    if (withImage) {
      // the pixels are embedded as they are and scaled by the viewer, never resampled
      g.pixels = figure.cropCanvas(panel, g.box);
      canvas.items.push(
        `<image x="0" y="${f(g.top)}" width="${f(g.width)}" height="${f(g.height)}" preserveAspectRatio="none" image-rendering="pixelated" style="image-rendering:pixelated" href="${g.pixels.toDataURL("image/png")}"/>`
      );
      canvas.items.push(
        `<rect class="gel-border" x="0" y="${f(g.top)}" width="${f(g.width)}" height="${f(g.height)}" fill="none" stroke="#000" stroke-width="${style.line_width}"/>`
      );
    }
    canvas.grow(0, g.top, g.width, g.top + g.height);
    if (panel.showLabels) laneLabels(canvas, panel, style, g);
    const unitOnTop = style.mw_unit_position === "top";
    markers(canvas, fig.mw_markers, fig.mw_side, style, g, {
      suffix: unitOnTop ? "" : style.mw_unit,
      header: unitOnTop ? style.mw_unit.trim() : "",
      // row titles sit above the gel's left corner
      blockedAbove: panel.showLabels && fig.mw_side === "left" && fig.label_rows.some((r) => r.title),
      cls: "mw-label",
    });
    markers(canvas, fig.band_markers, fig.band_side, style, g, { cls: "band-label" });
    return g;
  }

  // How far a panel's lane labels reach above its gel, in points.
  function labelHeight(panel, style) {
    if (!panel.showLabels || !panel.session.figure.label_rows.length) return 0;
    const probe = new Canvas();
    laneLabels(probe, panel, style, geometry(panel, style, 0));
    return probe.box[1] === Infinity ? 0 : Math.max(-probe.box[1], 0);
  }

  // Build the figure. `panels` is a list of { session, image, showLabels, bf },
  // top to bottom; `bf` is an optional brightfield image to merge into the gel. Returns { svg, width, height } (points), `gels` (where each gel
  // lies, in points from the top-left corner) and `nativeDpi`.
  figure.build = function (panels, style) {
    const canvas = new Canvas();
    const gels = [];
    let top = 0;
    panels.forEach((panel, i) => {
      if (i > 0) top += style.gap_mm * MM + labelHeight(panel, style);
      const g = drawPanel(canvas, panel, style, top);
      gels.push(g);
      top += g.height;
    });
    const pad = 1.5;
    const [x0, y0, x1, y1] = canvas.box;
    const width = x1 - x0 + 2 * pad;
    const height = y1 - y0 + 2 * pad;
    const nativeDpi = panels.length
      ? Math.max(...panels.map((p) => figure.nativeDpi(p.session, p.image, style)))
      : 72;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${f(width)}pt" height="${f(height)}pt" ` +
      `viewBox="${f(x0 - pad)} ${f(y0 - pad)} ${f(width)} ${f(height)}" font-family="${FONT}">` +
      canvas.items.join("") +
      "</svg>";
    return {
      svg,
      width,
      height,
      nativeDpi,
      gels: gels.map((g) => ({
        x: -(x0 - pad),
        y: g.top - (y0 - pad),
        width: g.width,
        height: g.height,
        box: g.box,
        pixels: g.pixels,
      })),
    };
  };

  // Rasterise a built figure. Resolves to a PNG blob.
  //
  // The gels are copied onto the bitmap directly, each starting on a whole
  // pixel, and only the lines and text are drawn from the SVG. At the native
  // dpi the finest panel therefore comes out pixel for pixel; drawing the whole
  // SVG instead would resample it wherever a gel starts between two pixels.
  figure.toPng = function (built, dpi) {
    const scale = dpi / 72;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(built.width * scale);
    canvas.height = Math.round(built.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const placed = built.gels.map((gel) => ({
      x: Math.round(gel.x * scale),
      y: Math.round(gel.y * scale),
      width: Math.round(gel.width * scale),
      height: Math.round(gel.height * scale),
    }));
    built.gels.forEach((gel, i) =>
      ctx.drawImage(gel.pixels, placed[i].x, placed[i].y, placed[i].width, placed[i].height));
    // shift the drawing by the fraction of a pixel that the first gel was moved
    const dx = placed.length ? placed[0].x - built.gels[0].x * scale : 0;
    const dy = placed.length ? placed[0].y - built.gels[0].y * scale : 0;
    const overlay = built.svg.replace(/<image [^>]*\/>/g, "");
    const url = URL.createObjectURL(new Blob([overlay], { type: "image/svg+xml" }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, dx, dy, built.width * scale, built.height * scale);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => resolve(Object.assign(blob, { gels: placed })), "image/png");
      };
      img.onerror = () => reject(new Error("The figure could not be drawn."));
      img.src = url;
    });
  };
})();
