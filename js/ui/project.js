// Project files: everything in one JSON file, including the original image data.
//
//   { app: "web_blot", version, name, style, normalize,
//     images: { key: image },
//     blots: [{ name, ..., wb: key, bf: key | null, bf_origin }] }
//
// Every image is in the file once, under its key; blots made from the same
// image share it. The browser's storage keeps the same document with the
// images apart (core/store.js).
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, model, imageio } = WB;
  const project = (WB.project = {});

  project.SUFFIX = ".webblot.json";

  // The name the project goes by: its own, or that of its first blot.
  project.title = () => state.project.name || (state.blots[0] ? state.blots[0].name : "") || "Untitled";

  // `encode` turns an image into what the document holds for it.
  project.serialize = function (encode = imageio.pack) {
    const images = {};
    const ref = (image) => {
      if (!image) return null;
      const key = imageio.key(image);
      if (!(key in images)) images[key] = encode(image);
      return key;
    };
    // the record of what a merged brightfield was, with its own images
    const packOrigin = (o) => o && { ...o, bf: ref(o.bf), bfOrigin: packOrigin(o.bfOrigin) };
    const blots = state.blots.map((b) => ({
      name: b.name,
      include: b.include,
      labels: b.labels,
      roi: b.roi,
      session: b.session,
      wb: ref(b.raw.wb),
      bf: ref(b.raw.bf),
      bf_origin: packOrigin(b.bfOrigin),
    }));
    return {
      app: "web_blot",
      version: model.PROJECT_VERSION,
      name: state.project.name,
      style: state.style,
      normalize: state.normalize,
      images,
      blots,
    };
  };

  // Files of every version from 4 on must stay readable: a change to the
  // format gets a new version and a step here that converts the one before.
  // Versions before 4 are from before that promise.
  const UPGRADES = {
    4: imagesToTable, // each image was inside the blot that used it
    5: lineWidthToMm, // the line width was in points
    6: cropSwitch, // a figure area was in use whenever there was one
  };

  // Check that `data` is a project document and bring it to the current version.
  project.upgrade = function (data) {
    if (!data || data.app !== "web_blot" || !Array.isArray(data.blots)) throw new Error("This is not a web_blot project file.");
    if (!(data.version in UPGRADES) && data.version !== model.PROJECT_VERSION)
      throw new Error("This project was saved by another version of web_blot and cannot be opened.");
    while (data.version in UPGRADES) data = { ...UPGRADES[data.version](data), version: data.version + 1 };
    return data;
  };

  function cropSwitch(data) {
    const session = (s) => s && { ...s, figure: { ...s.figure, crop_on: !!(s.figure && s.figure.crop) } };
    const origin = (o) => o && { ...o, session: session(o.session), bfOrigin: origin(o.bfOrigin) };
    const blots = data.blots.map((b) => ({ ...b, session: session(b.session), bf_origin: origin(b.bf_origin) }));
    return { ...data, blots };
  }

  function lineWidthToMm(data) {
    const style = { ...data.style };
    if (typeof style.line_width === "number") style.line_width_mm = (style.line_width * 25.4) / 72;
    delete style.line_width;
    return { ...data, style };
  }

  function imagesToTable(data) {
    const images = {};
    const move = (packed) => {
      if (!packed) return null;
      const key = model.newId();
      images[key] = packed;
      return key;
    };
    const moveOrigin = (o) => o && { ...o, bf: move(o.bf), bfOrigin: moveOrigin(o.bfOrigin) };
    const blots = data.blots.map((b) => ({ ...b, wb: move(b.wb), bf: move(b.bf), bf_origin: moveOrigin(b.bf_origin) }));
    return { ...data, name: "", images, blots };
  }

  // Replace what is open by the project in `data`, as a new project. `decode`
  // is the opposite of the `encode` it was serialized with.
  project.load = function (data, decode = imageio.unpack) {
    data = project.upgrade(data);
    const decoded = new Map();
    const image = (key) => {
      if (!key) return null;
      if (!decoded.has(key)) {
        if (!data.images || !data.images[key]) throw new Error("An image of this project is missing.");
        const img = decode(data.images[key]);
        img.key = key;
        decoded.set(key, img);
      }
      return decoded.get(key);
    };
    const unpackOrigin = (o) => (o ? app.origin({ ...o, bf: image(o.bf), bfOrigin: unpackOrigin(o.bfOrigin) }) : null);
    // read everything before closing what is open: a damaged file leaves it alone
    const blots = data.blots.map((saved) => {
      const session = model.session();
      Object.assign(session.transform, saved.session.transform);
      Object.assign(session.figure, saved.session.figure);
      session.lanes = saved.session.lanes;
      return [saved.name, image(saved.wb), image(saved.bf), {
        session,
        include: saved.include,
        labels: saved.labels,
        roi: saved.roi,
        bfOrigin: unpackOrigin(saved.bf_origin),
      }];
    });
    app.clear();
    state.project.name = data.name || "";
    state.style = { ...model.style(), ...data.style };
    state.normalize = !!data.normalize;
    for (const blot of blots) app.addBlot(...blot);
    if (state.blots.length) state.selected = state.blots[0].id;
    app.changed("blots", "panel");
  };

  project.fileName = (name) => name.replace(/[^\w.-]+/g, "_") + project.SUFFIX;

  project.save = function () {
    dom.download(project.fileName(project.title()), JSON.stringify(project.serialize()), "application/json");
  };

  project.open = async function (file) {
    project.load(JSON.parse(await file.text()));
  };
})();
