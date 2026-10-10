// Background, peak detection and area measurement on lane profiles.
//
// This file must not be called "quant.js": content blockers treat that name as
// a tracking script (it is on the EasyPrivacy list) and silently refuse to
// load it, which left the page without WB.quant.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const num = WB.num;
  const quant = (WB.quant = {});

  // [value at the edge, slope per px] of `curve` extrapolated to one end, fitted
  // to the stretch one to two windows in from the edge, which the edge itself
  // cannot have influenced.
  function edgeTrend(curve, window, left) {
    const n = curve.length;
    const lo = Math.min(window, Math.floor(n / 2));
    const hi = Math.min(2 * window, n - 1);
    if (hi - lo < 3) return [left ? curve[0] : curve[n - 1], 0];
    const x = [];
    const y = [];
    for (let d = lo; d <= hi; d++) {
      x.push(d); // distance from the edge
      y.push(left ? curve[d] : curve[n - 1 - d]);
    }
    const fit = num.polyfit1(x, y);
    return [fit.intercept, fit.slope];
  }

  // Background as the lower envelope of the profile (1D morphological opening).
  // A window of 2 * radius + 1 px slides under the curve: a running minimum
  // removes everything narrower than the window, a running maximum restores the
  // level, a running mean rounds off the steps. Past both ends the profile is
  // continued by a straight line following the background trend found further
  // in, so that a band or a dark margin right at the edge does not bend it.
  function rollingBaseline(profile, radius) {
    const n = profile.length;
    const size = Math.max(Math.trunc(2 * radius + 1), 3);
    const smooth = num.gaussian1d(profile, 1.0, "nearest");
    const first = num.greyOpening(smooth, size);
    const pad = size;
    const [leftValue, leftSlope] = edgeTrend(first, size, true);
    const [rightValue, rightSlope] = edgeTrend(first, size, false);
    const padded = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) {
      padded[i] = leftValue - leftSlope * (pad - i);
      padded[pad + n + i] = rightValue - rightSlope * (i + 1);
    }
    padded.set(smooth, pad);
    const result = num.uniformFilter(num.greyOpening(padded, size), size);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(result[pad + i], profile[i]);
    return out;
  }

  // Automatic heights of the straight-line background: the profile's two ends.
  quant.linearEnds = function (profile) {
    const n = profile.length;
    const k = Math.max(Math.min(Math.floor(n / 20), 10), 1);
    return [num.mean(profile.slice(0, k)), num.mean(profile.slice(n - k))];
  };

  quant.computeBaseline = function (profile, baseline) {
    const n = profile.length;
    if (baseline.method === "rolling") return rollingBaseline(profile, baseline.radius);
    const out = new Float64Array(n);
    if (baseline.method === "linear") {
      const [left, right] = baseline.linear_ends || quant.linearEnds(profile);
      for (let i = 0; i < n; i++) out[i] = n > 1 ? left + ((right - left) * i) / (n - 1) : left;
    } else if (baseline.method === "manual" && baseline.anchors.length) {
      const pts = baseline.anchors.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const xp = pts.map((p) => p[0]);
      const fp = pts.map((p) => p[1]);
      for (let i = 0; i < n; i++) out[i] = num.interp(i, xp, fp);
    }
    return out;
  };

  // Sample a computed baseline into editable anchor points.
  quant.baselineToAnchors = function (curve, nAnchors = 8) {
    const n = curve.length;
    const xs = [...new Set(num.linspace(0, n - 1, Math.min(nAnchors, n)).map(num.round))];
    return xs.map((i) => [i, curve[i]]);
  };

  function corrected(profile, baseline, smooth) {
    const diff = new Float64Array(profile.length);
    for (let i = 0; i < diff.length; i++) diff[i] = profile[i] - baseline[i];
    return num.gaussian1d(diff, smooth, "nearest");
  }

  const makePeak = (start, end, apex) => ({ start, end, apex, band_id: 0, quantify: true });

  // Find bands in a profile. `prominence` is a fraction of the corrected
  // profile's range. Borders are put where the signal drops to `edgeFrac` of the
  // peak height, or at the valley towards the neighbouring peak.
  quant.detectPeaks = function (profile, baseline, options = {}) {
    const { prominence = 0.05, smooth = 1.5, minWidth = 3, edgeFrac = 0.03 } = options;
    const y = corrected(profile, baseline, smooth);
    const span = num.max(y) - num.min(y);
    if (span <= 0) return [];
    const idx = num.findPeaks(y, { prominence: prominence * span, width: minWidth }).peaks;
    return idx.map((apex, k) => {
      const thr = edgeFrac * y[apex];
      const lo = k > 0 ? idx[k - 1] : 0;
      const hi = k + 1 < idx.length ? idx[k + 1] : y.length - 1;
      let start = -1;
      for (let i = apex; i >= lo; i--) {
        if (y[i] <= thr) {
          start = i;
          break;
        }
      }
      if (start < 0) start = num.argmin(y, lo, apex + 1);
      let end = -1;
      for (let i = apex; i <= hi; i++) {
        if (y[i] <= thr) {
          end = i;
          break;
        }
      }
      if (end < 0) end = num.argmin(y, apex, hi + 1);
      return makePeak(start, end, apex);
    });
  };

  // The peak under `position`, with borders where it meets the background. The
  // apex is the highest point within `search` px. Each border moves outwards
  // until the signal has dropped to `edgeFrac` of the peak height, or to the
  // valley before a neighbouring peak. `limits` keeps the borders inside an
  // interval. null if there is no signal above the background.
  quant.peakAt = function (profile, baseline, position, options = {}) {
    const { search = 8, smooth = 1.5, edgeFrac = 0.03, riseFrac = 0.1, limits = null } = options;
    const y = corrected(profile, baseline, smooth);
    const n = y.length;
    let lo = limits ? Math.ceil(limits[0]) : 0;
    let hi = limits ? Math.floor(limits[1]) : n - 1;
    lo = Math.max(lo, 0);
    hi = Math.min(hi, n - 1);
    const a = num.clip(num.round(position - search), lo, hi);
    const b = num.clip(num.round(position + search), lo, hi);
    if (b <= a) return null;
    const apex = num.argmax(y, a, b + 1);
    const height = y[apex];
    if (height <= 0) return null;
    const border = (step) => {
      let i = apex;
      let lowest = apex;
      while (lo <= i + step && i + step <= hi) {
        i += step;
        if (y[i] < y[lowest]) lowest = i;
        if (y[i] <= edgeFrac * height) return i;
        if (y[i] - y[lowest] > riseFrac * height) return lowest;
      }
      return lowest;
    };
    const start = border(-1);
    const end = border(1);
    return end <= start ? null : makePeak(start, end, apex);
  };

  // Integer sample range [a, b] that a peak covers.
  quant.peakBounds = function (peak, n) {
    const a = num.clip(num.round(Math.min(peak.start, peak.end)), 0, n - 1);
    const b = num.clip(num.round(Math.max(peak.start, peak.end)), 0, n - 1);
    return [a, b];
  };

  // Baseline-subtracted area between the peak borders (trapezoid rule).
  quant.peakArea = function (profile, baseline, peak) {
    const [a, b] = quant.peakBounds(peak, profile.length);
    if (b <= a) return 0;
    let area = 0;
    for (let i = a; i < b; i++)
      area += 0.5 * (profile[i] - baseline[i] + profile[i + 1] - baseline[i + 1]);
    return area;
  };

  // Number the peaks of a lane 1, 2, 3, ... from the top of the lane.
  quant.numberPeaks = function (lane) {
    lane.peaks.sort((p, q) => p.apex - q.apex);
    lane.peaks.forEach((p, k) => (p.band_id = k + 1));
  };

  // True if the lane's peak numbers are still the automatic 1, 2, 3, ...
  quant.isNumberedInOrder = function (lane) {
    const ordered = lane.peaks.slice().sort((p, q) => p.apex - q.apex);
    return ordered.every((p, k) => p.band_id === k + 1);
  };

  // { bands, rows }: one row per lane with the area of each quantified band.
  quant.resultsTable = function (laneList, profiles, baselines) {
    const bands = [
      ...new Set(laneList.flatMap((l) => l.peaks.filter((p) => p.quantify).map((p) => p.band_id))),
    ].sort((a, b) => a - b);
    const rows = laneList.map((lane, i) => {
      const row = new Array(bands.length).fill(null);
      for (const p of lane.peaks) {
        if (!p.quantify) continue;
        const j = bands.indexOf(p.band_id);
        row[j] = (row[j] || 0) + quant.peakArea(profiles[i], baselines[i], p);
      }
      return row;
    });
    return { bands, rows };
  };

  // The rows of a results table with every band divided by its largest area
  // among the lanes, so that each column runs up to 1. A band without an area
  // above zero in any lane has nothing to be compared with and is left empty.
  quant.normalizeRows = function (rows) {
    const width = rows.length ? rows[0].length : 0;
    const top = Array.from({ length: width }, (_, j) =>
      Math.max(...rows.map((row) => (row[j] === null ? -Infinity : row[j]))));
    return rows.map((row) => row.map((v, j) => (v === null || !(top[j] > 0) ? null : v / top[j])));
  };

  // The table as text. Without `headers` it is the numbers only: no title row
  // and no column of lane numbers.
  quant.tableToCsv = function (bands, rows, sep = ",", headers = true) {
    const lines = headers ? [["Lane", ...bands.map((b) => `Peak ${b}`)].join(sep)] : [];
    rows.forEach((row, i) => {
      const values = row.map((v) => (v === null ? "" : num.formatG(v)));
      lines.push((headers ? [i + 1, ...values] : values).join(sep));
    });
    return lines.join("\n") + "\n";
  };
})();
