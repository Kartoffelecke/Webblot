// Lane geometry, auto-detection and profile extraction.
// Coordinates are (y, x) in pixels of the working image, pixel centres at
// integers. A lane is a rectangle around its centre, optionally tilted about it.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const num = WB.num;
  const lanes = (WB.lanes = {});

  // the lanes are assumed to fill at least this fraction of the search area
  const MIN_FILL = 0.85;

  lanes.length = (lane) => lane.y1 - lane.y0;
  lanes.yCenter = (lane) => 0.5 * (lane.y0 + lane.y1);

  // unit vectors [y, x] along and across the lane
  function axes(tiltDeg) {
    const t = (tiltDeg * Math.PI) / 180;
    return { u: [Math.cos(t), Math.sin(t)], v: [-Math.sin(t), Math.cos(t)] };
  }

  // [y, x] of a point `pos` px along and `across` px off the centre line
  lanes.point = function (lane, pos, across = 0) {
    const { u, v } = axes(lane.tilt_deg);
    const t = pos - 0.5 * lanes.length(lane);
    return [
      lanes.yCenter(lane) + t * u[0] + across * v[0],
      lane.x_center + t * u[1] + across * v[1],
    ];
  };

  // four [y, x] corners: top-left, top-right, bottom-right, bottom-left
  lanes.polygon = function (lane) {
    const len = lanes.length(lane);
    const hw = 0.5 * lane.width;
    return [
      lanes.point(lane, 0, -hw),
      lanes.point(lane, 0, hw),
      lanes.point(lane, len, hw),
      lanes.point(lane, len, -hw),
    ];
  };

  // x of the lane centre line at image row y (follows tilt)
  lanes.xAt = (lane, y) =>
    lane.x_center + (y - lanes.yCenter(lane)) * Math.tan((lane.tilt_deg * Math.PI) / 180);

  // image y of a position along the lane (on the centre line)
  lanes.profileToImageY = function (lane, pos) {
    const { u } = axes(lane.tilt_deg);
    return lanes.yCenter(lane) + (pos - 0.5 * lanes.length(lane)) * u[0];
  };

  // position along the lane at image row y (on the centre line); the inverse of profileToImageY
  lanes.positionAtImageY = function (lane, y) {
    const { u } = axes(lane.tilt_deg);
    return (y - lanes.yCenter(lane)) / u[0] + 0.5 * lanes.length(lane);
  };

  // bilinear sample with coordinates clamped to the image
  function sample(img, y, x) {
    const { w, h, data } = img;
    y = num.clip(y, 0, h - 1);
    x = num.clip(x, 0, w - 1);
    const y0 = Math.min(Math.floor(y), Math.max(h - 2, 0));
    const x0 = Math.min(Math.floor(x), Math.max(w - 2, 0));
    const y1 = Math.min(y0 + 1, h - 1);
    const x1 = Math.min(x0 + 1, w - 1);
    const fy = y - y0;
    const fx = x - x0;
    return (
      (1 - fy) * ((1 - fx) * data[y0 * w + x0] + fx * data[y0 * w + x1]) +
      fy * ((1 - fx) * data[y1 * w + x0] + fx * data[y1 * w + x1])
    );
  }

  // The lane as a stack of m lines along it, one per pixel across its width:
  // data[j * n + i] is line j (from the lane's left edge) at position i.
  // `across[j]` is the line's distance from the centre line.
  lanes.extractStrip = function (img, lane) {
    const n = Math.max(Math.round(lanes.length(lane)), 1);
    const m = Math.max(Math.round(lane.width), 1);
    const { u, v } = axes(lane.tilt_deg);
    const yc = lanes.yCenter(lane);
    const data = new Float64Array(n * m);
    const across = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const a = (across[j] = j + 0.5 - 0.5 * m);
      for (let i = 0; i < n; i++) {
        const t = i + 0.5 - 0.5 * n;
        data[j * n + i] = sample(img, yc + t * u[0] + a * v[0], lane.x_center + t * u[1] + a * v[1]);
      }
    }
    return { n, m, data, across };
  };

  // Mean intensity across the lane width for every pixel step along the lane.
  lanes.stripProfile = function (strip) {
    const { n, m, data } = strip;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += data[j * n + i];
      out[i] = s / m;
    }
    return out;
  };

  lanes.extractProfile = (img, lane) => lanes.stripProfile(lanes.extractStrip(img, lane));

  const evenCenters = (width, n) => Array.from({ length: n }, (_, i) => ((i + 0.5) * width) / n);

  // Centres of the n-lane regular grid that best matches the projection. The
  // grid may shrink and shift a little, but must still span most of the width:
  // otherwise it collapses onto the brightest part of an uneven blot.
  function gridFit(profile, n) {
    const w = profile.length;
    const base = num.min(profile);
    const cum = Array.from(profile, (v) => v - base);
    let best = null;
    let bestScore = -Infinity;
    for (let p = 0; p < 20; p++) {
      const pitch = ((MIN_FILL + ((1 - MIN_FILL) * p) / 19) * w) / n;
      const span = pitch * (n - 1);
      const step = Math.max(pitch / 20, 1);
      const count = Math.ceil((w - span - pitch + 1) / step);
      for (let k = 0; k < count; k++) {
        const offset = pitch / 2 + k * step;
        let score = 0;
        const centers = [];
        for (let i = 0; i < n; i++) {
          centers.push(offset + pitch * i);
          score += num.interpIndex(centers[i], cum);
        }
        // signal on the lanes minus signal in the gaps between them: this
        // rewards matching the lane pattern, not just sitting on bright areas
        let gaps = 0;
        for (let i = 0; i <= n; i++) gaps += num.interpIndex(offset - pitch / 2 + pitch * i, cum);
        score -= (gaps * n) / (n + 1);
        if (score > bestScore) {
          best = centers;
          bestScore = score;
        }
      }
    }
    return best || evenCenters(w, n);
  }

  const makeLane = (x, y0, y1, width) => ({
    x_center: x,
    y0,
    y1,
    width,
    tilt_deg: 0,
    baseline: WB.model.baseline(),
    peaks: [],
  });

  // Place lanes inside `roi` [y0, x0, y1, x1]; they span its full height.
  // method "signal" looks for lanes in the column projection of `signal` (bands
  // bright). With `nLanes` the result always has exactly that many lanes; if the
  // peaks do not give that number, a regular grid is fitted instead.
  // method "even" ignores the image and divides the area into equal lanes.
  lanes.detect = function (signal, options = {}) {
    const { nLanes = null, roi = null, widthFrac = 0.8, method = "signal" } = options;
    const { w, h, data } = signal;
    let y0 = 0;
    let x0 = 0;
    let y1 = h;
    let x1 = w;
    if (roi) {
      y0 = Math.max(Math.round(roi[0]), 0);
      x0 = Math.max(Math.round(roi[1]), 0);
      y1 = Math.min(Math.round(roi[2]), h);
      x1 = Math.min(Math.round(roi[3]), w);
    }
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return [];
    if (method === "even") {
      if (!nLanes) throw new Error("Evenly spaced lanes need the number of lanes.");
      const pitch = rw / nLanes;
      return evenCenters(rw, nLanes).map((c) =>
        makeLane(x0 + c - 0.5, y0 - 0.5, y1 - 0.5, Math.max(widthFrac * pitch, 2))
      );
    }
    // background-corrected column projection
    let proj = new Float64Array(rw);
    const column = new Float64Array(rh);
    for (let x = 0; x < rw; x++) {
      let s = 0;
      for (let y = 0; y < rh; y++) {
        column[y] = data[(y0 + y) * w + x0 + x];
        s += column[y];
      }
      proj[x] = s / rh - num.median(column);
    }
    const guess = nLanes || 12;
    proj = num.gaussian1d(proj, Math.max(rw / (guess * 8), 1.5), "reflect");
    const span = num.max(proj) - num.min(proj);

    let centers = [];
    if (span > 0) {
      const found = num.findPeaks(proj, {
        prominence: 0.08 * span,
        distance: Math.max(rw / (guess * 2.5), 3),
      });
      let idx = found.peaks;
      if (nLanes && idx.length > nLanes) {
        const order = idx
          .map((_, i) => i)
          .sort((a, b) => found.prominences[b] - found.prominences[a])
          .slice(0, nLanes);
        idx = order.map((i) => idx[i]).sort((a, b) => a - b);
      }
      centers = idx;
    }

    if (nLanes && centers.length > 1) {
      // peaks bunched in one part of the area are bands or smears, not the lanes
      const spacing = centers.slice(1).map((c, i) => c - centers[i]);
      const pitch = num.median(spacing);
      const regular = num.max(spacing) < 1.35 * pitch && num.min(spacing) > 0.65 * pitch;
      const fills =
        centers[centers.length - 1] - centers[0] >= (MIN_FILL * rw * (nLanes - 1)) / nLanes;
      if (!(regular && fills)) centers = [];
    }
    if (nLanes && centers.length !== nLanes) centers = gridFit(proj, nLanes);
    if (!centers.length) return [];

    let pitch;
    if (centers.length > 1) pitch = num.median(centers.slice(1).map((c, i) => c - centers[i]));
    else pitch = rw / Math.max(nLanes || 1, 2);
    const width = Math.max(widthFrac * pitch, 2);
    return centers.map((c) => makeLane(x0 + c, y0 - 0.5, y1 - 0.5, width));
  };

  // Spread tilt linearly from -max on the leftmost lane to +max on the rightmost.
  lanes.applySmile = function (list, maxTiltDeg) {
    if (!list.length) return;
    const xs = list.map((l) => l.x_center);
    const lo = num.min(xs);
    const hi = num.max(xs);
    for (const lane of list) {
      const f = hi === lo ? 0 : (2 * (lane.x_center - lo)) / (hi - lo) - 1;
      lane.tilt_deg = f * maxTiltDeg;
    }
  };
})();
