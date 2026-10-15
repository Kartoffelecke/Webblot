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

  // Valley to valley, as the lines drawn in Fiji's gel analyzer: under each
  // peak the background is the straight line from the profile at one border to
  // the profile at the other, and the area measured is what the profile
  // encloses above that line. Where the profile dips below the line there is
  // nothing enclosed, so the background follows the profile there, as it does
  // outside the peaks.
  function valleyBaseline(profile, peaks) {
    const out = Float64Array.from(profile);
    for (const peak of peaks) {
      const [a, b] = quant.peakBounds(peak, profile.length);
      for (let i = a + 1; i < b; i++)
        out[i] = Math.min(profile[i], profile[a] + ((profile[b] - profile[a]) * (i - a)) / (b - a));
    }
    return out;
  }

  // The background of a profile. `peaks` are the lane's peaks; only the
  // valley-to-valley background depends on them.
  quant.computeBaseline = function (profile, baseline, peaks = []) {
    const n = profile.length;
    if (baseline.method === "rolling") return rollingBaseline(profile, baseline.radius);
    if (baseline.method === "valley") return valleyBaseline(profile, peaks);
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

  // The background that peaks are looked for on. Valley to valley has none
  // before there are peaks, so the rolling ball stands in for it.
  quant.searchBaseline = (profile, baseline) =>
    baseline.method === "valley" ? rollingBaseline(profile, baseline.radius) : quant.computeBaseline(profile, baseline);

  // Sample a computed baseline into editable anchor points.
  quant.baselineToAnchors = function (curve, nAnchors = 8) {
    const n = curve.length;
    const k = Math.min(nAnchors, n);
    const xs = [...new Set(Array.from({ length: k }, (_, i) => (k === 1 ? 0 : Math.round(((n - 1) * i) / (k - 1)))))];
    return xs.map((i) => [i, curve[i]]);
  };

  // Anchor points for a valley-to-valley background: the two ends of the
  // profile and the two borders of every peak, so that the lines between the
  // anchors are the lines under the peaks.
  quant.valleyAnchors = function (curve, peaks) {
    const n = curve.length;
    const xs = new Set([0, n - 1]);
    for (const peak of peaks) for (const i of quant.peakBounds(peak, n)) xs.add(i);
    return [...xs].sort((a, b) => a - b).map((i) => [i, curve[i]]);
  };

  function corrected(profile, baseline, smooth) {
    const diff = new Float64Array(profile.length);
    for (let i = 0; i < diff.length; i++) diff[i] = profile[i] - baseline[i];
    return num.gaussian1d(diff, smooth, "nearest");
  }

  const makePeak = (start, end, apex) => ({ start, end, apex, band_id: 0, quantify: true });

  // Where a peak ends on one side: outwards from the apex (`step` -1 or 1) to
  // the point where its flank has flattened, that is where the signal falls at
  // no more than a tenth of the flank's steepest slope. That is the foot of the
  // peak, and also the dip towards a neighbouring hump. Tails and haze beyond
  // it are left out, which a border at a fraction of the peak's height is not
  // able to do. Not further than `limit`, and not up another peak: if the
  // signal climbs above the apex (the apex was taken on a flank), the border is
  // the lowest point before that.
  const FLAT = 0.1;
  function flankEnd(y, apex, step, limit) {
    let steepest = 0;
    let lowest = apex;
    for (let i = apex + step; step < 0 ? i > limit : i < limit; i += step) {
      if (y[i] > y[apex]) return lowest;
      if (y[i] < y[lowest]) lowest = i;
      const fall = (y[i - step] - y[i + step]) / 2; // per px, going outwards
      if (fall > steepest) steepest = fall;
      else if (steepest > 0 && fall <= FLAT * steepest) return i;
    }
    return limit;
  }

  // Find bands in a profile. `prominence` is a fraction of the corrected
  // profile's range. Each border is put where the flank has flattened, and not
  // beyond the valley towards the neighbouring peak.
  quant.detectPeaks = function (profile, baseline, options = {}) {
    const { prominence = 0.05, smooth = 1.5, minWidth = 3 } = options;
    const y = corrected(profile, baseline, smooth);
    const span = num.max(y) - num.min(y);
    if (span <= 0) return [];
    const idx = num.findPeaks(y, { prominence: prominence * span, width: minWidth }).peaks;
    return idx.map((apex, k) => {
      const lo = k > 0 ? num.argmin(y, idx[k - 1], apex + 1) : 0;
      const hi = k + 1 < idx.length ? num.argmin(y, apex, idx[k + 1] + 1) : y.length - 1;
      return makePeak(Math.min(flankEnd(y, apex, -1, lo), apex - 1), Math.max(flankEnd(y, apex, 1, hi), apex + 1), apex);
    });
  };

  // The peak under `position`, with borders where its flanks have flattened.
  // The apex is the highest point within `search` px. `limits` keeps the
  // borders inside an interval. null if there is no signal above the
  // background.
  quant.peakAt = function (profile, baseline, position, options = {}) {
    const { search = 8, smooth = 1.5, limits = null } = options;
    const y = corrected(profile, baseline, smooth);
    const n = y.length;
    let lo = limits ? Math.ceil(limits[0]) : 0;
    let hi = limits ? Math.floor(limits[1]) : n - 1;
    lo = Math.max(lo, 0);
    hi = Math.min(hi, n - 1);
    const a = num.clip(Math.round(position - search), lo, hi);
    const b = num.clip(Math.round(position + search), lo, hi);
    if (b <= a) return null;
    const apex = num.argmax(y, a, b + 1);
    if (y[apex] <= 0) return null;
    const start = flankEnd(y, apex, -1, lo);
    const end = flankEnd(y, apex, 1, hi);
    return end <= start ? null : makePeak(start, end, apex);
  };

  // Integer sample range [a, b] that a peak covers.
  quant.peakBounds = function (peak, n) {
    const a = num.clip(Math.round(Math.min(peak.start, peak.end)), 0, n - 1);
    const b = num.clip(Math.round(Math.max(peak.start, peak.end)), 0, n - 1);
    return [a, b];
  };

  // A border may be tilted against the line straight across the lane
  // (`start_tilt_deg`, `end_tilt_deg`; missing is 0). `peak.start` and
  // `peak.end` are where the borders cross the lane's centre line; `across`
  // px off it, a border is this far along the lane.
  quant.borderAt = (peak, side, across) =>
    peak[side] + across * Math.tan(((peak[`${side}_tilt_deg`] || 0) * Math.PI) / 180);

  quant.isTilted = (peak) => !!(peak.start_tilt_deg || peak.end_tilt_deg);

  // Baseline-subtracted area between the peak borders (trapezoid rule).
  //
  // With a tilted border the region is not the same at every point across the
  // lane, so the lane is taken line by line (`strip`, from lanes.extractStrip):
  // each line is summed between its own borders, above the background, and the
  // area is the mean of the lines, in the units of the profile, which is
  // their mean. With straight borders that is the sum on the profile. The
  // background curve is the same for every line, except for valley to valley
  // (`valley`), where each line has the straight line between its own values
  // at its two borders (the profile there still holds the slanted band of the
  // other lines).
  quant.peakArea = function (profile, baseline, peak, { strip = null, valley = false } = {}) {
    const n = profile.length;
    if (!strip || !quant.isTilted(peak) || strip.n !== n) {
      const [a, b] = quant.peakBounds(peak, n);
      if (b <= a) return 0;
      let area = 0;
      for (let i = a; i < b; i++)
        area += 0.5 * (profile[i] - baseline[i] + profile[i + 1] - baseline[i + 1]);
      return area;
    }
    let total = 0;
    for (let j = 0; j < strip.m; j++) {
      const [a, b] = quant.peakBounds({
        start: quant.borderAt(peak, "start", strip.across[j]),
        end: quant.borderAt(peak, "end", strip.across[j]),
      }, n);
      if (b <= a) continue;
      const row = strip.data.subarray(j * n, (j + 1) * n);
      const bg = valley
        ? (i) => Math.min(row[i], row[a] + ((row[b] - row[a]) * (i - a)) / (b - a))
        : (i) => baseline[i];
      for (let i = a; i < b; i++) total += 0.5 * (row[i] - bg(i) + row[i + 1] - bg(i + 1));
    }
    return total / strip.m;
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
  // `strips` (optional) are the lanes line by line, for tilted borders.
  quant.resultsTable = function (laneList, profiles, baselines, strips = []) {
    const bands = [
      ...new Set(laneList.flatMap((l) => l.peaks.filter((p) => p.quantify).map((p) => p.band_id))),
    ].sort((a, b) => a - b);
    const rows = laneList.map((lane, i) => {
      const row = new Array(bands.length).fill(null);
      for (const p of lane.peaks) {
        if (!p.quantify) continue;
        const j = bands.indexOf(p.band_id);
        row[j] = (row[j] || 0) + quant.peakArea(profiles[i], baselines[i], p,
          { strip: strips[i] || null, valley: !!lane.baseline && lane.baseline.method === "valley" });
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
      const values = row.map((v) => (v === null ? "" : num.format(v)));
      lines.push((headers ? [i + 1, ...values] : values).join(sep));
    });
    return lines.join("\n") + "\n";
  };
})();
