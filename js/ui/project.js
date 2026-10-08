// Saving and opening project files: everything in one JSON file, including the
// original image data.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, model, imageio } = WB;
  const project = (WB.project = {});

  project.SUFFIX = ".webblot.json";

  // the record of what a merged brightfield was, with its own images packed
  const packOrigin = (o) =>
    o && { ...o, bf: o.bf ? imageio.pack(o.bf) : null, bfOrigin: packOrigin(o.bfOrigin) };
  const unpackOrigin = (o) =>
    o ? app.origin({ ...o, bf: o.bf ? imageio.unpack(o.bf) : null, bfOrigin: unpackOrigin(o.bfOrigin) }) : null;

  project.serialize = function () {
    return {
      app: "web_blot",
      version: model.PROJECT_VERSION,
      style: state.style,
      blots: state.blots.map((b) => ({
        name: b.name,
        include: b.include,
        labels: b.labels,
        roi: b.roi,
        session: b.session,
        wb: imageio.pack(b.raw.wb),
        bf: b.raw.bf ? imageio.pack(b.raw.bf) : null,
        bf_origin: packOrigin(b.bfOrigin),
      })),
    };
  };

  project.load = function (data) {
    if (!data || data.app !== "web_blot") throw new Error("This is not a web_blot project file.");
    // while this is a prototype, files of other versions are not converted
    if (data.version !== model.PROJECT_VERSION)
      throw new Error("This project was saved by another version of web_blot and cannot be opened.");
    app.clear();
    state.style = { ...model.style(), ...data.style };
    for (const saved of data.blots) {
      const session = model.session();
      Object.assign(session.transform, saved.session.transform);
      Object.assign(session.figure, saved.session.figure);
      session.lanes = saved.session.lanes;
      app.addBlot(saved.name, imageio.unpack(saved.wb), saved.bf ? imageio.unpack(saved.bf) : null, {
        session,
        include: saved.include,
        labels: saved.labels,
        roi: saved.roi,
        bfOrigin: unpackOrigin(saved.bf_origin),
      });
    }
    if (state.blots.length) state.selected = state.blots[0].id;
    app.changed("blots", "panel");
  };

  project.save = function () {
    const stem = (state.blots[0] ? state.blots[0].name : "project").replace(/[^\w.-]+/g, "_");
    dom.download(stem + project.SUFFIX, JSON.stringify(project.serialize()), "application/json");
  };

  project.open = async function (file) {
    project.load(JSON.parse(await file.text()));
  };
})();
