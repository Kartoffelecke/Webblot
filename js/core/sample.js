// Synthetic western blot with known lanes and bands, for trying the tool out.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});

  function random(seed) {
    // mulberry32: small deterministic generator
    let a = seed >>> 0;
    const uniform = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () =>
      Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
    return { uniform, normal };
  }

  function to16(values, w, h) {
    let top = 0;
    for (const v of values) top = Math.max(top, v);
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor((Math.max(values[i], 0) / top) * 60000);
    return { w, h, data };
  }

  // { wb, bf, centers, bandYs }: a blot image and its brightfield with a ladder in lane 1
  WB.sample = function (options = {}) {
    const { w = 640, h = 420, nLanes = 8, bandYs = [90, 200, 320], seed = 1 } = options;
    const rng = random(seed);
    const pitch = w / (nLanes + 1);
    const centers = Array.from({ length: nLanes }, (_, i) => pitch * (i + 1));
    const laneWidth = 0.7 * pitch;
    const sigma = 5;
    const volumes = centers.map(() => bandYs.map((_, j) => (j === bandYs.length - 1 ? 0.8 : 0.3 + 0.7 * rng.uniform())));
    const across = (x, cx) => 1 / (1 + Math.pow(Math.abs(x - cx) / (0.42 * laneWidth), 8));
    const wb = new Float64Array(w * h);
    const bf = new Float64Array(w * h);
    const ladderYs = Array.from({ length: 6 }, (_, i) => 50 + ((h - 100) * i) / 5);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0.15 * (y / h) + 0.05 + 0.01 * rng.normal();
        centers.forEach((cx, i) => {
          const a = across(x, cx);
          if (a < 1e-4) return;
          bandYs.forEach((by, j) => {
            const along = Math.exp(-0.5 * ((y - by) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
            v += volumes[i][j] * along * a * 10;
          });
        });
        wb[y * w + x] = v;
        let b = 0.9 + 0.01 * rng.normal();
        const a0 = across(x, centers[0]);
        for (const ly of ladderYs) b -= 0.6 * Math.exp(-0.5 * ((y - ly) / 3) ** 2) * a0;
        bf[y * w + x] = b;
      }
    }
    return { wb: to16(wb, w, h), bf: to16(bf, w, h), centers, bandYs, ladderYs };
  };
})();
