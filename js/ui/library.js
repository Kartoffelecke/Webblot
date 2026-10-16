// The work folder: folders of blots and figures, written as directories a
// person can read (see README, "Files"), on disk or kept by the browser.
//
//   <Folder>/folder.json
//   <Folder>/<Blot>/blot.json, raw.tif, brightfield.tif      read by the page
//   <Folder>/<Blot>/view.png, lanes.png, areas.csv, profiles.csv   for the reader
//   <Folder>/<Figure>/figure.json                            read by the page
//   <Folder>/<Figure>/figure.svg, figure.png                 for the reader
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, model, tree, imageio, zip, processing, lanes, quant } = WB;
  const library = (WB.library = {});

  const VERSION = 1; // of blot.json, figure.json and folder.json
  const LAST = "web_blot.last"; // the folder to open again when the page is loaded
  const DELAY = 400; // ms without a change before the settings are written
  const DELAY_DERIVED = 1500; // and before the pictures and tables are

  // The name the open folder goes by: its own, or that of its first blot.
  const title = () => state.folder.name || (state.blots[0] ? state.blots[0].name : "") || "Untitled";

  const pretty = (value) => JSON.stringify(value, null, 1) + "\n";

  // Settings that must survive a reload right after they change (which folder
  // was open) are kept with the folders: localStorage is written to disk a
  // moment later, so a reload just after a change could still see the old value.
  const known_settings = new Map();
  async function remember(name, value) {
    if (known_settings.get(name) === value) return;
    known_settings.set(name, value);
    if (tree.store.kind === "none") return;
    try {
      await tree.setting(name, value);
    } catch (error) {
      // nothing is stored here
    }
  }
  async function recall(name) {
    let value = null;
    try {
      if (tree.store.kind !== "none") value = (await tree.setting(name)) ?? null;
    } catch (error) {
      value = null;
    }
    known_settings.set(name, value);
    return value;
  }
  const bufferOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  // ------------------------------------------------------------ the documents

  // A blot as its blot.json, and the images that belong to what its
  // brightfield was before (a blot that had a brightfield of its own).
  function blotDoc(blot) {
    const f = blot.session.figure;
    const images = [];
    const was = (o) => o && {
      name: o.name, session: o.session, include: o.include, labels: o.labels, roi: o.roi,
      bf: o.bf ? (images.push(o.bf), `brightfield-${images.length}.tif`) : null,
      bfOrigin: was(o.bfOrigin),
    };
    const doc = {
      app: "web_blot", kind: "blot", version: VERSION,
      name: blot.name,
      transform: blot.session.transform,
      lanes: blot.session.lanes,
      lane_labels: f.label_rows,
      mw_markers: f.mw_markers, mw_side: f.mw_side,
      band_markers: f.band_markers, band_side: f.band_side,
      gel_area: blot.roi,
      background_area: blot.bgArea,
      brightfield: blot.raw.bf ? { file: "brightfield.tif", was: was(blot.bfOrigin) } : null,
    };
    return { doc, images };
  }

  // A figure as its figure.json. Its panels are the blots it shows, or has an
  // area of, in the order of the blots on the page.
  function figureDoc(figure) {
    const panels = [];
    for (const blot of state.blots) {
      const p = figure.panels.get(blot.id);
      if (!p || !(p.include || p.crop) || !blot.disk) continue;
      panels.push({ blot: blot.disk.dir, shown: p.include, area: p.crop, area_on: p.crop_on, show_brightfield: p.show_bf, lane_labels: p.labels });
    }
    return { app: "web_blot", kind: "figure", version: VERSION, name: figure.name, panels, style: figure.style };
  }

  const folderDoc = () => ({
    app: "web_blot", kind: "folder", version: VERSION,
    order: state.blots.filter((b) => b.disk).map((b) => b.disk.dir),
    figure: app.figure() ? app.figure().dir : null,
    normalize: state.normalize,
  });

  function check(doc, kind) {
    if (!doc || doc.app !== "web_blot" || doc.kind !== kind) throw new Error(`not a web_blot ${kind}`);
    // a later version gets a conversion here; none is needed yet
    if (!(doc.version <= VERSION)) throw new Error("written by a newer version of web_blot");
    return doc;
  }

  // ------------------------------------------------------------------ reading

  // The tree as the panel shows it: [{ name, blots: [names], figures: [names] }].
  library.folders = [];

  async function scan() {
    const store = tree.store;
    const out = [];
    for (const entry of await store.list([])) {
      if (entry.kind !== "dir" || entry.name.startsWith(".")) continue;
      const folder = { name: entry.name, blots: [], figures: [] };
      for (const child of await store.list([entry.name])) {
        if (child.kind !== "dir") continue;
        const names = new Set((await store.list([entry.name, child.name])).map((f) => f.name));
        if (names.has("blot.json")) folder.blots.push(child.name);
        else if (names.has("figure.json")) folder.figures.push(child.name);
      }
      out.push(folder);
    }
    library.folders = out;
    renderTree();
    return out;
  }
  library.scan = scan;

  async function readBlot(path) {
    const store = tree.store;
    const text = await tree.readText([...path, "blot.json"]);
    const doc = check(JSON.parse(text), "blot");
    const image = async (name) => {
      const bytes = await store.read([...path, name]);
      if (!bytes) throw new Error(`${name} is missing`);
      return imageio.decodeTiff(bufferOf(bytes));
    };
    const session = model.session();
    Object.assign(session.transform, doc.transform);
    session.lanes = doc.lanes || [];
    // a peak tilted by border (start_tilt_deg, end_tilt_deg; briefly in
    // October 2026) is tilted as a whole by their mean
    for (const lane of session.lanes)
      for (const peak of lane.peaks || []) {
        if (!("start_tilt_deg" in peak || "end_tilt_deg" in peak)) continue;
        const deg = Math.round((((peak.start_tilt_deg || 0) + (peak.end_tilt_deg || 0)) / 2) * 10) / 10;
        delete peak.start_tilt_deg;
        delete peak.end_tilt_deg;
        if (deg) peak.tilt_deg = deg;
      }
    Object.assign(session.figure, {
      label_rows: doc.lane_labels || [],
      mw_markers: doc.mw_markers || [], mw_side: doc.mw_side || "left",
      band_markers: doc.band_markers || [], band_side: doc.band_side || "right",
    });
    const was = async (o) => (o ? app.origin({ ...o, bf: o.bf ? await image(o.bf) : null, bfOrigin: await was(o.bfOrigin) }) : null);
    const bf = doc.brightfield ? await image(doc.brightfield.file || "brightfield.tif") : null;
    return {
      name: doc.name || path[path.length - 1],
      wb: await image("raw.tif"),
      bf,
      saved: { session, include: false, labels: false, roi: doc.gel_area || null, bgArea: doc.background_area || null, bfOrigin: doc.brightfield ? await was(doc.brightfield.was) : null },
      text,
    };
  }

  // What is written of a blot or figure: its directory, the name the directory
  // was made for, the text of its JSON, the images that are written, and what
  // the pictures and tables were made from.
  const diskRecord = (dir, name, text) => ({ dir, want: tree.safeName(name), text, raw: null, bf: null, nested: "", derived: null });

  // Open a folder of the work folder: it replaces what is open.
  async function load(dir) {
    const store = tree.store;
    const entries = (await store.list([dir])).filter((e) => e.kind === "dir");
    let folder = {};
    try {
      folder = check(JSON.parse((await tree.readText([dir, "folder.json"])) || "null") || { app: "web_blot", kind: "folder", version: VERSION }, "folder");
    } catch (error) {
      folder = {};
    }
    const order = folder.order || [];
    const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
    entries.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    const blots = [];
    const figures = [];
    const problems = [];
    for (const entry of entries) {
      const names = new Set((await store.list([dir, entry.name])).map((f) => f.name));
      try {
        if (names.has("blot.json")) blots.push([entry.name, await readBlot([dir, entry.name])]);
        else if (names.has("figure.json")) {
          const text = await tree.readText([dir, entry.name, "figure.json"]);
          figures.push([entry.name, check(JSON.parse(text), "figure"), text]);
        }
      } catch (error) {
        problems.push(`${entry.name}: ${error.message}`);
      }
    }
    app.clear();
    state.folder = { name: dir, dir };
    state.normalize = !!folder.normalize;
    const byDir = new Map();
    for (const [name, read] of blots) {
      const blot = app.addBlot(read.name, read.wb, read.bf, read.saved);
      blot.disk = diskRecord(name, read.name, read.text);
      blot.disk.raw = imageio.key(read.wb);
      blot.disk.bf = read.bf ? imageio.key(read.bf) : null;
      blot.disk.nested = nestedKeys(blot);
      blot.disk.derived = read.text; // what is there was made from this
      byDir.set(name, blot);
    }
    if (figures.length) {
      state.figures = figures.map(([name, doc, text]) => {
        const figure = model.newFigure(doc.name || name);
        figure.style = { ...model.style(), ...doc.style };
        for (const p of doc.panels || []) {
          const blot = byDir.get(p.blot);
          if (blot) figure.panels.set(blot.id, { include: p.shown !== false, labels: !!p.lane_labels, crop: p.area || null, crop_on: !!p.area_on, show_bf: !!p.show_brightfield });
        }
        figure.dir = name;
        figure.disk = diskRecord(name, figure.name, text);
        figure.disk.derived = text;
        return figure;
      });
    } else {
      // a folder without a figure yet: one that shows every blot whole
      const figure = model.newFigure();
      state.blots.forEach((b, i) => figure.panels.set(b.id, { include: true, labels: i === 0, crop: null, crop_on: false, show_bf: false }));
      state.figures = [figure];
    }
    state.figure = null;
    app.selectFigure((state.figures.find((f) => f.dir === folder.figure) || state.figures[0]).id);
    if (state.blots.length) state.selected = state.blots[0].id;
    written.folder = pretty(folderDoc());
    known = new Set([...state.blots, ...state.figures]);
    app.changed("blots", "panel");
    if (problems.length) WB.feedback.error(`Could not read:\n${problems.join("\n")}`);
  }

  // ------------------------------------------------------------------ writing

  const statusNode = dom.el("span", { class: "save-status", "data-t": "save-status" });
  function setStatus(kind, text, title = "") {
    statusNode.className = `save-status ${kind}`;
    statusNode.title = title;
    statusNode.textContent = text;
  }

  const written = { folder: null }; // the text of folder.json as it is on disk
  let known = new Set(); // the blots and figures that have a directory
  let timer = null;
  let derivedTimer = null;
  let queue = Promise.resolve(); // writes, one after the other

  const nestedImages = (blot) => blotDoc(blot).images;
  const nestedKeys = (blot) => nestedImages(blot).map((image) => imageio.key(image)).join(",");

  // the names taken in the open folder, but for `except`
  const taken = (except) => new Set([...known].filter((x) => x !== except && x.disk).map((x) => x.disk.dir.toLowerCase()));

  // Make sure a blot or figure has a directory with the name it has now.
  async function place(item) {
    const folder = state.folder.dir;
    const want = tree.safeName(item.name);
    if (!item.disk) {
      item.disk = diskRecord(tree.freeName(item.name, taken(item)), item.name, null);
      await tree.store.mkdir([folder, item.disk.dir]);
    } else if (item.disk.want !== want) {
      const dir = tree.freeName(item.name, taken(item));
      await tree.rename([folder, item.disk.dir], [folder, dir]);
      item.disk.dir = dir;
      item.disk.want = want;
    }
    if ("panels" in item) item.dir = item.disk.dir;
    known.add(item);
    return [folder, item.disk.dir];
  }

  async function writeBlot(blot) {
    const store = tree.store;
    const path = await place(blot);
    const { doc, images } = blotDoc(blot);
    const text = pretty(doc);
    if (blot.disk.raw !== imageio.key(blot.raw.wb)) {
      await store.write([...path, "raw.tif"], imageio.encodeTiff(blot.raw.wb));
      blot.disk.raw = imageio.key(blot.raw.wb);
    }
    const bf = blot.raw.bf ? imageio.key(blot.raw.bf) : null;
    if (blot.disk.bf !== bf) {
      if (bf) await store.write([...path, "brightfield.tif"], imageio.encodeTiff(blot.raw.bf));
      else await store.remove([...path, "brightfield.tif"]);
      blot.disk.bf = bf;
    }
    const nested = images.map((image) => imageio.key(image)).join(",");
    if (blot.disk.nested !== nested) {
      for (const entry of await store.list(path)) if (/^brightfield-\d+\.tif$/.test(entry.name)) await store.remove([...path, entry.name]);
      for (let i = 0; i < images.length; i++) await store.write([...path, `brightfield-${i + 1}.tif`], imageio.encodeTiff(images[i]));
      blot.disk.nested = nested;
    }
    if (blot.disk.text !== text) {
      await store.write([...path, "blot.json"], text);
      blot.disk.text = text;
    }
  }

  async function writeFigure(figure) {
    const path = await place(figure);
    const text = pretty(figureDoc(figure));
    if (figure.disk.text !== text) {
      await tree.store.write([...path, "figure.json"], text);
      figure.disk.text = text;
    }
  }

  const pngOf = (canvas) =>
    new Promise((resolve) => canvas.toBlob(async (blob) => resolve(new Uint8Array(await blob.arrayBuffer())), "image/png"));

  // the blot as the page shows it: turned, cropped, with its exposure
  function viewCanvas(blot) {
    const { wb, bf } = blot.work;
    const t = blot.session.transform;
    const gray = processing.compose(wb, t.bf_show ? bf : null, t);
    const canvas = document.createElement("canvas");
    canvas.width = wb.w;
    canvas.height = wb.h;
    const image = new ImageData(wb.w, wb.h);
    for (let i = 0; i < gray.length; i++) {
      image.data[4 * i] = image.data[4 * i + 1] = image.data[4 * i + 2] = gray[i];
      image.data[4 * i + 3] = 255;
    }
    canvas.getContext("2d").putImageData(image, 0, 0);
    return canvas;
  }

  // the same with the lanes, their numbers and the borders of their peaks
  function lanesCanvas(blot, view) {
    const canvas = document.createElement("canvas");
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(view, 0, 0);
    const unit = Math.max(view.width / 600, 1);
    ctx.font = `${Math.round(12 * unit)}px sans-serif`;
    blot.session.lanes.forEach((lane, i) => {
      // image coordinates have pixel centres at whole numbers; the canvas has them at .5
      const line = (points, colour, width) => {
        ctx.beginPath();
        points.forEach(([y, x], k) => (k ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5)));
        ctx.strokeStyle = colour;
        ctx.lineWidth = width * unit;
        ctx.stroke();
      };
      const poly = lanes.polygon(lane);
      line([...poly, poly[0]], "#ffd400", 1.4);
      ctx.fillStyle = "#ffd400";
      ctx.fillText(String(i + 1), poly[0][1] + 3 * unit, poly[0][0] + 13 * unit);
      const hw = 0.5 * lane.width;
      for (const peak of lane.peaks)
        for (const side of ["start", "end"])
          line([lanes.point(lane, WB.quant.borderAt(peak, side, -hw), -hw), lanes.point(lane, WB.quant.borderAt(peak, side, hw), hw)],
            peak.quantify ? "#ff7a00" : "#9a9a9a", 1);
    });
    return canvas;
  }

  function profilesCsv(blot) {
    const lines = ["lane,position_px,intensity,background"];
    blot.session.lanes.forEach((lane, i) => {
      const { profile, baseline } = app.curves(blot, lane);
      for (let k = 0; k < profile.length; k++) lines.push(`${i + 1},${k},${WB.num.format(profile[k])},${WB.num.format(baseline[k])}`);
    });
    return lines.join("\n") + "\n";
  }

  // The pictures and tables of a blot, for reading without this page.
  async function writeBlotDerived(blot) {
    if (!blot.disk || blot.disk.derived === blot.disk.text) return;
    const store = tree.store;
    const path = [state.folder.dir, blot.disk.dir];
    const made = blot.disk.text;
    const view = viewCanvas(blot);
    await store.write([...path, "view.png"], await pngOf(view));
    await store.write([...path, "lanes.png"], await pngOf(lanesCanvas(blot, view)));
    const { bands, rows } = app.results(blot);
    await store.write([...path, "areas.csv"], quant.tableToCsv(bands, rows));
    await store.write([...path, "profiles.csv"], profilesCsv(blot));
    blot.disk.derived = made;
  }

  // Build a figure that is not the one being worked on: the blots are shown as
  // it has them for the moment of building, and as they were again after it.
  function buildFigure(figure) {
    if (figure.id === state.figure) return WB.figurepanel.build();
    const current = app.figure();
    const show = (f) => {
      state.style = f.style;
      for (const blot of state.blots) {
        const p = f.panels.get(blot.id) || { include: false, labels: false, crop: null, crop_on: false, show_bf: false };
        blot.include = p.include;
        blot.labels = p.labels;
        Object.assign(blot.session.figure, { crop: p.crop, crop_on: p.crop_on, show_bf: p.show_bf });
      }
    };
    show(figure);
    try {
      return WB.figurepanel.build();
    } finally {
      show(current);
    }
  }

  // A figure as it renders now.
  async function writeFigureDerived(figure) {
    if (!figure.disk) return;
    const shown = state.blots.filter((b) => b.disk && (figure.panels.get(b.id) || {}).include);
    const made = figure.disk.text + shown.map((b) => b.disk.text).join("");
    if (figure.disk.derived === made) return;
    const store = tree.store;
    const path = [state.folder.dir, figure.disk.dir];
    const built = buildFigure(figure);
    if (built) {
      await store.write([...path, "figure.svg"], built.svg);
      const png = await WB.figure.toPng(built, figure.style.lossless ? built.nativeDpi : figure.style.dpi);
      await store.write([...path, "figure.png"], new Uint8Array(await png.arrayBuffer()));
    } else {
      await store.remove([...path, "figure.svg"]);
      await store.remove([...path, "figure.png"]);
    }
    figure.disk.derived = made;
  }

  async function write(derived) {
    const store = tree.store;
    if (store.kind === "none") return;
    // a folder is made when it has something in it (or by "New folder")
    if (!state.folder.dir && !state.blots.length) return;
    let wrote = false;
    try {
      if (!state.folder.dir) {
        const names = new Set((await store.list([])).map((e) => e.name.toLowerCase()));
        state.folder.dir = tree.freeName(state.folder.name || title(), names);
        if (!state.folder.name) state.folder.name = state.folder.dir;
        await store.mkdir([state.folder.dir]);
        wrote = true;
      } else if (tree.safeName(state.folder.name || state.folder.dir) !== state.folder.dir) {
        const names = new Set((await store.list([])).map((e) => e.name.toLowerCase()));
        const dir = tree.freeName(state.folder.name, names);
        await tree.rename([state.folder.dir], [dir]);
        state.folder.dir = dir;
        wrote = true;
      }
      await remember(LAST, state.folder.dir);
      app.stashFigure();
      // what is no longer in the folder goes from the disk too
      for (const item of [...known]) {
        if (state.blots.includes(item) || state.figures.includes(item)) continue;
        if (item.disk) await store.remove([state.folder.dir, item.disk.dir]);
        item.disk = null; // if it comes back (Undo), it is written anew
        known.delete(item);
        wrote = true;
      }
      const before = [...state.blots, ...state.figures].map((x) => x.disk && x.disk.text + x.disk.dir + x.disk.raw + x.disk.bf).join("|");
      for (const blot of state.blots) await writeBlot(blot);
      for (const figure of state.figures) await writeFigure(figure);
      const folder = pretty(folderDoc());
      if (written.folder !== folder) {
        await store.write([state.folder.dir, "folder.json"], folder);
        written.folder = folder;
        wrote = true;
      }
      wrote = wrote || before !== [...state.blots, ...state.figures].map((x) => x.disk.text + x.disk.dir + x.disk.raw + x.disk.bf).join("|");
      if (derived) {
        for (const blot of state.blots) await writeBlotDerived(blot);
        for (const figure of state.figures) await writeFigureDerived(figure);
      }
      setStatus("saved", store.kind === "disk" ? "Saved to disk" : "Saved",
        store.kind === "disk" ? `In the folder “${store.label}”.` : "Kept by this browser. The browser can clear its storage; download what you need to keep, or choose a folder on disk.");
      if (wrote) await scan();
    } catch (error) {
      setStatus("failed", "Not saved", `The folder could not be written: ${error.message}`);
    }
  }

  // Write what has changed now: settings and images, and with `derived` the
  // pictures and tables too. Resolves when it is on disk.
  library.saveNow = function (derived = true) {
    clearTimeout(timer);
    timer = null;
    if (derived) {
      clearTimeout(derivedTimer);
      derivedTimer = null;
    }
    queue = queue.then(() => write(derived));
    return queue;
  };

  function schedule() {
    if (tree.store.kind === "none") return;
    clearTimeout(timer);
    timer = setTimeout(() => library.saveNow(false), DELAY);
    clearTimeout(derivedTimer);
    derivedTimer = setTimeout(() => library.saveNow(true), DELAY_DERIVED);
  }

  // ---------------------------------------------------------------- folders

  // What is open is not in the work folder (yet).
  function detach() {
    for (const item of [...state.blots, ...state.figures]) item.disk = null;
    state.figures.forEach((f) => (f.dir = null));
    state.folder.dir = null;
    known = new Set();
    written.folder = null;
    setStatus("idle", "");
  }

  library.open = async function (dir) {
    await library.saveNow();
    await load(dir);
    await remember(LAST, dir);
    setStatus("saved", tree.store.kind === "disk" ? "Saved to disk" : "Saved");
    renderTree();
  };

  // A new, empty folder, and work in it.
  library.newFolder = async function (name = "New folder") {
    await library.saveNow();
    app.clear();
    detach();
    const names = new Set((await tree.store.list([])).map((e) => e.name.toLowerCase()));
    state.folder.name = state.folder.dir = tree.freeName(name, names);
    await tree.store.mkdir([state.folder.dir]);
    await remember(LAST, state.folder.dir);
    app.changed("panel");
    await scan();
  };

  library.removeFolder = async function (dir) {
    if (dir === state.folder.dir) {
      clearTimeout(timer);
      clearTimeout(derivedTimer);
      await queue;
      app.clear();
      detach();
      await remember(LAST, null);
    }
    await tree.store.remove([dir]);
    await scan();
  };

  // A folder, or all of them, as a zip file that unpacks to what is on disk.
  library.download = async function (dir = null) {
    await library.saveNow();
    const files = await tree.files(dir ? [dir] : []);
    if (!files.length) throw new Error("There is nothing to download yet.");
    const entries = files.map(([path, data]) => ({ name: path.join("/"), data }));
    dom.download(`${dir || "web_blot"}.zip`, zip.write(entries), "application/zip");
    return files.length;
  };

  // The open folder as a zip file.
  library.downloadOpen = async function () {
    await library.saveNow();
    if (!state.folder.dir) throw new Error("There is nothing to download yet.");
    return library.download(state.folder.dir);
  };

  // Open a zip of folders as "Download" makes them. Returns the names of the
  // new folders.
  library.importFile = async function (file) {
    await library.saveNow();
    const stem = file.name.replace(/\.zip$/i, "");
    const entries = zip.read(await file.arrayBuffer());
    // folders as they are on disk; a zip of one folder's content gets a folder around it
    const paths = entries.map((e) => [e.name.split("/").filter(Boolean), e.data]).filter(([p]) => p.length && !p[0].startsWith("__MACOSX"));
    if (!paths.some(([p]) => p[p.length - 1] === "blot.json" || p[p.length - 1] === "figure.json"))
      throw new Error("There are no web_blot folders in this file.");
    const bare = paths.some(([p]) => p.length === 2 && (p[1] === "blot.json" || p[1] === "figure.json"));
    const store = tree.store;
    const names = new Set((await store.list([])).map((e) => e.name.toLowerCase()));
    const target = new Map();
    for (const [path, data] of paths) {
      const full = bare ? [stem, ...path] : path;
      if (full.length < 2) continue; // a file beside the folders
      if (!target.has(full[0])) {
        target.set(full[0], tree.freeName(full[0], names));
        names.add(target.get(full[0]).toLowerCase());
      }
      await store.write([target.get(full[0]), ...full.slice(1)], data);
    }
    await scan();
    const made = [...target.values()];
    if (made.length) await library.open(made[0]);
    return made;
  };

  // --------------------------------------------------------- the tree panel

  const nameField = dom.text("", "project-name", (value) => {
    state.folder.name = value.trim() || state.folder.name;
    app.changed("panel");
  }, { class: "project-name", title: "Name of the folder that is open." });

  library.headerParts = () => [nameField];
  library.statusPart = () => statusNode;

  const act = (action) => async () => {
    try {
      await action();
    } catch (error) {
      if (error.name !== "AbortError") WB.feedback.error(error.message); // AbortError: the folder dialog was closed
    }
  };

  // after the store has changed: what is in the new one
  async function switched() {
    app.clear();
    detach();
    await scan();
    const last = await recall(LAST);
    const dir = library.folders.some((f) => f.name === last) ? last : library.folders.length ? library.folders[0].name : null;
    if (dir) await library.open(dir);
    renderTree();
  }

  library.chooseFolder = async function () {
    await library.saveNow();
    const before = tree.store;
    const kept = before.kind === "browser" ? await before.list([]) : [];
    await tree.pick();
    // what was kept by the browser can come along
    if (kept.some((e) => e.kind === "dir") &&
      (await WB.feedback.confirm(`Copy the ${kept.filter((e) => e.kind === "dir").length} folder(s) kept in this browser into “${tree.store.label}”? They stay in the browser as well.`, "Copy folders"))) {
      const names = new Set((await tree.store.list([])).map((e) => e.name.toLowerCase()));
      for (const entry of kept) {
        if (entry.kind !== "dir") continue;
        const name = tree.freeName(entry.name, names);
        names.add(name.toLowerCase());
        await tree.copy([entry.name], [name], before, tree.store);
      }
    }
    await switched();
  };

  function storageLine() {
    const store = tree.store;
    const where = store.kind === "disk" ? ["On disk: ", dom.el("strong", {}, store.label)]
      : store.kind === "browser" ? "Kept in this browser" : "Not stored";
    return dom.el("div", { class: "tree-store", "data-t": "tree-store" },
      dom.el("div", { class: "where" }, where),
      tree.waiting ? dom.el("div", { class: "notice" }, `The folder “${tree.waiting.name}” needs your OK again. `,
        dom.primary("Reconnect", "tree-reconnect", act(async () => {
          if (await tree.reconnect()) await switched();
        }))) : null,
      store.kind === "none" ? dom.el("p", { class: "hint" }, "This browser does not let the page store anything (a private window, or storage is blocked). Download what you need to keep.") : null,
      dom.el("div", { class: "row" },
        tree.canPick() ? dom.button(store.kind === "disk" ? "Other folder…" : "Choose folder…", "tree-choose", act(library.chooseFolder),
          "Work in a folder on this computer: every blot and figure is a directory of ordinary files there.") : null,
        store.kind === "disk" ? dom.button("Use browser", "tree-browser", act(async () => {
          await library.saveNow();
          await tree.useBrowser();
          await switched();
        }), "Go back to the folders this browser keeps.") : null));
  }

  function renderTree() {
    const root = document.getElementById("tree");
    if (!root) return;
    const open = state.folder.dir;
    // the open folder as it is now, the others as they are on disk
    const folders = library.folders.map((f) => (f.name === open
      ? { name: f.name, blots: state.blots.map((b) => b.name), figures: state.figures.map((f2) => f2.name), open: true }
      : f));
    // the open folder is always there, also before it is written or listed
    if (!folders.some((f) => f.open) && (open || state.blots.length)) {
      folders.push({ name: open || title(), blots: state.blots.map((b) => b.name), figures: state.figures.map((f) => f.name), open: true, unsaved: !open });
      folders.sort((x, y) => x.name.localeCompare(y.name));
    }
    const row = (folder) => dom.el("li", { class: `tree-folder${folder.open ? " open" : ""}`, "data-t": "tree-folder", "data-name": folder.name },
      dom.el("div", { class: "tree-row" },
        dom.el("button", { type: "button", class: "tree-name", "data-t": "tree-open", title: folder.name,
          onclick: act(async () => { if (!folder.open) await library.open(folder.name); }) }, WB.icon("folder"), dom.el("span", {}, folder.name)),
        folder.unsaved ? null : dom.icon("download", "tree-download", act(() => library.download(folder.name)), "Download this folder as a zip file", "small quiet"),
        folder.unsaved ? null : dom.icon("close", "tree-delete", act(async () => {
          if (await WB.feedback.confirm(`Delete the folder “${folder.name}” with its ${folder.blots.length} blot(s)? This cannot be undone.`, "Delete folder", { danger: true }))
            await library.removeFolder(folder.name);
        }), "Delete this folder", "small quiet")),
      dom.el("ul", {},
        folder.blots.map((name, i) => dom.el("li", {}, dom.el("button", {
          type: "button", class: `tree-leaf${folder.open && state.blots[i] && state.blots[i].id === state.selected ? " current" : ""}`, "data-t": "tree-blot", title: name,
          onclick: act(async () => {
            if (!folder.open) await library.open(folder.name);
            const blot = state.blots.find((b) => (b.disk ? b.disk.dir === name : b.name === name)) || state.blots[i];
            if (blot) app.select(blot.id);
          }),
        }, WB.icon("image"), dom.el("span", {}, name)))),
        folder.figures.map((name, i) => dom.el("li", {}, dom.el("button", {
          type: "button", class: `tree-leaf figure${folder.open && state.figures[i] && state.figures[i].id === state.figure && state.tab === "figure" ? " current" : ""}`, "data-t": "tree-figure", title: name,
          onclick: act(async () => {
            if (!folder.open) await library.open(folder.name);
            const figure = state.figures.find((f) => f.dir === name || f.name === name) || state.figures[i];
            if (figure) app.selectFigure(figure.id);
            app.setStep("figure");
          }),
        }, WB.icon("chart"), dom.el("span", {}, name))))));
    const fileInput = dom.el("input", {
      type: "file", accept: ".zip", "data-t": "tree-import-file", hidden: true,
      onchange: act(async () => {
        const file = fileInput.files[0];
        fileInput.value = "";
        if (file) await library.importFile(file);
      }),
    });
    root.replaceChildren(...[
      dom.el("div", { class: "tree-head" }, dom.el("h2", {}, "Folders"),
        dom.icon("plus", "tree-new", act(() => library.newFolder()), "New folder", "small")),
      storageLine(),
      folders.length ? dom.el("ul", { class: "tree-list", "data-t": "tree-list" }, folders.map(row))
        : dom.el("p", { class: "hint" }, "No folder yet. A folder is made as soon as you add a blot."),
      dom.el("div", { class: "tree-foot" },
        dom.button([WB.icon("upload"), "Open file…"], "tree-import", () => fileInput.click(),
          "Add folders from a zip file made by Download."),
        dom.button([WB.icon("download"), "All"], "tree-download-all", act(() => library.download()), "Download all folders as one zip file."),
        fileInput),
    ].filter(Boolean));
  }
  library.renderTree = renderTree;

  // ------------------------------------------------------------------- start

  // Has a file of the open folder been changed from outside (in Finder, by hand)?
  library.refresh = async function () {
    if (tree.store.kind === "none" || !state.folder.dir) return scan();
    let changed = false;
    try {
      for (const item of [...state.blots, ...state.figures]) {
        if (!item.disk || item.disk.text === null) continue;
        const name = "panels" in item ? "figure.json" : "blot.json";
        const text = await tree.readText([state.folder.dir, item.disk.dir, name]);
        if (text !== item.disk.text) changed = true;
      }
    } catch (error) {
      changed = true;
    }
    await scan();
    if (!changed) return;
    if (timer) {
      // there is something unsaved here too: the user decides
      WB.feedback.toast("Files of this folder were changed outside the page.", { action: { label: "Read them again", run: act(() => load(state.folder.dir)) } });
    } else {
      clearTimeout(derivedTimer);
      await queue;
      await load(state.folder.dir);
      WB.feedback.toast("The folder was changed outside the page and has been read again.");
    }
  };

  app.views.push((kinds) => {
    if (document.activeElement !== nameField) nameField.value = state.folder.name;
    nameField.placeholder = title();
    schedule();
    if (["blots", "select", "panel"].some((k) => kinds.has(k))) renderTree();
  });

  // Find out where the work folder is, and open the folder that was open last.
  library.start = async function () {
    await tree.start();
    if (tree.store.kind === "none") {
      setStatus("failed", "Not stored", "This browser does not let the page store anything (a private window, or storage is blocked).");
      renderTree();
      return;
    }
    window.addEventListener("pagehide", () => library.saveNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") library.saveNow();
      else library.refresh().catch(() => {});
    });
    await scan();
    const last = await recall(LAST);
    if (last && !state.blots.length && library.folders.some((f) => f.name === last)) {
      try {
        await library.open(last);
      } catch (error) {
        await remember(LAST, null);
        WB.feedback.error(`The folder “${last}” could not be opened: ${error.message}`);
      }
    }
    schedule();
    renderTree();
  };
})();
