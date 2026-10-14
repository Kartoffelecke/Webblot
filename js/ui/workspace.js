// The workspace: every blot as a card with its image, drawn shapes and exposure
// controls, all visible at the same time.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, processing, lanes, num } = WB;
  const workspace = (WB.workspace = {});

  const COLORS = {
    lane: "#ffd400",
    current: "#ff7a00",
    peak: "#ffd400",
    unused: "#9a9a9a",
    roi: "#00c8ff",
    figure: "#00d26a",
    background: "#5ce1e6",
    mw: "#00b7ff",
    band: "#ff3df2",
    draw: "#ff4040",
  };

  // [y, x] in image coordinates of a pointer event over a card's overlay
  workspace.toImage = function (svg, event) {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [p.y, p.x];
  };

  // Follow the pointer until it is released.
  workspace.drag = function (event, svg, onMove, onEnd) {
    event.preventDefault();
    event.stopPropagation();
    const start = workspace.toImage(svg, event);
    const move = (e) => onMove(workspace.toImage(svg, e), start, e);
    const up = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (onEnd) onEnd(workspace.toImage(svg, e), start, e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------------- canvas

  // The blot, merged with its brightfield image if it has one. The brightfield
  // is shown with the same polarity as the blot (bright marker bands next to
  // bright blot bands, or dark next to dark), each with its own exposure.
  function drawCanvas(blot, canvas) {
    const { wb, bf } = blot.work;
    const t = blot.session.transform;
    canvas.width = wb.w;
    canvas.height = wb.h;
    const gray = processing.compose(wb, t.bf_show ? bf : null, t);
    const image = new ImageData(wb.w, wb.h);
    const out = image.data;
    for (let i = 0; i < gray.length; i++) {
      out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = gray[i];
      out[4 * i + 3] = 255;
    }
    canvas.getContext("2d").putImageData(image, 0, 0);
  }

  // --------------------------------------------------------------------- zoom

  const ZOOM_STEP = 1.5;

  // at most so far in that 8 image pixels fill the width of the card
  const maxZoom = (blot) => Math.max(blot.work.wb.w / 8, 1);

  // Lay out a card for its blot's view: the canvas is enlarged and shifted
  // inside the stage, which cuts off the rest; the overlay shows the same part.
  function applyView(blot, node) {
    const { w, h } = blot.work.wb;
    const { zoom, x, y } = blot.view;
    const { canvas, svg } = node._blot;
    const stage = canvas.parentNode;
    stage.style.aspectRatio = `${w} / ${h}`;
    stage.classList.toggle("zoomed", zoom > 1);
    canvas.style.width = `${zoom * 100}%`;
    canvas.style.left = `${(-x / w) * zoom * 100}%`;
    canvas.style.top = `${(-y / h) * zoom * 100}%`;
    svg.setAttribute("viewBox", `${x - 0.5} ${y - 0.5} ${w / zoom} ${h / zoom}`);
    const reset = node.querySelector("[data-t=zoom-reset]");
    reset.textContent = `${Math.round(zoom * 100)}%`;
    reset.disabled = zoom === 1;
    node.querySelector("[data-t=zoom-out]").disabled = zoom === 1;
    node.querySelector("[data-t=zoom-in]").disabled = zoom >= maxZoom(blot);
  }

  // Show another part of a blot: `zoom` is the magnification, (x, y) the image
  // pixel in the top left corner of the card. The view stays inside the image.
  function setView(blot, zoom, x, y) {
    const { w, h } = blot.work.wb;
    zoom = num.clip(zoom, 1, maxZoom(blot));
    if (zoom < 1.01) zoom = 1;
    blot.view = { zoom, x: num.clip(x, 0, w - w / zoom), y: num.clip(y, 0, h - h / zoom) };
    const node = cards.get(blot.id);
    if (!node) return;
    applyView(blot, node);
    drawOverlay(blot, node._blot.svg);
  }

  // Magnify by `factor`, keeping the image point [y, x] where it is on the
  // screen (the centre of the view if no point is given).
  workspace.zoom = function (blot, factor, point = null) {
    const { w, h } = blot.work.wb;
    const { zoom: old, x, y } = blot.view;
    const [py, px] = point || [y + h / old / 2, x + w / old / 2];
    const zoom = num.clip(old * factor, 1, maxZoom(blot));
    setView(blot, zoom, px - ((px - x) * old) / zoom, py - ((py - y) * old) / zoom);
  };

  workspace.resetZoom = (blot) => setView(blot, 1, 0, 0);

  // Move the view by a distance on the screen; false if it was at the edge already.
  function panBy(blot, svg, dx, dy) {
    const { zoom, x, y } = blot.view;
    const perPixel = blot.work.wb.w / zoom / svg.getBoundingClientRect().width;
    setView(blot, zoom, x + dx * perPixel, y + dy * perPixel);
    return blot.view.x !== x || blot.view.y !== y;
  }

  // Ctrl or ⌘ + wheel (and pinching on a trackpad) zooms at the pointer. On a
  // zoomed blot the wheel alone moves the view, until it reaches the edge.
  function onWheel(blot, svg, event) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const [py, px] = workspace.toImage(svg, event);
      const { w, h } = blot.work.wb;
      workspace.zoom(blot, Math.exp(-num.clip(event.deltaY, -30, 30) * 0.01),
        [num.clip(py, -0.5, h - 0.5), num.clip(px, -0.5, w - 0.5)]);
    } else if (blot.view.zoom > 1) {
      const scale = event.deltaMode === 1 ? 16 : 1; // lines or pixels
      if (panBy(blot, svg, event.deltaX * scale, event.deltaY * scale)) event.preventDefault();
    }
  }

  // Dragging the image itself, not a shape on it, moves the view of a zoomed blot.
  function startPan(blot, svg, event) {
    event.preventDefault();
    let last = [event.clientX, event.clientY];
    const move = (e) => {
      panBy(blot, svg, last[0] - e.clientX, last[1] - e.clientY);
      last = [e.clientX, e.clientY];
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      svg.classList.remove("panning");
    };
    svg.classList.add("panning");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ------------------------------------------------------------------ overlay

  // The shape being drawn with a tool right now: { blotId, tool, start, end }.
  // It is part of what the overlay draws, so it survives redraws.
  let drawing = null;

  const pointsAttr = (poly) => poly.map(([y, x]) => `${x},${y}`).join(" ");

  function figureBox(blot) {
    const { w, h } = blot.work.wb;
    const fig = blot.session.figure;
    return (fig.crop_on && fig.crop) || [-0.5, -0.5, h - 0.5, w - 0.5];
  }
  workspace.figureBox = figureBox;

  function drawOverlay(blot, svg) {
    const { w } = blot.work.wb;
    svg.replaceChildren();
    const px = w / blot.view.zoom / state.cardWidth; // image pixels per screen pixel
    const isSelected = blot.id === state.selected;
    const add = (tag, attrs, ...kids) => {
      const node = dom.svg(tag, { "vector-effect": "non-scaling-stroke", ...attrs }, ...kids);
      svg.append(node);
      return node;
    };
    const handle = (y, x, t, cursor, onDown) =>
      add("circle", {
        cx: x,
        cy: y,
        r: 5 * px,
        class: "handle",
        "data-t": t,
        style: `cursor:${cursor}`,
        // while a tool is active, a press starts a new drawing instead
        onpointerdown: (ev) => { if (!state.tool) onDown(ev); },
      });
    const redraw = () => drawOverlay(blot, svg);

    // A rectangle [y0, x0, y1, x1] that can be moved and resized by its corners.
    const editableRect = (get, set, { t, color, dash, done }) => {
      const [y0, x0, y1, x1] = get();
      add("rect", {
        x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
        class: "shape", "data-t": t, stroke: color, "stroke-width": 2, "stroke-dasharray": dash,
        style: "cursor:move",
        onpointerdown: (ev) => {
          if (state.tool) return;
          app.select(blot.id);
          const origin = get().slice();
          workspace.drag(ev, svg, ([y, x], [sy, sx]) => {
            set([origin[0] + y - sy, origin[1] + x - sx, origin[2] + y - sy, origin[3] + x - sx]);
            redraw();
          }, done);
        },
      });
      [[0, 1], [0, 3], [2, 1], [2, 3]].forEach(([yi, xi]) =>
        handle(get()[yi], get()[xi], `${t}-corner`, "nwse-resize", (ev) => {
          app.select(blot.id);
          workspace.drag(ev, svg, ([y, x]) => {
            const box = get().slice();
            box[yi] = y;
            box[xi] = x;
            set(box);
            redraw();
          }, () => {
            const c = get();
            set([Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])]);
            done();
          });
        }));
    };

    // gel area for lane detection
    if (blot.roi && state.tab === "lanes") {
      const [y0, x0, y1, x1] = blot.roi;
      add("rect", {
        x: x0, y: y0, width: x1 - x0, height: y1 - y0,
        class: "shape", stroke: COLORS.roi, "stroke-dasharray": "6 4", "data-t": "roi",
      });
    }

    // lanes
    const list = blot.session.lanes;
    list.forEach((lane, i) => {
      const current = isSelected && i === state.lane;
      const poly = lanes.polygon(lane);
      add("polygon", {
        points: pointsAttr(poly),
        class: "shape lane",
        "data-t": "lane",
        "data-index": i,
        stroke: current ? COLORS.current : COLORS.lane,
        "stroke-width": current ? 2 : 1.2,
        onpointerdown: (ev) => {
          if (state.tool) return;
          app.select(blot.id, i);
          const origin = { x: lane.x_center, y0: lane.y0, y1: lane.y1 };
          workspace.drag(
            ev, svg,
            ([y, x], [sy, sx]) => {
              lane.x_center = origin.x + (x - sx);
              lane.y0 = origin.y0 + (y - sy);
              lane.y1 = origin.y1 + (y - sy);
              redraw();
            },
            () => {
              app.sortLanes(blot);
              app.changed("lanes");
            }
          );
        },
      });
      add("text", {
        x: poly[0][1] + 3 * px, y: poly[0][0] + 13 * px, "font-size": 12 * px, // inside the lane's top corner
        fill: current ? COLORS.current : COLORS.lane, class: "note",
      }, i + 1);

      // peak borders, display only
      const hw = 0.5 * lane.width;
      for (const peak of lane.peaks) {
        for (const pos of [peak.start, peak.end]) {
          const a = lanes.point(lane, pos, -hw);
          const b = lanes.point(lane, pos, hw);
          add("line", {
            x1: a[1], y1: a[0], x2: b[1], y2: b[0], class: "note", "data-t": "peak-mark",
            stroke: peak.quantify ? COLORS.peak : COLORS.unused, "stroke-width": 1,
          });
        }
      }

      // the current lane is adjusted where lanes are marked and where they are measured
      if (current && (state.tab === "lanes" || state.tab === "quantify")) {
        const len = lanes.length(lane);
        const top = lanes.point(lane, 0);
        const bottom = lanes.point(lane, len);
        const right = lanes.point(lane, len / 2, hw);
        const knob = lanes.point(lane, -18 * px);
        add("line", { x1: top[1], y1: top[0], x2: knob[1], y2: knob[0], stroke: COLORS.current, class: "note" });
        const finish = () => app.changed("lanes");
        handle(top[0], top[1], "handle-lane-top", "ns-resize", (ev) =>
          workspace.drag(ev, svg, ([y]) => {
            app.setLaneTop(lane, Math.min(y, lane.y1 - 4));
            redraw();
          }, finish));
        handle(bottom[0], bottom[1], "handle-lane-bottom", "ns-resize", (ev) =>
          workspace.drag(ev, svg, ([y]) => {
            lane.y1 = Math.max(y, lane.y0 + 4);
            redraw();
          }, finish));
        handle(right[0], right[1], "handle-lane-width", "ew-resize", (ev) =>
          workspace.drag(ev, svg, ([, x]) => {
            lane.width = Math.max(2 * Math.abs(x - lane.x_center), 2);
            redraw();
          }, finish));
        handle(knob[0], knob[1], "handle-lane-tilt", "grab", (ev) =>
          workspace.drag(ev, svg, ([y, x]) => {
            // the knob sits above the lane: tilt follows the line from it to the centre
            const angle = (Math.atan2(lane.x_center - x, lanes.yCenter(lane) - y) * 180) / Math.PI;
            lane.tilt_deg = num.clip(angle, -30, 30);
            redraw();
          }, finish));
      }
    });

    // the empty area that gives the lanes their flat background (over the
    // lanes, so that it can be grabbed where it overlaps one)
    if (blot.bgArea && state.tab === "quantify") {
      editableRect(() => blot.bgArea, (box) => (blot.bgArea = box), {
        t: "bg-area", color: COLORS.background, dash: "4 3", done: () => app.setBackgroundArea(blot, blot.bgArea),
      });
      const [y0, x0, y1, x1] = blot.bgArea;
      add("text", {
        x: Math.min(x0, x1) + 3 * px, y: Math.min(y0, y1) - 4 * px, "font-size": 11 * px,
        fill: COLORS.background, class: "note marker-text",
      }, "background");
    }

    // figure area and markers
    const fig = blot.session.figure;
    if (state.tab === "figure") {
      const [y0, , y1] = figureBox(blot);
      if (fig.crop && fig.crop_on)
        editableRect(() => fig.crop, (box) => (fig.crop = box), {
          t: "figure-area", color: COLORS.figure, done: () => app.changed("figure"),
        });
      else if (fig.crop) {
        // switched off: where the area was, in case it is switched on again
        const [cy0, cx0, cy1, cx1] = fig.crop;
        add("rect", {
          x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0, class: "note", "data-t": "figure-area-off",
          fill: "rgba(140, 140, 140, 0.18)", stroke: "#9a9a9a", "stroke-width": 1.5, "stroke-dasharray": "5 4", opacity: 0.7,
        });
      }
      // Markers are shown at the side of the card (of the view, on a zoomed
      // blot) with a thin line across it, and can be grabbed anywhere along
      // that line. Only their height matters; in the figure they stand beside
      // the figure area.
      const viewLeft = blot.view.x - 0.5;
      const viewRight = viewLeft + w / blot.view.zoom;
      const markerSet = (markers, side, color, t) => {
        const edge = side === "left" ? viewLeft : viewRight;
        const dir = side === "left" ? 1 : -1;
        markers.forEach((m, k) => {
          const opacity = m.y >= y0 && m.y <= y1 ? 1 : 0.4; // outside the figure area
          add("line", {
            x1: viewLeft, y1: m.y, x2: viewRight, y2: m.y, class: "note", "data-t": `${t}-guide`,
            stroke: color, "stroke-width": 1, "stroke-dasharray": "2 5", opacity: 0.6 * opacity,
          });
          add("line", {
            x1: edge, y1: m.y, x2: edge + dir * 16 * px, y2: m.y, class: "note", "data-t": `${t}-tick`,
            stroke: color, "stroke-width": 3, opacity,
          });
          add("text", {
            x: edge + dir * 20 * px, y: m.y - 4 * px, "font-size": 12 * px, fill: color, opacity,
            class: "note marker-text", "text-anchor": side === "left" ? "start" : "end",
          }, m.text);
          // a wide invisible line to grab
          add("line", {
            x1: viewLeft, y1: m.y, x2: viewRight, y2: m.y, "data-t": t, "data-index": k,
            stroke: "transparent", "stroke-width": 12, style: "cursor:ns-resize",
            onpointerdown: (ev) => {
              if (state.tool) return;
              app.select(blot.id);
              workspace.drag(ev, svg, ([y]) => {
                m.y = y;
                redraw();
              }, () => {
                markers.sort((a, b) => a.y - b.y);
                app.changed("figure", "panel");
              });
            },
          });
        });
      };
      markerSet(fig.mw_markers, fig.mw_side, COLORS.mw, "mw-marker");
      markerSet(fig.band_markers, fig.band_side, COLORS.band, "band-marker");
      // the corners of the figure area stay on top of the markers
      svg.querySelectorAll("[data-t=figure-area-corner]").forEach((corner) => svg.append(corner));
    }
  
    // shapes drawn in the Prepare step, waiting to be applied
    if (state.tab === "prepare") {
      const pending = blot.pending;
      const shapeMoved = () => app.changed("tool");
      if (pending.crop)
        editableRect(() => pending.crop, (box) => (pending.crop = box), {
          t: "crop-shape", color: COLORS.draw, dash: "6 4", done: shapeMoved,
        });
      if (pending.level) {
        const [[ya, xa], [yb, xb]] = pending.level;
        add("line", {
          x1: xa, y1: ya, x2: xb, y2: yb, class: "note", "data-t": "level-shape",
          stroke: COLORS.draw, "stroke-width": 2,
        });
        [0, 1].forEach((end) =>
          handle(pending.level[end][0], pending.level[end][1], "level-end", "move", (ev) => {
            app.select(blot.id);
            workspace.drag(ev, svg, (point) => {
              pending.level[end] = point;
              redraw();
            }, shapeMoved);
          }));
      }
    }

    // the shape being drawn right now
    if (drawing && drawing.blotId === blot.id) {
      const [sy, sx] = drawing.start;
      const [y, x] = drawing.end;
      if (drawing.tool === "level")
        add("line", { x1: sx, y1: sy, x2: x, y2: y, class: "note", "data-t": "drawing", stroke: COLORS.draw, "stroke-width": 2 });
      else
        add("rect", {
          x: Math.min(x, sx), y: Math.min(y, sy), width: Math.abs(x - sx), height: Math.abs(y - sy),
          class: "shape note", "data-t": "drawing", stroke: COLORS.draw, "stroke-width": 2, "stroke-dasharray": "6 4",
        });
    }
  }

  // Drawing a rectangle or a line with the active tool.
  function startTool(blot, svg, event) {
    const tool = state.tool;
    app.select(blot.id);
    const start = workspace.toImage(svg, event);
    drawing = { blotId: blot.id, tool, start, end: start };
    workspace.drag(event, svg, (point) => {
      drawing.end = point;
      drawOverlay(blot, svg);
    }, ([y, x], [sy, sx]) => {
      drawing = null;
      state.tool = null;
      const box = [Math.min(y, sy), Math.min(x, sx), Math.max(y, sy), Math.max(x, sx)];
      const big = Math.abs(y - sy) + Math.abs(x - sx) > 4;
      if (big) workspace.finishTool(tool, blot, box, [[sy, sx], [y, x]]);
      app.changed("tool", "panel");
    });
  }

  // What a finished drawing leaves behind. Boxes are in overlay coordinates
  // (pixel edges at .5). Crop and straighten only leave a shape, which can be
  // adjusted and is applied from the Prepare panel.
  workspace.finishTool = function (tool, blot, box, line) {
    if (tool === "crop") {
      blot.pending.crop = box;
    } else if (tool === "level") {
      blot.pending.level = line;
    } else if (tool === "roi") {
      blot.roi = box;
      app.changed("lanes");
    } else if (tool === "bgarea") {
      app.setBackgroundArea(blot, box);
    }
  };

  // The drawn area becomes a blot of its own; this blot and the rectangle stay,
  // so that the next area can be taken from the same image.
  workspace.newFromCrop = function (blot) {
    if (!blot.pending.crop) return;
    app.newFromCrop(blot, blot.pending.crop.map((v) => v + 0.5));
  };

  workspace.applyCrop = function (blot) {
    if (!blot.pending.crop) return;
    // shape coordinates are pixel edges - 0.5
    app.setCrop(blot, blot.pending.crop.map((v) => v + 0.5));
    app.changed("panel");
  };

  // Rotate so that the drawn line becomes horizontal or vertical, whichever is nearer.
  workspace.straighten = function (blot) {
    if (!blot.pending.level) return;
    const [start, end] = blot.pending.level;
    const delta = processing.levelingAngle(start, end);
    const angle = ((blot.session.transform.rotation_deg + delta + 180) % 360 + 360) % 360 - 180;
    app.setRotation(blot, Math.round(angle * 100) / 100, true); // a cropped blot stays cropped
    app.changed("panel");
  };

  workspace.discard = function (blot, what) {
    blot.pending[what] = null;
    app.changed("tool", "panel");
  };

  // -------------------------------------------------------------------- cards

  // One row of min / max / gamma / Auto. `keys` name the fields of the blot's
  // transform that the row edits; `prefix` distinguishes the rows for the tests.
  function exposureRow(blot, label, prefix, keys, image, range, autoHigh) {
    const t = blot.session.transform;
    const [lo, hi] = range;
    const step = (hi - lo) / 1000 || 1;
    const set = (index, value) => {
      const limits = t[keys.limits].slice();
      limits[index] = value;
      if (limits[1] <= limits[0]) limits[1 - index] = index ? value - step : value + step;
      t[keys.limits] = limits;
      app.changed("display");
    };
    const slider = (index, name) =>
      dom.el("input", {
        type: "range", min: lo, max: hi, step, value: t[keys.limits][index], "data-t": prefix + name,
        oninput: (ev) => set(index, parseFloat(ev.target.value)),
      });
    return dom.el("div", { class: "exposure", "data-t": `${prefix}exposure` },
      dom.el("span", { class: "exposure-label" }, label),
      dom.el("label", {}, "min", slider(0, "min")),
      dom.el("label", {}, "max", slider(1, "max")),
      dom.el("label", {}, "γ", dom.number(t[keys.gamma], { t: `${prefix}gamma`, min: 0.1, max: 5, step: 0.05, width: 52 }, (v) => {
        t[keys.gamma] = v;
        app.changed("display");
      })),
      dom.button("Auto", `${prefix}auto`, () => {
        t[keys.limits] = processing.autoContrast(image, 0.5, autoHigh);
        app.changed("display", "exposure");
      }, "Set min and max from the image"));
  }

  // Exposure of the blot and, if it has one, of its brightfield image.
  function exposureControls(blot) {
    const t = blot.session.transform;
    const { wb, bf, range, bfRange } = blot.work;
    const rows = [exposureRow(blot, bf ? "Blot" : "", "", { limits: "contrast_limits", gamma: "gamma" }, wb, range, 99.8)];
    rows[0].append(dom.check("Invert", t.invert_lut, "invert", (v) => {
      t.invert_lut = v;
      app.changed("display");
    }, "Invert the display only; measured values do not change"));
    if (bf)
      rows.push(exposureRow(blot, "Brightfield", "bf-", { limits: "bf_contrast_limits", gamma: "bf_gamma" }, bf, bfRange, 99.5));
    return dom.el("div", { class: "card-controls" }, rows);
  }

  const DRAG_TYPE = "application/x-webblot-blot";

  function card(blot) {
    const canvas = dom.el("canvas", {});
    const svg = dom.svg("svg", { class: "overlay", "data-t": "overlay", preserveAspectRatio: "none" });
    svg.addEventListener("pointerdown", (ev) => {
      if (state.tool) startTool(blot, svg, ev);
      else if (ev.target === svg && blot.view.zoom > 1 && ev.button === 0) startPan(blot, svg, ev);
    });
    svg.addEventListener("wheel", (ev) => onWheel(blot, svg, ev), { passive: false });
    const node = dom.el("div", {
        class: "card", "data-t": "card", "data-id": blot.id,
        onpointerdown: () => { if (state.selected !== blot.id) app.select(blot.id); },
      },
      dom.el("div", { class: "card-head" },
        dom.el("span", {
          class: "grip", "data-t": "blot-grip", draggable: "true",
          title: "Drag beside another blot to change the order, or onto another blot's image to use this one as its brightfield",
          ondragstart: (ev) => {
            ev.dataTransfer.setData(DRAG_TYPE, String(blot.id));
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setDragImage(node, 20, 20);
          },
        }, WB.icon("grip")),
        dom.text(blot.name, "blot-name", (v) => {
          blot.name = v.trim() || blot.name;
          app.changed("panel");
        }, { class: "name" }),
        dom.el("span", { class: "dim", "data-t": "dim" }),
        dom.el("span", { class: "zoom" },
          dom.icon("minus", "zoom-out", () => workspace.zoom(blot, 1 / ZOOM_STEP), "Zoom out"),
          dom.button("100%", "zoom-reset", () => workspace.resetZoom(blot), "Show the whole blot again"),
          dom.icon("plus", "zoom-in", () => workspace.zoom(blot, ZOOM_STEP),
            "Zoom in. Also: Ctrl or ⌘ + wheel, or pinch, zooms at the pointer; on a zoomed blot the wheel, or dragging the image, moves it.")),
        dom.icon("up", "blot-up", () => app.moveBlot(blot.id, -1), "Move up in the figure"),
        dom.icon("down", "blot-down", () => app.moveBlot(blot.id, 1), "Move down in the figure"),
        dom.icon("close", "blot-remove", () => {
          // no question: the blot can be brought back
          const index = state.blots.indexOf(blot);
          const labels = state.blots.map((b) => [b, b.labels]);
          app.removeBlot(blot.id);
          WB.feedback.toast(`Removed “${blot.name}”.`, { action: { label: "Undo", run: () => app.restoreBlot(blot, index, labels) } });
        }, "Remove this blot")),
      dom.el("div", { class: "stage" }, canvas, svg),
      exposureControls(blot));
    node._blot = { canvas, svg };
    // A blot dragged here: onto the image it becomes this blot's brightfield;
    // anywhere else on the card it is put before or after this blot.
    const carriesBlot = (ev) => ev.dataTransfer && [...ev.dataTransfer.types].includes(DRAG_TYPE);
    const stage = node.querySelector(".stage");
    const dropKind = (ev) => {
      if (stage.contains(ev.target)) return "merge";
      const r = node.getBoundingClientRect();
      return ev.clientX < r.left + r.width / 2 ? "before" : "after";
    };
    const clearDrop = () => node.classList.remove("drop-merge", "drop-before", "drop-after");
    node.addEventListener("dragover", (ev) => {
      if (!carriesBlot(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      clearDrop();
      node.classList.add(`drop-${dropKind(ev)}`);
    });
    node.addEventListener("dragleave", (ev) => {
      if (!node.contains(ev.relatedTarget)) clearDrop();
    });
    node.addEventListener("drop", (ev) => {
      clearDrop();
      if (!carriesBlot(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const sourceId = Number(ev.dataTransfer.getData(DRAG_TYPE));
      const kind = dropKind(ev);
      if (kind === "merge") app.mergeAsBrightfield(sourceId, blot.id);
      else app.moveBlotTo(sourceId, blot.id, kind === "after");
    });
    return node;
  }

  // What an empty page shows: the three ways to begin.
  function welcome() {
    const press = (t) => () => document.querySelector(`[data-t=${t}]`).click();
    return dom.el("div", { class: "welcome", "data-t": "welcome" },
      dom.el("h1", {}, "Analyse a western blot"),
      dom.el("p", {}, "Drop blot images anywhere on this page, or start with one of these. Images stay on this computer."),
      dom.el("div", { class: "choices" },
        dom.primary([WB.icon("image"), "Add blot images…"], "welcome-add", press("add-files"), "16-bit TIFF, PNG or JPEG; several at once."),
        dom.button("Try the sample blot", "welcome-sample", () => app.addSample(), "A made-up blot with eight lanes, to see how it works."),
        dom.button([WB.icon("folder"), "Open a downloaded folder…"], "welcome-open", press("open-project"), "A zip file made by Download folder.")),
      dom.el("p", { class: "steps-preview" }, "Then: prepare the image, mark the lanes, measure the bands, build the figure."));
  }

  const cards = new Map(); // blot id -> card element

  function render(kinds) {
    const root = document.getElementById("workspace");
    if (!root) return;
    root.style.display = state.hideBlots ? "none" : "";
    if (kinds.has("blots")) {
      cards.clear();
      root.replaceChildren(...state.blots.map((blot) => {
        const node = card(blot);
        cards.set(blot.id, node);
        return node;
      }));
      if (!state.blots.length) root.append(welcome());
    }
    const redrawImages = ["blots", "image", "display", "exposure"].some((k) => kinds.has(k));
    for (const blot of state.blots) {
      const node = cards.get(blot.id);
      if (!node) continue;
      node.classList.toggle("selected", blot.id === state.selected);
      node.classList.toggle("drawing", !!state.tool);
      node.querySelector(".stage").style.width = `${state.cardWidth}px`;
      const { wb } = blot.work;
      const t = blot.session.transform;
      node.querySelector("[data-t=dim]").textContent =
        `${wb.w} × ${wb.h}${t.crop ? ", cropped" : ""}${t.rotation_deg ? `, ${t.rotation_deg}°` : ""}` +
        (blot.raw.bf ? `, + ${blot.bfOrigin ? blot.bfOrigin.name : "brightfield"}` : "");
      if (redrawImages) drawCanvas(blot, node._blot.canvas);
      applyView(blot, node);
      if ((kinds.has("image") || kinds.has("exposure")) && !kinds.has("blots")) {
        // the value range or the limits changed: rebuild the sliders
        node.querySelector(".card-controls").replaceWith(exposureControls(blot));
      }
      drawOverlay(blot, node._blot.svg);
    }
  }
  app.views.push(render);

  // Delete removes the current lane while the Lanes tab is open.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      const selected = app.blot();
      if (state.tool) state.tool = null; // stop drawing
      else if (selected) selected.pending = { crop: null, level: null }; // discard what was drawn
      app.changed("tool", "panel");
    }
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const blot = app.blot();
    if (state.tab !== "lanes" || !blot || !blot.session.lanes[state.lane]) return;
    WB.panels.deleteLane(blot);
    ev.preventDefault();
  });
})();
