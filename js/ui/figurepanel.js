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
  // downloads of the first figure are named as before; further ones by their own name
  const figureStem = () => (app.figure() === state.figures[0] ? `${fileStem()}_figure` : app.figure().name.replace(/[^\w.-]+/g, "_"));

  figurepanel.exportSvg = function () {
    const built = figurepanel.build();
    if (built) dom.download(`${figureStem()}.svg`, built.svg, "image/svg+xml");
  };

  figurepanel.exportPng = async function () {
    const built = figurepanel.build();
    if (!built) return;
    dom.download(`${figureStem()}.png`, await figure.toPng(built, figurepanel.dpi(built)));
  };

  // PDF goes through the browser's print dialog ("Save as PDF").
  figurepanel.print = function () {
    const built = figurepanel.build();
    if (!built) return;
    const frame = dom.el("iframe", { style: "position:fixed;right:0;bottom:0;width:0;height:0;border:0" });
    document.body.append(frame);
    frame.contentDocument.write(
      `<!doctype html><title>${figureStem()}</title><style>@page{margin:10mm}body{margin:0}</style>${built.svg}`
    );
    frame.contentDocument.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };

  // -------------------------------------------------------------------- panel

  // ------------------------------------------------------------------- sheets

  // Text copied from a spreadsheet as rows of cells.
  figurepanel.parseBlock = (text) =>
    text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map((line) => line.split("\t").map((cell) => cell.trim()));

  // Make a table of inputs behave like a sheet. Its cells are the inputs with
  // data-r and data-c (row and column). Enter and the up and down arrows move
  // between rows; a block of cells pasted from a spreadsheet goes to
  // `onPaste(row, column, block)` instead of into the one input.
  function sheet(table, onPaste) {
    const position = (cell) => cell.dataset && cell.dataset.r !== undefined && [Number(cell.dataset.r), Number(cell.dataset.c)];
    table.classList.add("sheet");
    table.addEventListener("keydown", (ev) => {
      const at = position(ev.target);
      // in a number field the arrows change the number
      const arrows = ev.target.type !== "number";
      const step = ev.key === "Enter" || (arrows && ev.key === "ArrowDown") ? 1 : arrows && ev.key === "ArrowUp" ? -1 : 0;
      if (!at || !step) return;
      const next = table.querySelector(`[data-r="${at[0] + step}"][data-c="${at[1]}"]`);
      if (!next) return;
      ev.preventDefault();
      next.focus();
      next.select();
    });
    table.addEventListener("paste", (ev) => {
      const at = position(ev.target);
      if (!at || !ev.clipboardData) return;
      const block = figurepanel.parseBlock(ev.clipboardData.getData("text/plain"));
      if (block.length === 1 && block[0].length === 1) return; // one value: an ordinary paste
      ev.preventDefault();
      onPaste(at[0], at[1], block);
    });
    return table;
  }

  const isColumn = (block) => block.length > 1 && block.every((line) => line.length === 1);
  const isRow = (block) => block.length === 1 && block[0].length > 1;

  // A block pasted into the lane labels at label row `r`, column `c` (0 is the
  // title, 1 the first lane). It fills lanes to the right and rows downwards;
  // rows that are missing are added. A list that was copied as a column goes
  // along the lanes.
  function pasteLabels(blot, r, c, block) {
    const fig = blot.session.figure;
    const n = blot.session.lanes.length;
    if (c >= 1 && isColumn(block)) block = [block.map((line) => line[0])];
    block.forEach((line, dr) => {
      if (!fig.label_rows[r + dr]) fig.label_rows[r + dr] = { title: "", values: Array(n).fill(""), collapse: false };
      const row = fig.label_rows[r + dr];
      line.forEach((value, dc) => {
        if (c + dc === 0) row.title = value;
        else if (c + dc <= n) row.values[c + dc - 1] = value;
      });
    });
    app.changed("figure", "panel");
  }

  // What the last paste into a list of markers could not place.
  const pasteNotes = new WeakMap();

  // A block pasted into a marker table at marker `k`, column `c` (0 is y, 1
  // the label). A list goes down the labels; with a y in front, markers that
  // are missing are added.
  function pasteMarkers(list, k, c, block) {
    if (c === 1 && isRow(block)) block = block[0].map((value) => [value]);
    const targets = block.map((_, dr) => list[k + dr]);
    let dropped = 0;
    block.forEach((line, dr) => {
      const y = c === 0 ? parseFloat(line[0].replace(",", ".")) : NaN;
      const text = c === 0 ? line[1] : line[0];
      let marker = targets[dr];
      if (!marker) {
        if (Number.isNaN(y)) return void dropped++;
        marker = { y, text: "" };
        list.push(marker);
      } else if (!Number.isNaN(y)) marker.y = y;
      if (text !== undefined) marker.text = text;
    });
    list.sort((a, b) => a.y - b.y);
    if (dropped) pasteNotes.set(list, `${dropped} pasted label${dropped === 1 ? " has" : "s have"} no marker to go to. Add markers first, or paste y and label side by side into the y column.`);
    else pasteNotes.delete(list);
    app.changed("figure", "panel");
  }

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
        dom.el("td", {}, dom.text(row.title, "label-title", (v) => { row.title = v; changed(); },
          { class: "cell title", placeholder: "title", "data-r": r, "data-c": 0 })),
        row.values.slice(0, n).map((value, i) =>
          dom.el("td", {}, dom.text(value, "label-cell", (v) => { row.values[i] = v; changed(); }, {
            class: `cell${shown.has(i) ? "" : " outside"}`, title: shown.has(i) ? null : "This lane is outside the figure area.",
            "data-r": r, "data-c": i + 1,
          }))),
        dom.el("td", {},
          dom.icon("fill", "label-fill", () => {
            // repeat each entry to the right until the next one that is filled in
            let last = "";
            row.values = row.values.map((v) => (v ? (last = v) : last));
            app.changed("figure", "panel");
          }, "Fill empty cells with the entry to their left", "small"),
          dom.icon("close", "label-remove", () => { fig.label_rows.splice(r, 1); app.changed("figure", "panel"); }, "Remove this row", "small")));
    });
    return dom.el("div", { class: "scroll-x" },
      sheet(dom.el("table", { class: "grid labels", "data-t": "labels" },
        dom.el("tr", {}, dom.el("th", { title: "Collapse identical neighbouring cells into one label" }, "Collapse"), dom.el("th", {}, "Title"),
          Array.from({ length: n }, (_, i) => dom.el("th", {}, i + 1)), dom.el("th", {}, "")),
        rows), (r, c, block) => pasteLabels(blot, r, c, block)));
  }

  function markerGroup(blot, title, key, sideKey, t, placeholder) {
    const fig = blot.session.figure;
    const list = fig[key];
    const changed = () => {
      pasteNotes.delete(list);
      app.changed("figure", "panel");
    };
    const cell = (input, k, c) => {
      input.classList.add("cell");
      input.dataset.r = k;
      input.dataset.c = c;
      return input;
    };
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
      list.length ? sheet(dom.el("table", { class: "grid", "data-t": `${t}-table` },
        dom.el("tr", {}, dom.el("th", {}, "y (px)"), dom.el("th", {}, "Label"), dom.el("th", {}, "")),
        list.map((m, k) => dom.el("tr", {},
          dom.el("td", {}, cell(dom.number(Math.round(m.y), { t: `${t}-y`, step: 1, width: 70 }, (v) => {
            m.y = v;
            list.sort((a, b) => a.y - b.y);
            changed();
          }), k, 0)),
          dom.el("td", {}, cell(dom.text(m.text, `${t}-text`, (v) => { m.text = v; app.changed("figure"); }, { class: "wide", placeholder }), k, 1)),
          dom.el("td", {}, dom.icon("close", `${t}-remove`, () => { list.splice(k, 1); changed(); }, "Remove this marker", "small"))))),
        (k, c, block) => pasteMarkers(list, k, c, block)) : null,
      pasteNotes.has(list) ? dom.el("p", { class: "notice", "data-t": `${t}-paste-note` }, pasteNotes.get(list)) : null,
      list.length ? dom.el("p", { class: "hint" },
        "A list copied from a spreadsheet can be pasted into the Label column; two columns (y, label) into the y column.") : null);
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
    const current = app.figure();
    return [
      dom.group("Figure",
        dom.row("Editing", dom.select(state.figures.map((f) => [f.id, f.name]), current.id, "figure-select", (id) => app.selectFigure(id)),
          dom.button([WB.icon("plus"), "New"], "figure-new", () => app.addFigure("Figure", true), "Another figure of this folder, showing every blot whole."),
          dom.button("Duplicate", "figure-duplicate", () => app.addFigure(`${current.name} copy`), "A copy of this figure, to change.")),
        dom.row("Name", dom.text(current.name, "figure-name", (v) => app.renameFigure(current, v), { class: "wide-field" }),
          dom.el("button", { type: "button", class: "quiet danger", "data-t": "figure-delete", disabled: state.figures.length < 2,
            title: "Delete this figure. A folder keeps at least one.",
            onclick: () => WB.feedback.confirm(`Delete the figure “${current.name}”? The blots stay.`, "Delete figure", { danger: true })
              .then((yes) => yes && app.removeFigure(current.id)) }, "Delete")),
        state.figures.length > 1 ? dom.el("p", { class: "hint" },
          "Which blots a figure shows, their areas and the style are the figure's own. Lane labels and markers belong to the blots.") : null),
      dom.group("Figure area",
        dom.row(null, dom.toggle("Whole image", "Selected area only", fig.crop_on, "figure-crop", (v) => app.setFigureCrop(blot, v),
          "Show the whole blot in the figure, or only the area in the box on the blot.")),
        fig.crop_on ? dom.el("p", { class: "hint" }, "Move the box on the blot or drag its corners.") : null,
        blot.work.bf ? dom.row(null, dom.check("Show the brightfield (marker) in the figure", fig.show_bf, "figure-bf",
          (v) => { fig.show_bf = v; app.changed("figure"); },
          "Merge the brightfield image into this blot's panel, with the exposure set for it under the image.")) : null),
      dom.group("Lane labels",
        labelGrid(blot),
        dom.row(null,
          dom.button([WB.icon("plus"), "Row"], "label-add", addRow, "A row of labels: one text above each lane.")),
        dom.el("p", { class: "hint" },
          "Give a row a title to show it at the left. Tick “Collapse” to merge neighbouring lanes with the same text into one label. Cells copied from a spreadsheet can be pasted in; a list copied as a column goes along the lanes.")),
      markerGroup(blot, "MW markers", "mw_markers", "mw_side", "mw", "e.g. 55"),
      markerGroup(blot, "Band markers", "band_markers", "band_side", "band", "e.g. GAPDH"),
      dom.group("Panels",
        dom.el("p", { class: "hint" }, "The blots of the figure, top to bottom."),
        dom.el("table", { class: "grid", "data-t": "panel-list" },
          dom.el("tr", {}, dom.el("th", {}, "Show"), dom.el("th", {}, "Blot"), dom.el("th", {}, "Lane labels"),
            dom.el("th", {}, "Cropped ", dom.toggle(null, null, state.blots.every((b) => b.session.figure.crop_on), "panel-crop-all",
              (v) => state.blots.forEach((b) => app.setFigureCrop(b, v)),
              "All blots: only the selected area, or the whole image.")),
            dom.el("th", {}, "")),
          state.blots.map((b) => dom.el("tr", { "data-t": "panel-row" },
            dom.el("td", {}, dom.el("input", { type: "checkbox", checked: b.include, "data-t": "panel-include",
              onchange: (ev) => { b.include = ev.target.checked; restyle(); } })),
            dom.el("td", {}, b.name),
            dom.el("td", {}, dom.el("input", { type: "checkbox", checked: b.labels, "data-t": "panel-labels",
              onchange: (ev) => { b.labels = ev.target.checked; restyle(); } })),
            dom.el("td", {}, dom.toggle(null, null, b.session.figure.crop_on, "panel-crop", (v) => app.setFigureCrop(b, v),
              "Only the selected area of this blot, or the whole image.")),
            dom.el("td", {},
              dom.icon("up", "panel-up", () => app.moveBlot(b.id, -1), "Move up", "small"),
              dom.icon("down", "panel-down", () => app.moveBlot(b.id, 1), "Move down", "small"))))),
        dom.row("Gap", dom.number(style.gap_mm, { t: "gap", min: 0, max: 50, step: 0.5 }, (v) => { style.gap_mm = v; restyle(); }), "mm")),
      dom.group("Style",
        dom.el("p", { class: "hint" }, "For all panels of the figure."),
        dom.row("Labels", dom.select([["plain", "Plain"], ["table", "Table"]], style.label_style, "label-style",
          (v) => { style.label_style = v; restyle(); })),
        dom.row("Rotate top text row", dom.select([["0", "0°"], ["45", "45°"], ["90", "90°"]], String(style.label_rotation), "label-rotation",
          (v) => { style.label_rotation = Number(v); restyle(); })),
        dom.row("MW unit", dom.text(style.mw_unit, "mw-unit", (v) => { style.mw_unit = v; restyle(); }, { class: "cell wide", placeholder: "e.g.  kDa" }),
          dom.select([["each", "after each label"], ["top", "once, above"]], style.mw_unit_position, "mw-unit-position",
            (v) => { style.mw_unit_position = v; restyle(); })),
        dom.row("Font size", dom.number(style.font_size, { t: "font-size", min: 4, max: 30, step: 0.5 }, (v) => { style.font_size = v; restyle(); }), "pt"),
        dom.row("Gel width", dom.number(style.gel_width_mm, { t: "gel-width", min: 10, max: 300, step: 1 }, (v) => { style.gel_width_mm = v; app.changed("figure", "panel"); }), "mm"),
        dom.row("Line width", dom.number(Math.round(style.line_width_mm * 1000) / 1000, { t: "line-width", min: 0.05, max: 2, step: 0.05 },
          (v) => { style.line_width_mm = v; restyle(); }), "mm"),
        dom.row(null, dom.check("Decrowd labels", style.decrowd, "decrowd", (v) => { style.decrowd = v; restyle(); },
          "Where MW or band labels on one side of a gel would overlap, write them further out, each with a longer line.")),
        dom.row("PNG resolution",
          dom.select([["1", "Lossless (image pixels)"], ["0", "Custom dpi"]], style.lossless ? "1" : "0", "resolution",
            (v) => { style.lossless = v === "1"; app.changed("figure", "panel"); }),
          dom.number(style.dpi, { t: "dpi", min: 72, max: 2400, step: 1, disabled: style.lossless }, (v) => { style.dpi = v; restyle(); })),
        built && style.lossless ? dom.el("p", { class: "hint" }, `Lossless is ${Math.round(built.nativeDpi)} dpi at this gel width.`) : null),
      dom.group("Export",
        dom.row(null,
          dom.primary([WB.icon("download"), "SVG"], "export-svg", figurepanel.exportSvg, "Vector file with the gel's own pixels embedded and editable text."),
          dom.button("PNG", "export-png", figurepanel.exportPng),
          dom.button("Print / PDF", "export-print", figurepanel.print, "Opens the print dialog; choose “Save as PDF”."))),
    ];
  };
})();
