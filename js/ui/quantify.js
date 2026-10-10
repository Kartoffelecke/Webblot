// Quantify: one editable profile plot per lane, stacked, and the side panel
// with background settings, the peak list and the results table.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, quant, num } = WB;
  const quantify = (WB.quantify = {});

  const PLOT = { height: 124, left: 58, right: 10, top: 16, bottom: 18 };
  const options = { prominencePct: 5, copyHeaders: false };
  quantify.options = options;

  const METHOD_LABELS = [
    ["none", "None"],
    ["rolling", "Rolling ball"],
    ["linear", "Straight line"],
    ["manual", "Manual anchors"],
    ["valley", "Valley to valley (as in Fiji)"],
  ];

  // -------------------------------------------------------------------- plots

  function scales(svg, profile, baseline) {
    // the plot is drawn in screen pixels: one unit of its viewBox is one pixel
    const width = Math.max(svg.getBoundingClientRect().width || 600, 200);
    const n = profile.length;
    const lo = Math.min(num.min(profile), num.min(baseline));
    const top = num.max(profile);
    const hi = top + 0.2 * (top - lo || 1); // head room for the peak numbers
    const pw = width - PLOT.left - PLOT.right;
    const ph = PLOT.height - PLOT.top - PLOT.bottom;
    return {
      width, n, lo, hi,
      x: (pos) => PLOT.left + (pos / Math.max(n - 1, 1)) * pw,
      y: (v) => PLOT.top + (1 - (v - lo) / (hi - lo)) * ph,
      pos: (px) => num.clip(((px - PLOT.left) / pw) * (n - 1), 0, n - 1),
      value: (py) => lo + (1 - (py - PLOT.top) / ph) * (hi - lo),
    };
  }

  // pointer position inside a plot, in the coordinates it is drawn in
  const local = (svg, ev) => {
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  };

  // The plots may be rebuilt while a drag is going on; always work on the one
  // that is on the page now.
  const livePlot = (index, fallback) =>
    document.querySelector(`svg.plot[data-index="${index}"]`) || fallback;

  function dragIn(svg, ev, onMove, onEnd) {
    ev.preventDefault();
    ev.stopPropagation();
    const index = svg.dataset.index;
    const move = (e) => onMove(local(livePlot(index, svg), e));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function drawPlot(blot, index, svg) {
    const lane = blot.session.lanes[index];
    const { profile, baseline } = app.curves(blot, lane);
    const s = scales(svg, profile, baseline);
    const current = blot.id === state.selected && index === state.lane;
    svg.setAttribute("viewBox", `0 0 ${s.width} ${PLOT.height}`);
    svg.classList.toggle("current", current);
    svg.replaceChildren();
    const add = (tag, attrs, ...kids) => {
      const node = dom.svg(tag, attrs, ...kids);
      svg.append(node);
      return node;
    };
    const redraw = () => drawPlot(blot, index, livePlot(index, svg));
    const finish = () => app.changed("quant");
    const bottom = PLOT.height - PLOT.bottom;

    add("rect", { x: 0, y: 0, width: 4, height: PLOT.height, class: "lane-mark" }); // lit for the current lane
    add("rect", { x: PLOT.left, y: PLOT.top, width: s.width - PLOT.left - PLOT.right, height: bottom - PLOT.top, class: "plot-bg" });
    add("text", { x: 8, y: 12, class: "plot-title" }, `Lane ${index + 1}`);
    add("text", { x: PLOT.left - 4, y: PLOT.top + 8, class: "plot-tick", "text-anchor": "end" }, num.formatG(s.hi, 3));
    add("text", { x: PLOT.left - 4, y: bottom, class: "plot-tick", "text-anchor": "end" }, num.formatG(s.lo, 3));
    add("text", { x: PLOT.left, y: PLOT.height - 4, class: "plot-tick" }, "0");
    add("text", { x: s.width - PLOT.right, y: PLOT.height - 4, class: "plot-tick", "text-anchor": "end" }, `${s.n - 1} px`);

    lane.peaks.forEach((peak, k) => {
      const used = peak.quantify;
      const [a, b] = quant.peakBounds(peak, s.n);
      const x0 = s.x(Math.min(peak.start, peak.end));
      const x1 = s.x(Math.max(peak.start, peak.end));
      // the peak's extent; a right-click on it removes the peak
      add("rect", {
        x: x0, y: PLOT.top, width: Math.max(x1 - x0, 1), height: bottom - PLOT.top,
        class: `peak-region${used ? "" : " unused"}`, "data-t": "peak-region", "data-index": k,
        oncontextmenu: (ev) => {
          ev.preventDefault();
          app.select(blot.id, index);
          app.removePeak(lane, peak);
        },
      });
      // the measured area: between profile and background, inside the borders
      const outline = [];
      for (let i = a; i <= b; i++) outline.push(`${s.x(i)},${s.y(profile[i])}`);
      for (let i = b; i >= a; i--) outline.push(`${s.x(i)},${s.y(baseline[i])}`);
      add("polygon", { points: outline.join(" "), class: `peak-fill${used ? "" : " unused"}`, "data-t": "peak-fill" });
      let top = -Infinity;
      for (let i = a; i <= b; i++) top = Math.max(top, profile[i]);
      add("text", { x: 0.5 * (x0 + x1), y: s.y(top) - 3, class: "peak-number", "text-anchor": "middle" }, peak.band_id);
      ["start", "end"].forEach((side) => {
        add("line", {
          x1: s.x(peak[side]), x2: s.x(peak[side]), y1: PLOT.top, y2: bottom,
          class: `peak-border${used ? "" : " unused"}`, "data-t": "peak-border", "data-index": k, "data-side": side,
          onpointerdown: (ev) => {
            app.select(blot.id, index);
            dragIn(svg, ev, ([px]) => {
              peak[side] = s.pos(px);
              // keep the apex inside the borders
              const [lo, hi] = quant.peakBounds(peak, s.n);
              if (hi > lo) {
                let best = lo;
                for (let i = lo; i <= hi; i++)
                  if (profile[i] - baseline[i] > profile[best] - baseline[best]) best = i;
                peak.apex = best;
              }
              redraw();
            }, () => {
              if (peak.start > peak.end) [peak.start, peak.end] = [peak.end, peak.start];
              finish();
            });
          },
        });
      });
    });

    const path = (curve) => {
      let d = "";
      for (let i = 0; i < s.n; i++) d += `${i ? "L" : "M"}${s.x(i).toFixed(1)},${s.y(curve[i]).toFixed(1)}`;
      return d;
    };
    add("path", { d: path(profile), class: "profile", "data-t": "profile" });
    add("path", { d: path(baseline), class: "baseline", "data-t": "baseline" });

    const grip = (pos, value, t, k, onMove) =>
      add("circle", {
        cx: s.x(pos), cy: s.y(value), r: 5, class: "anchor", "data-t": t, "data-index": k,
        onpointerdown: (ev) => {
          app.select(blot.id, index);
          dragIn(svg, ev, (p) => { onMove(p); redraw(); }, finish);
        },
      });
    if (lane.baseline.method === "manual") {
      lane.baseline.anchors.forEach((anchor, k) =>
        grip(anchor[0], anchor[1], "anchor", k, ([px, py]) => {
          lane.baseline.anchors[k] = [s.pos(px), s.value(py)];
        }));
    } else if (lane.baseline.method === "linear") {
      // one handle at each end of the line, movable up and down
      [0, 1].forEach((k) =>
        grip(k * (s.n - 1), baseline[k * (s.n - 1)], "line-end", k, ([, py]) => {
          const ends = (lane.baseline.linear_ends || quant.linearEnds(profile)).slice();
          ends[k] = s.value(py);
          lane.baseline.linear_ends = ends;
        }));
    }

    svg.onpointerdown = () => app.select(blot.id, index);
    svg.ondblclick = (ev) => {
      const [px, py] = local(svg, ev);
      if (px < PLOT.left || px > s.width - PLOT.right) return;
      app.select(blot.id, index);
      if (ev.shiftKey) toggleAnchor(lane, baseline, s, px, py);
      else app.addPeak(blot, lane, s.pos(px));
    };
  }

  // Shift + double-click: add a background anchor, or remove the one under the cursor.
  function toggleAnchor(lane, baseline, s, px, py) {
    const b = lane.baseline;
    if (b.method !== "manual") {
      b.anchors = quant.baselineToAnchors(baseline);
      b.method = "manual";
    }
    const hit = b.anchors.findIndex(([ax, ay]) => Math.abs(s.x(ax) - px) < 10 && Math.abs(s.y(ay) - py) < 10);
    if (hit >= 0) {
      if (b.anchors.length > 2) b.anchors.splice(hit, 1);
    } else {
      b.anchors.push([s.pos(px), s.value(py)]);
      b.anchors.sort((p, q) => p[0] - q[0]);
    }
    app.changed("quant", "panel");
  }

  quantify.renderPlots = function (root) {
    const blot = app.blot();
    if (!blot || !blot.session.lanes.length) {
      root.replaceChildren(dom.el("p", { class: "empty" }, "Mark lanes first (Lanes tab)."));
      return;
    }
    const plots = blot.session.lanes.map((_, i) => dom.svg("svg", { class: "plot", "data-t": "plot", "data-index": i, height: PLOT.height }));
    const noPeaks = blot.session.lanes.every((lane) => !lane.peaks.length);
    root.replaceChildren(
      noPeaks ? dom.el("p", { class: "notice", "data-t": "no-peaks" },
        "No peaks are marked yet. Press ",
        dom.button("Detect (all)", "detect-all-here", () => quantify.detect(blot, true)),
        " to find them in every lane, or double-click a band in a plot.") : "", // not null: the DOM would print it
      dom.el("p", { class: "hint" },
        "Drag a peak's borders to move them. Double-click adds a peak, right-click on a peak removes it. Shift + double-click adds a background anchor or removes the one under the cursor; drag anchors and line ends to shape the background."),
      ...plots);
    plots.forEach((svg, i) => drawPlot(blot, i, svg));
  };

  // -------------------------------------------------------------------- panel

  quantify.detect = function (blot, all) {
    const list = all ? blot.session.lanes : [blot.session.lanes[state.lane]].filter(Boolean);
    for (const lane of list) {
      const { profile } = app.curves(blot, lane);
      lane.peaks = quant.detectPeaks(profile, quant.searchBaseline(profile, lane.baseline), { prominence: options.prominencePct / 100 });
      quant.numberPeaks(lane);
    }
    app.changed("quant");
  };

  // The table as it is reported: areas, or with "Normalize across samples"
  // each band relative to the lane in which it is largest.
  quantify.table = (blot) => {
    const { bands, rows } = app.results(blot);
    return { bands, rows: state.normalize ? quant.normalizeRows(rows) : rows };
  };

  quantify.csv = (blot, sep = ",", headers = true) => {
    const { bands, rows } = quantify.table(blot);
    return quant.tableToCsv(bands, rows, sep, headers);
  };

  function resultsTable(blot) {
    const { bands, rows } = quantify.table(blot);
    return dom.el("table", { class: "grid", "data-t": "results" },
      dom.el("tr", {}, dom.el("th", {}, ""), bands.map((b) => dom.el("th", {}, `Peak ${b}`))),
      rows.map((row, i) =>
        dom.el("tr", {}, dom.el("th", {}, `Lane ${i + 1}`),
          row.map((v) => dom.el("td", {}, v === null ? "" : num.formatG(v, 5))))));
  }

  quantify.panel = function (blot) {
    const list = blot.session.lanes;
    const lane = list[state.lane];
    if (!lane) return [dom.el("p", { class: "hint" }, "Mark lanes first (Lanes tab).")];
    const b = lane.baseline;
    const { profile, baseline } = app.curves(blot, lane);
    const ends = b.linear_ends || quant.linearEnds(profile);
    const changed = () => app.changed("quant");
    const isLine = b.method === "linear";

    const peakRows = lane.peaks.map((peak, k) =>
      dom.el("tr", { "data-t": "peak-row" },
        dom.el("td", {}, dom.el("input", {
          type: "checkbox", checked: peak.quantify, "data-t": "peak-use",
          onchange: (ev) => { peak.quantify = ev.target.checked; changed(); },
        })),
        dom.el("td", {}, dom.number(peak.band_id, { t: "peak-number", min: 1, step: 1, width: 44 },
          (v) => { peak.band_id = Math.max(Math.round(v), 1); changed(); })),
        dom.el("td", {}, dom.number(Math.round(peak.start), { t: "peak-start", min: 0, step: 1, width: 54 },
          (v) => { peak.start = v; changed(); })),
        dom.el("td", {}, dom.number(Math.round(peak.end), { t: "peak-end", min: 0, step: 1, width: 54 },
          (v) => { peak.end = v; changed(); })),
        dom.el("td", { "data-t": "peak-area" }, num.formatG(quant.peakArea(profile, baseline, peak), 5)),
        dom.el("td", {}, dom.button("×", "peak-delete", () => app.removePeak(lane, peak), "Remove this peak"))));

    return [
      dom.group("Lane",
        dom.row("Current", dom.number(state.lane + 1, { t: "current-lane", min: 1, max: list.length, step: 1, width: 56 },
          (v) => app.select(blot.id, num.clip(Math.round(v), 1, list.length) - 1)), `of ${list.length}`)),
      dom.group("Background",
        dom.row("Method", dom.select(METHOD_LABELS, b.method, "bg-method", (v) => {
          if (v === "manual" && !b.anchors.length) b.anchors = quant.baselineToAnchors(baseline);
          b.method = v;
          changed();
        })),
        dom.row("Radius", dom.number(b.radius, { t: "bg-radius", min: 2, max: 2000, step: 1, disabled: b.method !== "rolling" && b.method !== "valley" },
          (v) => { b.radius = v; changed(); }), "px"),
        b.method === "valley" ? dom.el("p", { class: "hint", "data-t": "valley-hint" },
          "Each peak is measured above the straight line between its two borders, so the borders decide the result: drag them into the valleys. The radius is only used to find peaks.") : null,
        dom.row("Line start / end",
          dom.number(Math.round(ends[0]), { t: "bg-line-start", step: 1, disabled: !isLine }, (v) => { b.linear_ends = [v, ends[1]]; changed(); }),
          dom.number(Math.round(ends[1]), { t: "bg-line-end", step: 1, disabled: !isLine }, (v) => { b.linear_ends = [ends[0], v]; changed(); }),
          dom.el("button", { type: "button", "data-t": "bg-line-auto", disabled: !isLine || !b.linear_ends,
            title: "Take the heights from the two ends of the profile.",
            onclick: () => { b.linear_ends = null; changed(); } }, "Auto")),
        dom.row(null,
          dom.button("Edit by hand", "bg-edit", () => {
            if (b.method !== "manual") {
              b.anchors = quant.baselineToAnchors(baseline);
              b.method = "manual";
            }
            changed();
          }, "Turn the current background into draggable anchor points."),
          dom.button("Apply to all lanes", "bg-all", () => {
            for (const other of list) if (other !== lane) other.baseline = WB.model.copy(b);
            changed();
          }))),
      dom.group("Peaks",
        dom.row("Sensitivity", dom.number(options.prominencePct, { t: "sensitivity", min: 0.5, max: 90, step: 0.5 },
          (v) => (options.prominencePct = v)), "%"),
        dom.row(null,
          dom.button("Detect (lane)", "detect-lane", () => quantify.detect(blot, false)),
          dom.button("Detect (all)", "detect-all", () => quantify.detect(blot, true)),
          dom.button("Renumber", "renumber", () => { list.forEach(quant.numberPeaks); changed(); },
            "Number the peaks of every lane 1, 2, 3, … from the top (overwrites edited numbers).")),
        dom.el("table", { class: "grid", "data-t": "peaks" },
          dom.el("tr", {}, ["Use", "Peak #", "Start", "End", "Area", ""].map((h) => dom.el("th", {}, h))),
          peakRows)),
      dom.group("Band areas (rows: lanes, columns: peaks)",
        dom.row(null, dom.check("Normalize across samples", state.normalize, "normalize", (v) => {
          state.normalize = v;
          changed();
        }, "Divide each peak by its largest area among the lanes, so that every column runs from 0 to 1. Applies to the table, Copy and the CSV of every blot.")),
        dom.el("div", { class: "scroll-x" }, resultsTable(blot)),
        dom.row(null,
          dom.button("Copy", "results-copy", () => navigator.clipboard.writeText(quantify.csv(blot, "\t", options.copyHeaders)),
            "Copy the table, to paste into a spreadsheet."),
          dom.check("Copy headers", options.copyHeaders, "copy-headers", (v) => (options.copyHeaders = v),
            "Also copy the title row and the column of lane numbers. The CSV file always has them."),
          dom.button("Download CSV", "results-csv", () => dom.download(`${blot.name}_${state.normalize ? "normalized" : "areas"}.csv`, quantify.csv(blot), "text/csv")))),
    ];
  };
})();
