// The project being worked on, and the operations that change it.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { model, processing, lanes, quant, num } = WB;

  const state = (WB.state = {
    project: model.project(),
    blots: [], // in the order of the figure's panels, top first
    selected: null, // id of the blot the side panel works on
    lane: 0, // current lane of the selected blot
    style: model.style(),
    tab: "prepare",
    tool: null, // "crop" | "level" | "roi" while drawing on a card
    cardWidth: 420,
    hideBlots: false,
    normalize: false, // report each band relative to its largest area among the lanes
  });
  const app = (WB.app = { views: [] });
  let nextId = 1;

  // ---------------------------------------------------------------- rendering

  const pending = new Set();
  let scheduled = false;

  // Report what changed; the views redraw once per frame.
  // kinds: blots, select, image, display, lanes, quant, figure, panel, tool
  app.changed = function (...kinds) {
    kinds.forEach((k) => pending.add(k));
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(app.flush);
    }
  };

  app.flush = function () {
    scheduled = false;
    if (!pending.size) return;
    const kinds = new Set(pending);
    pending.clear();
    for (const view of app.views) view(kinds);
  };

  // -------------------------------------------------------------------- blots

  app.blot = (id = state.selected) => state.blots.find((b) => b.id === id) || null;

  // What a blot was before it became another blot's brightfield, so that the
  // two can be split again: { name, session, include, labels, roi, bf, bfOrigin }.
  const origin = (fields = {}) => ({
    name: "Brightfield",
    session: model.session(),
    include: true,
    labels: false,
    roi: null,
    bf: null, // the brightfield that this blot had itself
    bfOrigin: null,
    ...fields,
  });
  app.origin = origin;

  function makeBlot(name, wb, bf, saved) {
    return {
      id: nextId++,
      name,
      // the blot, and optionally a brightfield image of the same membrane
      // (with the visible marker) that is shown merged with it
      raw: { wb, bf },
      session: saved ? saved.session : model.session(),
      include: saved ? saved.include : true,
      labels: saved ? saved.labels : !state.blots.length, // lane labels go above the top panel
      roi: saved ? saved.roi : null, // gel area for lane detection [y0, x0, y1, x1]
      bfOrigin: saved ? saved.bfOrigin || null : null,
      // shapes drawn on the card that are not applied yet: a crop rectangle
      // [y0, x0, y1, x1] and a line to straighten along [[y, x], [y, x]]
      pending: { crop: null, level: null },
      // the part of the image the card shows: magnification and the image
      // pixel in its top left corner. Not saved with the project.
      view: { zoom: 1, x: 0, y: 0 },
      work: null,
      cache: null,
    };
  }

  app.addBlot = function (name, wb, bf = null, saved = null) {
    const blot = makeBlot(name, wb, bf, saved);
    state.blots.push(blot);
    app.rework(blot);
    state.selected = blot.id;
    state.lane = 0;
    app.changed("blots");
    return blot;
  };

  app.removeBlot = function (id) {
    const index = state.blots.findIndex((b) => b.id === id);
    if (index < 0) return;
    state.blots.splice(index, 1);
    if (state.selected === id) {
      const next = state.blots[Math.min(index, state.blots.length - 1)];
      state.selected = next ? next.id : null;
      state.lane = 0;
    }
    if (state.blots.length && !state.blots.some((b) => b.labels)) state.blots[0].labels = true;
    app.changed("blots");
  };

  // Bring back a blot that was removed, at the place it had. `labels` is which
  // blots had the lane labels before it left: [[blot, true | false]].
  app.restoreBlot = function (blot, index, labels = []) {
    if (state.blots.includes(blot)) return;
    state.blots.splice(Math.min(index, state.blots.length), 0, blot);
    for (const [other, had] of labels) other.labels = had;
    state.selected = blot.id;
    state.lane = 0;
    app.changed("blots", "panel");
  };

  // -------------------------------------------------------------- brightfield

  // Give `target` a brightfield image from a file, or take it away (null).
  app.setBrightfield = function (target, image, name) {
    target.raw.bf = image;
    target.bfOrigin = image ? origin({ name }) : null;
    const t = target.session.transform;
    t.bf_contrast_limits = null; // exposure is set for the new image
    t.bf_gamma = 1;
    t.bf_show = true;
    app.rework(target);
    app.changed("blots", "panel");
  };

  // Make blot `sourceId` the brightfield of blot `targetId`. The source leaves
  // the list of blots; everything it had is kept so that the two can be split
  // again. A brightfield the target already has becomes a blot of its own first.
  app.mergeAsBrightfield = function (sourceId, targetId) {
    const source = app.blot(sourceId);
    const target = app.blot(targetId);
    if (!source || !target || source === target) return;
    if (target.raw.bf) app.splitBrightfield(target.id);
    const was = origin({
      name: source.name,
      session: source.session,
      include: source.include,
      labels: source.labels,
      roi: source.roi,
      bf: source.raw.bf,
      bfOrigin: source.bfOrigin,
    });
    state.blots.splice(state.blots.indexOf(source), 1);
    if (!state.blots.some((b) => b.labels)) state.blots[0].labels = true;
    state.selected = target.id;
    state.lane = 0;
    app.setBrightfield(target, source.raw.wb, source.name);
    target.bfOrigin = was;
  };

  // Undo a merge: the brightfield of blot `id` becomes a blot again, right
  // after it, with the name and settings it had.
  app.splitBrightfield = function (id) {
    const target = app.blot(id);
    if (!target || !target.raw.bf) return null;
    const was = target.bfOrigin || origin({ name: `${target.name} brightfield` });
    const blot = makeBlot(was.name, target.raw.bf, was.bf, was);
    blot.labels = false; // the blots that stayed keep the lane labels
    state.blots.splice(state.blots.indexOf(target) + 1, 0, blot);
    app.setBrightfield(target, null);
    app.rework(blot);
    app.changed("blots", "panel");
    return blot;
  };

  // Put blot `id` before or after blot `targetId` in the order of the figure.
  app.moveBlotTo = function (id, targetId, after) {
    const blot = app.blot(id);
    if (!blot || id === targetId || !app.blot(targetId)) return;
    state.blots.splice(state.blots.indexOf(blot), 1);
    state.blots.splice(state.blots.findIndex((b) => b.id === targetId) + (after ? 1 : 0), 0, blot);
    app.changed("blots", "panel");
  };

  // An empty project, a new one.
  app.clear = function () {
    state.project = model.project();
    state.blots = [];
    state.selected = null;
    state.lane = 0;
    state.style = model.style();
    state.normalize = false;
    app.changed("blots");
  };

  app.select = function (id, lane = null) {
    if (state.selected !== id) {
      state.selected = id;
      state.lane = 0;
    }
    if (lane !== null) state.lane = lane;
    app.changed("select");
  };

  app.moveBlot = function (id, step) {
    const i = state.blots.findIndex((b) => b.id === id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= state.blots.length) return;
    [state.blots[i], state.blots[j]] = [state.blots[j], state.blots[i]];
    app.changed("blots");
  };

  // Recompute the rotated and cropped images of a blot.
  app.rework = function (blot) {
    const t = blot.session.transform;
    const wb = processing.applyTransform(blot.raw.wb, t);
    let bf = null;
    if (blot.raw.bf) {
      // the stored brightfield stays as it was read; a copy is fitted to the blot
      let fitted = blot.raw.bf;
      if (fitted.w !== blot.raw.wb.w || fitted.h !== blot.raw.wb.h)
        fitted = processing.resize(fitted, blot.raw.wb.w, blot.raw.wb.h);
      bf = processing.applyTransform(fitted, t);
      if (!t.bf_contrast_limits) t.bf_contrast_limits = processing.autoContrast(bf, 0.5, 99.5);
    }
    // another image size: what the card showed is no longer the same place
    if (blot.work && (blot.work.wb.w !== wb.w || blot.work.wb.h !== wb.h)) blot.view = { zoom: 1, x: 0, y: 0 };
    blot.work = { wb, bf, range: [num.min(wb.data), num.max(wb.data)] };
    blot.work.bfRange = bf ? [num.min(bf.data), num.max(bf.data)] : null;
    if (!t.contrast_limits) t.contrast_limits = processing.autoContrast(wb);
    blot.cache = { signal: null, profiles: new Map() };
    app.changed("image");
  };

  // --------------------------------------------------------------- transforms

  // Turn a blot to `angle`. The crop is in the turned image, so it is reset,
  // unless `keepCrop`: then a crop of the same size is put around the same
  // place of the image, and lanes and markers stay where they are in it. That
  // is right for a small turn such as straightening.
  app.setRotation = function (blot, angle, keepCrop = false) {
    const t = blot.session.transform;
    if (t.crop && keepCrop) {
      const { w, h } = blot.raw.wb;
      const [y0, x0, y1, x1] = t.crop;
      const centre = processing.fromRotated(w, h, t.rotation_deg, [(y0 + y1 - 1) / 2, (x0 + x1 - 1) / 2]);
      const [cy, cx] = processing.toRotated(w, h, angle, centre);
      const size = processing.rotatedSize(w, h, angle);
      // moved inside the image if it would stick out of it
      const top = num.clip(num.round(cy - (y1 - y0 - 1) / 2), 0, Math.max(size.h - (y1 - y0), 0));
      const left = num.clip(num.round(cx - (x1 - x0 - 1) / 2), 0, Math.max(size.w - (x1 - x0), 0));
      t.crop = [top, left, Math.min(top + y1 - y0, size.h), Math.min(left + x1 - x0, size.w)];
      app.changed("lanes", "figure", "quant");
    } else if (t.crop) app.setCrop(blot, null);
    t.rotation_deg = angle;
    blot.pending = { crop: null, level: null }; // drawn on the image as it was
    app.rework(blot);
  };

  // Keep lanes, markers, figure area and gel area on the same pixels after a crop.
  function shiftAnnotations(blot, dy, dx) {
    for (const lane of blot.session.lanes) {
      lane.x_center += dx;
      lane.y0 += dy;
      lane.y1 += dy;
    }
    const f = blot.session.figure;
    const shiftBox = (b) => (b ? [b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx] : null);
    f.crop = shiftBox(f.crop);
    blot.roi = shiftBox(blot.roi);
    for (const m of [...f.mw_markers, ...f.band_markers]) m.y += dy;
  }

  // Crop to `box` [y0, x0, y1, x1] (pixel indices of the current working image), or reset.
  app.setCrop = function (blot, box) {
    const t = blot.session.transform;
    let dy;
    let dx;
    if (!box) {
      if (!t.crop) return;
      [dy, dx] = t.crop;
      t.crop = null;
    } else {
      const clipped = processing.clipCrop(box, blot.work.wb.w, blot.work.wb.h);
      if (!clipped) return;
      const [oy, ox] = t.crop || [0, 0];
      t.crop = [oy + clipped[0], ox + clipped[1], oy + clipped[2], ox + clipped[3]];
      dy = -clipped[0];
      dx = -clipped[1];
    }
    shiftAnnotations(blot, dy, dx);
    blot.pending = { crop: null, level: null };
    app.rework(blot);
    app.changed("lanes", "figure", "panel");
  };

  const copyOrigin = (o) =>
    o && { ...o, session: model.copy(o.session), roi: model.copy(o.roi), bfOrigin: copyOrigin(o.bfOrigin) };

  // A new blot showing `box` [y0, x0, y1, x1] (pixel indices of the current
  // working image) of `blot`, which itself stays as it is. The new blot is what
  // cropping would have given: the same image file with the same rotation,
  // brightfield, lanes, peaks and figure settings, cropped to the box. It is
  // put after `blot` and the blots made from it before. null if the box is empty.
  app.newFromCrop = function (blot, box) {
    if (!processing.clipCrop(box, blot.work.wb.w, blot.work.wb.h)) return null;
    const names = new Set(state.blots.map((b) => b.name));
    let n = 2;
    while (names.has(`${blot.name} ${n}`)) n++;
    const created = makeBlot(`${blot.name} ${n}`, blot.raw.wb, blot.raw.bf, {
      session: model.copy(blot.session),
      include: blot.include,
      labels: false, // the blots that were there keep the lane labels
      roi: model.copy(blot.roi),
      bfOrigin: copyOrigin(blot.bfOrigin),
    });
    let at = state.blots.indexOf(blot) + 1;
    while (at < state.blots.length && state.blots[at].raw.wb === blot.raw.wb) at++;
    state.blots.splice(at, 0, created);
    app.rework(created);
    app.setCrop(created, box);
    app.changed("blots", "panel");
    return created;
  };

  // Show only the figure area of a blot in the figure, or the whole image. An
  // area that was set before comes back; the first time it is a box inside the
  // image, to be adjusted on the blot.
  app.setFigureCrop = function (blot, on) {
    const fig = blot.session.figure;
    const { w, h } = blot.work.wb;
    if (on && !fig.crop) fig.crop = [0.1 * h - 0.5, 0.1 * w - 0.5, 0.9 * h - 0.5, 0.9 * w - 0.5].map(Math.round).map((v) => v - 0.5);
    fig.crop_on = on;
    app.changed("figure", "panel");
  };

  app.copySetup = function (source, target) {
    model.copySetup(source.session, target.session);
    target.roi = model.copy(source.roi);
    app.rework(target);
    app.changed("lanes", "figure", "quant", "panel");
  };

  // ----------------------------------------------------------- quantification

  app.signal = function (blot) {
    if (!blot.cache.signal)
      blot.cache.signal = processing.signalImage(blot.work.wb, blot.session.transform.bands_dark);
    return blot.cache.signal;
  };

  // { profile, baseline } of a lane; profiles are kept until the lane or image changes
  app.curves = function (blot, lane) {
    const key = [lane.x_center, lane.y0, lane.y1, lane.width, lane.tilt_deg].join(",");
    let profile = blot.cache.profiles.get(key);
    if (!profile) {
      profile = lanes.extractProfile(app.signal(blot), lane);
      blot.cache.profiles.set(key, profile);
    }
    return { profile, baseline: quant.computeBaseline(profile, lane.baseline, lane.peaks) };
  };

  app.results = function (blot) {
    const curves = blot.session.lanes.map((lane) => app.curves(blot, lane));
    return quant.resultsTable(
      blot.session.lanes,
      curves.map((c) => c.profile),
      curves.map((c) => c.baseline)
    );
  };

  // Move a lane's top edge; peaks and anchors stay on the same image rows.
  app.setLaneTop = function (lane, y0) {
    const shift = lane.y0 - y0;
    for (const p of lane.peaks) {
      p.start += shift;
      p.end += shift;
      p.apex += shift;
    }
    lane.baseline.anchors = lane.baseline.anchors.map(([a, v]) => [a + shift, v]);
    lane.y0 = y0;
  };

  app.sortLanes = function (blot) {
    const current = blot.session.lanes[state.lane];
    blot.session.lanes.sort((a, b) => a.x_center - b.x_center);
    if (current && blot.id === state.selected) state.lane = blot.session.lanes.indexOf(current);
  };

  // Keep automatic numbering automatic; leave hand-edited numbers alone.
  app.renumberAfterEdit = function (lane, wasInOrder, newPeak = null) {
    if (wasInOrder) return quant.numberPeaks(lane);
    lane.peaks.sort((p, q) => p.apex - q.apex);
    if (newPeak) {
      const used = new Set(lane.peaks.filter((p) => p !== newPeak).map((p) => p.band_id));
      let n = 1;
      while (used.has(n)) n++;
      newPeak.band_id = n;
    }
  };

  // Add the peak under `position` of a lane's profile.
  app.addPeak = function (blot, lane, position) {
    const { profile } = app.curves(blot, lane);
    const baseline = quant.searchBaseline(profile, lane.baseline);
    const n = profile.length;
    const hw = Math.max(n / 40, 4);
    // stay clear of the peaks that are already marked
    const left = Math.max(0, ...lane.peaks.filter((p) => p.end <= position).map((p) => p.end));
    const right = Math.min(n - 1, ...lane.peaks.filter((p) => p.start >= position).map((p) => p.start));
    let peak = quant.peakAt(profile, baseline, position, { search: hw, limits: [left, right] });
    if (!peak) {
      // nothing above the background here: mark a fixed width to adjust by hand
      peak = {
        start: Math.max(position - hw, 0),
        end: Math.min(position + hw, n - 1),
        apex: position,
        band_id: 0,
        quantify: true,
      };
    }
    const inOrder = quant.isNumberedInOrder(lane);
    lane.peaks.push(peak);
    app.renumberAfterEdit(lane, inOrder, peak);
    app.changed("quant");
    return peak;
  };

  app.removePeak = function (lane, peak) {
    const inOrder = quant.isNumberedInOrder(lane);
    lane.peaks.splice(lane.peaks.indexOf(peak), 1);
    app.renumberAfterEdit(lane, inOrder);
    app.changed("quant");
  };
})();
