// Numerical helpers that mirror numpy / scipy functions of the same names.
// Everything works on plain arrays or typed arrays of numbers.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const num = (WB.num = {});

  // Python's round(): halves go to the even neighbour.
  num.round = function (x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  };

  num.clip = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

  num.sum = function (a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s;
  };

  num.mean = (a) => num.sum(a) / a.length;

  num.min = function (a) {
    let m = Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i];
    return m;
  };

  num.max = function (a) {
    let m = -Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
    return m;
  };

  num.argmax = function (a, from = 0, to = a.length) {
    let best = from;
    for (let i = from + 1; i < to; i++) if (a[i] > a[best]) best = i;
    return best;
  };

  num.argmin = function (a, from = 0, to = a.length) {
    let best = from;
    for (let i = from + 1; i < to; i++) if (a[i] < a[best]) best = i;
    return best;
  };

  function sorted(a) {
    return Float64Array.from(a).sort();
  }

  num.median = function (a) {
    const s = sorted(a);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  };

  // np.percentile with linear interpolation; qs in percent.
  num.percentiles = function (a, qs) {
    const s = sorted(a);
    return qs.map((q) => {
      const pos = (q / 100) * (s.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, s.length - 1);
      return s[lo] + (s[hi] - s[lo]) * (pos - lo);
    });
  };

  num.linspace = function (a, b, n) {
    if (n === 1) return [a];
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = a + ((b - a) * i) / (n - 1);
    out[n - 1] = b;
    return out;
  };

  // np.arange for float steps
  num.arange = function (start, stop, step = 1) {
    const n = Math.max(Math.ceil((stop - start) / step), 0);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = start + i * step;
    return out;
  };

  // np.interp: xp increasing; clamps outside the range.
  num.interp = function (x, xp, fp) {
    const n = xp.length;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xp[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
    return fp[lo] + t * (fp[hi] - fp[lo]);
  };

  // Linear interpolation into a sampled curve y[0..n-1] at fractional index x.
  num.interpIndex = function (x, y) {
    const n = y.length;
    if (x <= 0) return y[0];
    if (x >= n - 1) return y[n - 1];
    const i = Math.floor(x);
    return y[i] + (x - i) * (y[i + 1] - y[i]);
  };

  // index of an out-of-range sample under scipy's boundary modes
  function edgeIndex(i, n, mode) {
    if (mode === "nearest") return i < 0 ? 0 : i >= n ? n - 1 : i;
    // "reflect": d c b a | a b c d | d c b a
    if (n === 1) return 0;
    while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
    return i;
  }

  // scipy.ndimage.gaussian_filter1d (truncate = 4)
  num.gaussian1d = function (a, sigma, mode = "reflect") {
    const n = a.length;
    const radius = Math.floor(4 * sigma + 0.5);
    const w = new Float64Array(2 * radius + 1);
    let total = 0;
    for (let k = -radius; k <= radius; k++) {
      w[k + radius] = Math.exp((-0.5 * k * k) / (sigma * sigma));
      total += w[k + radius];
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += w[k + radius] * a[edgeIndex(i + k, n, mode)];
      out[i] = s / total;
    }
    return out;
  };

  // Filter over the window that scipy uses: centred for odd sizes; for even
  // sizes it reaches one sample further to the left, and `origin` shifts it.
  function windowFilter(a, size, mode, combine, init, origin = 0) {
    const n = a.length;
    const first = -Math.floor(size / 2) - origin;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = init;
      for (let k = first; k < first + size; k++) v = combine(v, a[edgeIndex(i + k, n, mode)]);
      out[i] = v;
    }
    return out;
  }

  // running minimum / maximum / mean (scipy's 1D filters)
  num.minFilter = (a, size, mode = "nearest", origin = 0) =>
    windowFilter(a, size, mode, Math.min, Infinity, origin);
  num.maxFilter = (a, size, mode = "nearest", origin = 0) =>
    windowFilter(a, size, mode, Math.max, -Infinity, origin);
  num.uniformFilter = function (a, size, mode = "nearest") {
    const out = windowFilter(a, size, mode, (s, v) => s + v, 0);
    for (let i = 0; i < out.length; i++) out[i] /= size;
    return out;
  };

  // scipy.ndimage.grey_opening with a flat window: erosion, then dilation. For
  // even sizes the dilation window is mirrored, which is what makes the pair an
  // opening.
  num.greyOpening = (a, size, mode = "nearest") =>
    num.maxFilter(num.minFilter(a, size, mode), size, mode, size % 2 ? 0 : -1);

  // least-squares line y = slope * x + intercept
  num.polyfit1 = function (x, y) {
    const n = x.length;
    const mx = num.mean(x);
    const my = num.mean(y);
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) * (x[i] - mx);
    }
    const slope = sxy / sxx;
    return { slope, intercept: my - slope * mx };
  };

  // --- scipy.signal.find_peaks (prominence, width and distance conditions) ---

  function localMaxima(x) {
    const peaks = [];
    const n = x.length;
    let i = 1;
    while (i < n - 1) {
      if (x[i - 1] < x[i]) {
        let ahead = i + 1;
        while (ahead < n - 1 && x[ahead] === x[i]) ahead++; // plateau
        if (x[ahead] < x[i]) {
          peaks.push(Math.floor((i + ahead - 1) / 2));
          i = ahead;
        }
      }
      i++;
    }
    return peaks;
  }

  function selectByDistance(peaks, x, distance) {
    const d = Math.ceil(distance);
    const keep = new Array(peaks.length).fill(true);
    const order = peaks.map((_, i) => i).sort((a, b) => x[peaks[a]] - x[peaks[b]] || a - b);
    for (let o = order.length - 1; o >= 0; o--) {
      const j = order[o];
      if (!keep[j]) continue;
      let k = j - 1;
      while (k >= 0 && peaks[j] - peaks[k] < d) keep[k--] = false;
      k = j + 1;
      while (k < peaks.length && peaks[k] - peaks[j] < d) keep[k++] = false;
    }
    return peaks.filter((_, i) => keep[i]);
  }

  function prominences(x, peaks) {
    return peaks.map((peak) => {
      let i = peak;
      let leftMin = x[peak];
      let leftBase = peak;
      while (i >= 0 && x[i] <= x[peak]) {
        if (x[i] < leftMin) {
          leftMin = x[i];
          leftBase = i;
        }
        i--;
      }
      i = peak;
      let rightMin = x[peak];
      let rightBase = peak;
      while (i < x.length && x[i] <= x[peak]) {
        if (x[i] < rightMin) {
          rightMin = x[i];
          rightBase = i;
        }
        i++;
      }
      return { value: x[peak] - Math.max(leftMin, rightMin), leftBase, rightBase };
    });
  }

  function widths(x, peaks, proms) {
    return peaks.map((peak, k) => {
      const height = x[peak] - proms[k].value * 0.5;
      let i = peak;
      while (proms[k].leftBase < i && height < x[i]) i--;
      let left = i;
      if (x[i] < height) left += (height - x[i]) / (x[i + 1] - x[i]);
      i = peak;
      while (i < proms[k].rightBase && height < x[i]) i++;
      let right = i;
      if (x[i] < height) right -= (height - x[i]) / (x[i - 1] - x[i]);
      return right - left;
    });
  }

  // Returns { peaks, prominences }; options: { distance, prominence, width } (all minimums).
  num.findPeaks = function (x, options = {}) {
    let peaks = localMaxima(x);
    if (options.distance !== undefined) peaks = selectByDistance(peaks, x, options.distance);
    let proms = prominences(x, peaks);
    if (options.prominence !== undefined) {
      const keep = proms.map((p) => p.value >= options.prominence);
      peaks = peaks.filter((_, i) => keep[i]);
      proms = proms.filter((_, i) => keep[i]);
    }
    if (options.width !== undefined) {
      const w = widths(x, peaks, proms);
      const keep = w.map((v) => v >= options.width);
      peaks = peaks.filter((_, i) => keep[i]);
      proms = proms.filter((_, i) => keep[i]);
    }
    return { peaks, prominences: proms.map((p) => p.value) };
  };

  // C-style "%.{p}g" formatting, as Python's f"{v:.6g}"
  num.formatG = function (v, precision = 6) {
    if (v === 0) return "0";
    if (!isFinite(v)) return String(v);
    const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(precision)))));
    if (exp < -4 || exp >= precision) {
      let [mantissa, e] = v.toExponential(precision - 1).split("e");
      if (mantissa.includes(".")) mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
      const sign = e[0] === "-" ? "-" : "+";
      const digits = e.replace(/^[+-]/, "").padStart(2, "0");
      return `${mantissa}e${sign}${digits}`;
    }
    let s = v.toFixed(Math.max(precision - 1 - exp, 0));
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  };
})();
