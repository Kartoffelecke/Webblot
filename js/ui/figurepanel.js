// Figure: lane labels, markers, style, panel order, live preview and export.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, figure, panels, workspace } = WB;
  const figurepanel = (WB.figurepanel = {});

  // { session, image, showLabels } of the blots in the figure, top first
  figurepanel.items = () =>
    state.blots
      .filter((b) => b.include)
      .map((b) => ({
        session: b.session,
        image: b.work.wb,
        showLabels: b.labels,
        bf: b.session.figure.show_bf ? b.work.bf : null,
      }));

  figurepanel.build = function () {
    const items = figurepanel.items();
    return items.length ? figure.build(items, state.style) : null;
  };

  figurepanel.dpi = (built) => (state.style.lossless ? built.nativeDpi : state.style.dpi);

  figurepanel.renderPreview = function (root) {
    const built = figurepanel.build();
    if (!built) {
      root.replaceChildren(dom.el("p", { class: "empty" }, "No blot is shown in the figure."));
      return;
    }
    const holder = dom.el("div", { class: "preview", "data-t": "preview" });
    holder.innerHTML = built.svg;
    // shown enlarged; the exported file keeps its true size
    const svg = holder.firstElementChild;
    svg.setAttribute("width", `${built.width * 2}px`);
    svg.setAttribute("height", `${built.height * 2}px`);
    const mm = (pt) => ((pt / 72) * 25.4).toFixed(1);
    root.replaceChildren(
      dom.el("p", { class: "hint", "data-t": "preview-info" },
        `Figure ${mm(built.width)} × ${mm(built.height)} mm. Lossless resolution: ${Math.round(built.nativeDpi)} dpi.`),
      holder);
  };

  const fileStem = () => (state.blots[0] ? state.blots[0].name : "figure").replace(/[^\w.-]+/g, "_");

  figurepanel.exportSvg = function () {
    const built = figurepanel.build();
    if (built) dom.download(`${fileStem()}_figure.svg`, built.svg, "image/svg+xml");
  };

  figurepanel.exportPng = async function () {
    const built = figurepanel.build();
    if (!built) return;
    dom.download(`${fileStem()}_figure.png`, await figure.toPng(built, figurepanel.dpi(built)));
  };

  // PDF goes through the browser's print dialog ("Save as PDF").
  figurepanel.print = function () {
    const built = figurepanel.build();
    if (!built) return;
    const frame = dom.el("iframe", { style: "position:fixed;right:0;bottom:0;width:0;height:0;border:0" });
    document.body.append(frame);
    frame.contentDocument.write(
      `<!doctype html><title>${fileStem()}_figure</title><style>@page{margin:10mm}body{margin:0}</style>${built.svg}`
    );
    frame.contentDocument.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };

  // -------------------------------------------------------------------- panel

  function labelGrid(blot) {
    const fig = blot.session.figure;
    const n = blot.session.lanes.length;
    const shown = new Set(figure.lanesInFigure(blot.session, blot.work.wb));
    const changed = () => app.changed("figure");
    if (!n) return dom.el("p", { class: "hint" }, "Mark lanes first to label them.");
    const rows = fig.label_rows.map((row, r) => {
      while (row.values.length < n) row.values.push("");
      return dom.el("tr", { "data-t": "label-row" },
        dom.el("td", {}, dom.el("input", {
          type: "checkbox", checked: !!row.collapse, "data-t": "label-collapse",
          title: "Collapse identical: neighbouring lanes with the same text share one label (a merged cell in a table, otherwise one centred text with a bar below).",
          onchange: (ev) => { row.collapse = ev.target.checked; changed(); },
        })),
        dom.el("td", {}, dom.text(row.title, "label-title", (v) => { row.title = v; changed(); }, { class: "cell title", placeholder: "title" })),
        row.values.slice(0, n).map((value, i) =>
          dom.el("td", {}, dom.text(value, "label-cell", (v) => { row.values[i] = v; changed(); },
            { class: `cell${shown.has(i) ? "" : " outside"}`, title: shown.has(i) ? null : "This lane is outside the figure area." }))),
        dom.el("td", {},
          dom.button("⇥", "label-fill", () => {
            // repeat each entry to the right until the next one that is filled in
            let last = "";
            row.values = row.values.map((v) => (v ? (last = v) : last));
            app.changed("figure", "panel");
          }, "Fill empty cells with the entry to their left"),
          dom.button("×", "label-remove", () => { fig.label_rows.splice(r, 1); app.changed("figure", "panel"); }, "Remove this row")));
    });
    return dom.el("div", { class: "scroll-x" },
      dom.el("table", { class: "grid labels", "data-t": "labels" },
        dom.el("tr", {}, dom.el("th", { title: "Collapse identical neighbouring cells into one label" }, "Collapse identical"), dom.el("th", {}, "Title"),
          Array.from({ length: n }, (_, i) => dom.el("th", {}, i + 1)), dom.el("th", {}, "")),
        rows));
  }

  function markerGroup(blot, title, key, sideKey, t, placeholder) {
    const fig = blot.session.figure;
    const list = fig[key];
    const changed = () => app.changed("figure", "panel");
    const count = { value: list.length };
    const place = () => {
      const [y0, , y1] = workspace.figureBox(blot);
      const n = Math.max(Math.round(count.value), 0);
      const pad = 0.1 * (y1 - y0);
      fig[key] = Array.from({ length: n }, (_, i) => ({
        y: n > 1 ? y0 + pad + ((y1 - y0 - 2 * pad) * i) / (n - 1) : 0.5 * (y0 + y1),
        text: list[i] ? list[i].text : "",
      }));
      changed();
    };
    return dom.group(title,
      dom.row("Number", dom.number(list.length, { t: `${t}-count`, min: 0, max: 30, step: 1, width: 52 }, (v) => (count.value = v)),
        dom.button("Place", `${t}-place`, place, "Spread this many markers evenly over the figure area, then drag them on the blot."),
        dom.button("Add", `${t}-add`, () => {
          const [y0, , y1] = workspace.figureBox(blot);
          list.push({ y: 0.5 * (y0 + y1), text: "" });
          list.sort((a, b) => a.y - b.y);
          changed();
        })),
      dom.row("Side", dom.select([["left", "left"], ["right", "right"]], fig[sideKey], `${t}-side`, (v) => { fig[sideKey] = v; changed(); })),
      list.length ? dom.el("table", { class: "grid", "data-t": `${t}-table` },
        dom.el("tr", {}, dom.el("th", {}, "y (px)"), dom.el("th", {}, "Label"), dom.el("th", {}, "")),
        list.map((m, k) => dom.el("tr", {},
          dom.el("td", {}, dom.number(Math.round(m.y), { t: `${t}-y`, step: 1, width: 60 }, (v) => {
            m.y = v;
            list.sort((a, b) => a.y - b.y);
            changed();
          })),
          dom.el("td", {}, dom.text(m.text, `${t}-text`, (v) => { m.text = v; app.changed("figure"); }, { class: "cell wide", placeholder })),
          dom.el("td", {}, dom.button("×", `${t}-remove`, () => { list.splice(k, 1); changed(); }, "Remove this marker"))))) : null);
  }

  figurepanel.panel = function (blot) {
    const fig = blot.session.figure;
    const style = state.style;
    const restyle = () => app.changed("figure");
    const addRow = () => {
      fig.label_rows.push({ title: "", values: blot.session.lanes.map(() => ""), collapse: false });
      app.changed("figure", "panel");
    };
    const built = figurepanel.build();
    return [
      dom.group(`Figure area of “${blot.name}”`,
        dom.row(null,
          panels.toolButton("Draw area", "figarea", "tool-figarea", "Draw the part of the blot to show."),
          dom.button("Whole image", "figarea-clear", () => { fig.crop = null; app.changed("figure", "panel"); })),
        blot.work.bf ? dom.row(null, dom.check("Show the brightfield (marker) in the figure", fig.show_bf, "figure-bf",
          (v) => { fig.show_bf = v; app.changed("figure"); },
          "Merge the brightfield image into this blot's panel, with the exposure set for it under the image.")) : null),
      dom.group("Lane labels",
        labelGrid(blot),
        dom.row(null,
          dom.button("+ Row", "label-add", addRow, "A row of labels: one text above each lane.")),
        dom.el("p", { class: "hint" },
          "Give a row a title to show it at the left. Tick “Collapse identical” to merge neighbouring lanes with the same text into one label.")),
      markerGroup(blot, "MW markers", "mw_markers", "mw_side", "mw", "e.g. 55"),
      markerGroup(blot, "Band markers", "band_markers", "band_side", "band", "e.g. GAPDH"),
      dom.group("Panels, top to bottom",
        dom.el("table", { class: "grid", "data-t": "panel-list" },
          dom.el("tr", {}, ["Show", "Blot", "Lane labels", ""].map((h) => dom.el("th", {}, h))),
          state.blots.map((b) => dom.el("tr", { "data-t": "panel-row" },
            dom.el("td", {}, dom.el("input", { type: "checkbox", checked: b.include, "data-t": "panel-include",
              onchange: (ev) => { b.include = ev.target.checked; restyle(); } })),
            dom.el("td", {}, b.name),
            dom.el("td", {}, dom.el("input", { type: "checkbox", checked: b.labels, "data-t": "panel-labels",
              onchange: (ev) => { b.labels = ev.target.checked; restyle(); } })),
            dom.el("td", {},
              dom.button("↑", "panel-up", () => app.moveBlot(b.id, -1)),
              dom.button("↓", "panel-down", () => app.moveBlot(b.id, 1)))))),
        dom.row("Gap", dom.number(style.gap_mm, { t: "gap", min: 0, max: 50, step: 0.5 }, (v) => { style.gap_mm = v; restyle(); }), "mm")),
      dom.group("Style (all panels)",
        dom.row("Labels", dom.select([["plain", "Plain"], ["table", "Table"]], style.label_style, "label-style",
          (v) => { style.label_style = v; restyle(); })),
        dom.row("Rotate top text row", dom.select([["0", "0°"], ["45", "45°"], ["90", "90°"]], String(style.label_rotation), "label-rotation",
          (v) => { style.label_rotation = Number(v); restyle(); })),
        dom.row("MW unit", dom.text(style.mw_unit, "mw-unit", (v) => { style.mw_unit = v; restyle(); }, { class: "cell wide", placeholder: "e.g.  kDa" }),
          dom.select([["each", "after each label"], ["top", "once, above"]], style.mw_unit_position, "mw-unit-position",
            (v) => { style.mw_unit_position = v; restyle(); })),
        dom.row("Font size", dom.number(style.font_size, { t: "font-size", min: 4, max: 30, step: 0.5 }, (v) => { style.font_size = v; restyle(); }), "pt"),
        dom.row("Gel width", dom.number(style.gel_width_mm, { t: "gel-width", min: 10, max: 300, step: 1 }, (v) => { style.gel_width_mm = v; app.changed("figure", "panel"); }), "mm"),
        dom.row("Line width", dom.number(style.line_width, { t: "line-width", min: 0.1, max: 5, step: 0.1 }, (v) => { style.line_width = v; restyle(); }), "pt"),
        dom.row("PNG resolution",
          dom.select([["1", "Lossless (image pixels)"], ["0", "Custom dpi"]], style.lossless ? "1" : "0", "resolution",
            (v) => { style.lossless = v === "1"; app.changed("figure", "panel"); }),
          dom.number(style.dpi, { t: "dpi", min: 72, max: 2400, step: 1, disabled: style.lossless }, (v) => { style.dpi = v; restyle(); })),
        built && style.lossless ? dom.el("p", { class: "hint" }, `Lossless is ${Math.round(built.nativeDpi)} dpi at this gel width.`) : null),
      dom.group("Export",
        dom.row(null,
          dom.button("SVG", "export-svg", figurepanel.exportSvg, "Vector file with the gel's own pixels embedded and editable text."),
          dom.button("PNG", "export-png", figurepanel.exportPng),
          dom.button("Print / PDF", "export-print", figurepanel.print, "Opens the print dialog; choose “Save as PDF”."))),
    ];
  };
})();
