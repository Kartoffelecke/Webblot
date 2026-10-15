// Side panel: the Prepare and Lanes steps. (Quantify and Figure have their own files.)
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, lanes, imageio, num } = WB;
  const panels = (WB.panels = {});

  const toolButton = (label, tool, t, title) => {
    const button = dom.button(label, t, () => {
      state.tool = state.tool === tool ? null : tool;
      app.changed("tool", "panel");
    }, title);
    if (state.tool === tool) button.classList.add("active");
    return button;
  };
  panels.toolButton = toolButton;

  // a button that only works once its shape has been drawn
  const pendingButton = (label, t, shape, onClick, title) =>
    dom.el("button", { type: "button", "data-t": t, disabled: !shape, title, onclick: onClick }, label);

  const others = (blot) => state.blots.filter((b) => b !== blot);

  // ------------------------------------------------------------------ prepare

  panels.prepare = function (blot) {
    const t = blot.session.transform;
    const display = () => app.changed("display");
    const bfInput = dom.el("input", {
      type: "file", accept: "image/*,.tif,.tiff", "data-t": "bf-file",
      onchange: async () => {
        if (!bfInput.files.length) return;
        const file = bfInput.files[0];
        if (blot.raw.bf) app.splitBrightfield(blot.id); // keep the one it had, as a blot
        app.setBrightfield(blot, await imageio.readFile(file), file.name.replace(/\.[^.]+$/, ""));
      },
    });
    const copyFrom = dom.select(
      [["", "choose…"], ...others(blot).map((b) => [b.id, b.name])], "", "copy-from",
      (id) => {
        const source = app.blot(Number(id));
        if (!source) return;
        const hasPeaks = blot.session.lanes.some((l) => l.peaks.length);
        const go = hasPeaks
          ? WB.feedback.confirm("The lanes of this blot are replaced, so the peaks marked in them are removed.", "Replace lanes", { danger: true })
          : Promise.resolve(true);
        go.then((yes) => (yes ? app.copySetup(source, blot) : app.changed("panel")));
      });
    return [
      dom.group("Rotate",
        dom.row("Angle",
          dom.number(t.rotation_deg, { t: "angle", min: -180, max: 180, step: 0.1 }, (v) => {
            app.setRotation(blot, v);
            app.changed("panel");
          }), "°",
          dom.icon("turn-left", "rot-ccw", () => turn(blot, 90), "Turn 90° to the left"),
          dom.icon("turn-right", "rot-cw", () => turn(blot, -90), "Turn 90° to the right")),
        dom.row(null,
          toolButton("Draw line", "level", "tool-level",
            "Draw a line along a row of bands, or along the edge of a lane."),
          pendingButton("Straighten", "level-apply", blot.pending.level, () => WB.workspace.straighten(blot),
            "Rotate the image so that the line becomes horizontal or vertical, whichever is nearer."),
          pendingButton("Discard", "level-discard", blot.pending.level, () => WB.workspace.discard(blot, "level"))),
        blot.pending.level ? dom.el("p", { class: "hint" }, "Drag the ends of the line to adjust it, then press Straighten.") : null),
      dom.group("Crop",
        dom.row(null,
          toolButton("Draw crop", "crop", "tool-crop", "Draw a rectangle around the area to keep."),
          pendingButton("Apply crop", "crop-apply", blot.pending.crop, () => WB.workspace.applyCrop(blot)),
          pendingButton("New blot from area", "crop-new", blot.pending.crop, () => WB.workspace.newFromCrop(blot),
            "Leave this blot as it is and make the area a blot of its own, with the same rotation, brightfield and lanes."),
          pendingButton("Discard", "crop-discard", blot.pending.crop, () => WB.workspace.discard(blot, "crop")),
          dom.button("Reset crop", "crop-reset", () => app.setCrop(blot, null), "Show the whole image again.")),
        blot.pending.crop ? dom.el("p", { class: "hint" },
          "Move the rectangle or drag its corners, then press Apply crop. New blot from area keeps this blot whole and the rectangle in place, for cutting one image into several blots.") : null,
        dom.el("p", { class: "hint" }, "Straighten keeps the crop; setting the angle or turning by 90° resets it. Lanes are not rotated with the image, so straighten first.")),
      dom.group("Signal",
        dom.check("Bands are dark in the file", t.bands_dark, "bands-dark", (v) => {
          t.bands_dark = v;
          blot.cache.signal = null;
          blot.cache.profiles.clear();
          app.syncBackground(blot);
          app.changed("display", "quant");
        }, "Tick if the image file shows dark bands on a light background. Quantification then measures darkness instead of brightness.")),
      dom.group("Brightfield",
        dom.row(null, bfInput),
        blot.raw.bf ? [
          dom.row("Image", dom.el("strong", { "data-t": "bf-name" }, blot.bfOrigin ? blot.bfOrigin.name : "brightfield"),
            dom.button("Split off", "bf-split", () => app.splitBrightfield(blot.id),
              "Make the brightfield a blot of its own again, with the name and settings it had.")),
          dom.row(null,
            dom.check("Show", t.bf_show, "bf-show", (v) => { t.bf_show = v; display(); }),
            dom.button("Remove", "bf-remove", () => {
              WB.feedback.confirm("Remove the brightfield image? “Split off” keeps it as a blot of its own instead.", "Remove image", { danger: true })
                .then((yes) => yes && app.setBrightfield(blot, null));
            }, "Delete the brightfield image.")),
          dom.el("p", { class: "hint" }, "Its min, max, gamma and Invert are below the blot's, under the image."),
        ] : dom.el("p", { class: "hint" },
          "Optional image of the same membrane with the visible marker. Choose a file, or drag another blot by its handle onto this blot's image.")),
      others(blot).length ? dom.group("Copy setup",
        dom.row("From", copyFrom),
        dom.el("p", { class: "hint" }, "Copies rotation, crop, lanes, figure area and lane labels. Peaks, exposure and markers are not copied.")) : null,
    ];
  };

  function turn(blot, delta) {
    const angle = ((blot.session.transform.rotation_deg + delta + 180) % 360 + 360) % 360 - 180;
    app.setRotation(blot, angle);
    app.changed("panel");
  }

  // -------------------------------------------------------------------- lanes

  const detectOptions = { method: "signal", nLanes: 0, widthPct: 80 };
  panels.detectOptions = detectOptions;

  panels.detect = function (blot) {
    if (detectOptions.method === "even" && !detectOptions.nLanes) {
      WB.feedback.error("Set the number of lanes for evenly spaced lanes.");
      return;
    }
    const roi = blot.roi ? blot.roi.map((v) => v + 0.5) : null;
    const found = lanes.detect(app.signal(blot), {
      nLanes: detectOptions.nLanes || null,
      roi,
      widthFrac: detectOptions.widthPct / 100,
      method: detectOptions.method,
    });
    if (!found.length) {
      WB.feedback.error("No lanes found. Set the number of lanes and try again.");
      return;
    }
    blot.session.lanes = found;
    // new lanes take their line from the background area, if the blot has one
    if (blot.bgArea) {
      for (const lane of found) lane.baseline = { ...lane.baseline, method: "linear", from_area: true };
      app.syncBackground(blot);
    }
    state.lane = 0;
    app.changed("lanes", "quant", "panel");
  };

  panels.lanes = function (blot) {
    const list = blot.session.lanes;
    const lane = list[state.lane];
    const edited = () => app.changed("lanes");
    return [
      dom.group("Detect",
        dom.row("Method", dom.select([["signal", "From signal"], ["even", "Evenly spaced"]],
          detectOptions.method, "lane-method", (v) => (detectOptions.method = v))),
        dom.row("Lanes", dom.number(detectOptions.nLanes || "", { t: "lane-count", min: 0, max: 60, step: 1 },
          (v) => (detectOptions.nLanes = Math.max(Math.round(v), 0))),
          dom.el("span", { class: "hint" }, "empty = automatic")),
        dom.row("Width", dom.number(detectOptions.widthPct, { t: "lane-width-pct", min: 10, max: 100, step: 1 },
          (v) => (detectOptions.widthPct = v)), "% of spacing"),
        dom.row(null,
          toolButton("Draw gel area", "roi", "tool-roi", "Optional: restrict detection to a rectangle. Lanes span its height."),
          blot.roi ? dom.button("Clear area", "roi-clear", () => { blot.roi = null; app.changed("lanes", "panel"); }) : null),
        dom.row(null, dom.primary("Detect lanes", "detect-lanes", () => panels.detect(blot)))),
      dom.group("Edit",
        dom.row("Width (all)", dom.number(list.length ? Math.round(num.median(list.map((l) => l.width))) : "",
          { t: "lane-width", min: 2, step: 1 }, (v) => { list.forEach((l) => (l.width = v)); edited(); }), "px"),
        dom.row(`Tilt (lane ${lane ? state.lane + 1 : "–"})`, dom.number(lane ? Math.round(lane.tilt_deg * 10) / 10 : "",
          { t: "lane-tilt", min: -30, max: 30, step: 0.5, disabled: !lane }, (v) => { lane.tilt_deg = v; edited(); }), "°"),
        dom.row("Smile", dom.number("", { t: "lane-smile", min: -30, max: 30, step: 0.5 },
          (v) => { lanes.applySmile(list, v); edited(); app.changed("panel"); }), "°",
          dom.el("span", { class: "hint" }, "fans all lanes")),
        dom.row(null,
          dom.button("Add lane", "lane-add", () => addLane(blot)),
          dom.button("Delete lane", "lane-delete", () => panels.deleteLane(blot)),
          dom.button("Clear", "lane-clear", () => panels.deleteLane(blot, true)))),
      dom.el("p", { class: "hint" },
        "Click a lane on the blot to select it. Drag it to move; drag the handles to change its length, width and tilt. Lanes are numbered left to right."),
    ];
  };

  // Remove the current lane, or all of them. No question is asked: the message
  // that says what was removed can bring it back, peaks included.
  panels.deleteLane = function (blot, all = false) {
    const before = blot.session.lanes;
    const index = state.lane;
    if (!before.length || (!all && !before[index])) return;
    blot.session.lanes = all ? [] : before.filter((_, i) => i !== index);
    state.lane = Math.min(index, Math.max(blot.session.lanes.length - 1, 0));
    app.changed("lanes", "quant", "panel");
    WB.feedback.toast(all ? `Removed all ${before.length} lanes.` : `Removed lane ${index + 1}.`, {
      action: { label: "Undo", run: () => {
        blot.session.lanes = before;
        if (blot.id === state.selected) state.lane = Math.min(index, before.length - 1);
        app.changed("lanes", "quant", "panel");
      } },
    });
  };

  function addLane(blot) {
    const list = blot.session.lanes;
    const { w, h } = blot.work.wb;
    let lane;
    if (list.length) {
      const last = list[list.length - 1];
      const pitch = list.length > 1 ? last.x_center - list[list.length - 2].x_center : last.width * 1.25;
      lane = { ...WB.model.copy(last), x_center: last.x_center + pitch, peaks: [] };
    } else {
      lane = { x_center: w / 2, y0: -0.5, y1: h - 0.5, width: Math.max(w / 12, 4), tilt_deg: 0, baseline: WB.model.baseline(), peaks: [] };
    }
    list.push(lane);
    app.sortLanes(blot);
    state.lane = list.indexOf(lane);
    app.changed("lanes", "panel");
  }
})();
