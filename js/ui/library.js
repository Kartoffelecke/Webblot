// The projects kept in this browser: saving the open one as it changes,
// switching between them, and the library file that holds them all.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, model, store, project, imageio, zip } = WB;
  const library = (WB.library = {});

  library.SUFFIX = ".webblot.zip";
  const LAST = "web_blot.last"; // the project to open again when the page is loaded
  const DELAY = 400; // ms without a change before the project is written

  let usable = false; // the browser's storage works
  // what this page last read or wrote of the open project
  let written = { id: null, json: null, modified: null };
  let conflict = false; // another tab wrote the open project; nothing is saved until that is settled
  let timer = null;
  let queue = Promise.resolve(); // writes, one after the other

  const remember = (id) => {
    try {
      if (id) localStorage.setItem(LAST, id);
      else localStorage.removeItem(LAST);
    } catch (error) {
      // no localStorage here: the page starts empty next time
    }
  };

  const recall = () => {
    try {
      return localStorage.getItem(LAST);
    } catch (error) {
      return null;
    }
  };

  // ------------------------------------------------------------------- header

  const statusNode = dom.el("span", { class: "save-status", "data-t": "save-status" });
  const nameField = dom.text("", "project-name", (value) => {
    state.project.name = value.trim();
    app.changed("panel");
  }, { class: "project-name", title: "Name of the project. Empty: it goes by the name of its first blot." });
  const listButton = dom.button("Projects…", "projects", () => library.show(), "The projects stored in this browser.");

  function setStatus(kind, text, title = "", ...controls) {
    statusNode.className = `save-status ${kind}`;
    statusNode.title = title;
    statusNode.replaceChildren(text, ...controls);
  }

  library.headerParts = () => [nameField, listButton];
  library.statusPart = () => statusNode;

  // ------------------------------------------------------------------- saving

  // The open project as the storage keeps it: the document, and its images apart.
  function snapshot() {
    const doc = project.serialize((image) => () => imageio.toBinary(image));
    const images = doc.images;
    delete doc.images;
    return { json: JSON.stringify(doc), images };
  }

  async function write() {
    if (!usable || conflict) return;
    const open = state.project;
    const known = written.id === open.id;
    if (!known && !state.blots.length) return; // an empty project that was never stored
    const { json, images } = snapshot();
    if (known && written.json === json) return;
    setStatus("saving", "Saving…");
    const meta = { id: open.id, name: project.title(), created: open.created, blots: state.blots.map((b) => b.name) };
    try {
      const modified = await store.save(meta, JSON.parse(json), images, known ? written.modified : null);
      if (!known) store.persist();
      written = { id: open.id, json, modified };
      remember(open.id);
      setStatus("saved", "Saved", "This project is stored in this browser. The browser can clear its storage; export what you need to keep.");
    } catch (error) {
      if (!error.conflict) {
        setStatus("failed", "Not saved", `The browser did not store the project: ${error.message}`);
        return;
      }
      conflict = true;
      setStatus("failed", "Changed in another tab", "This project was saved from another tab or window since it was opened here.",
        dom.button("Reload", "conflict-reload", () => library.open(open.id, false).catch(report), "Show the project as it is stored; what was changed here is lost."),
        dom.button("Keep mine as a copy", "conflict-copy", () => {
          state.project = { ...model.project(), name: `${project.title()} copy` };
          detach();
          app.changed("panel");
          library.saveNow();
        }, "Store what is shown here as another project."));
    }
  }

  // Write the open project now if it has changed. Resolves when it is stored.
  library.saveNow = function () {
    clearTimeout(timer);
    timer = null;
    queue = queue.then(write);
    return queue;
  };

  function schedule() {
    if (!usable || conflict) return;
    clearTimeout(timer);
    timer = setTimeout(library.saveNow, DELAY);
  }

  // What is open is not a stored project (any more).
  function detach() {
    written = { id: null, json: null, modified: null };
    conflict = false;
    if (usable) setStatus("idle", "");
  }

  const report = (error) => alert(error.message);

  // ---------------------------------------------------------------- switching

  // Open a stored project. `keep`: store what is open first.
  library.open = async function (id, keep = true) {
    if (keep) await library.saveNow();
    const stored = await store.load(id);
    if (!stored) throw new Error("This project is no longer in this browser.");
    project.load({ ...stored.doc, images: stored.images }, imageio.fromBinary);
    state.project = { id, name: stored.doc.name || "", created: stored.meta.created };
    conflict = false;
    written = { id, json: snapshot().json, modified: stored.meta.modified };
    remember(id);
    setStatus("saved", "Saved");
    app.changed("panel");
  };

  library.newProject = async function () {
    await library.saveNow();
    app.clear();
    detach();
    remember(null);
  };

  // Open a project file as a new project; what was open stays in the browser.
  library.openFile = async function (file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (error) {
      throw new Error("This is not a web_blot project file.");
    }
    if (!usable && state.blots.length && !confirm("Opening a project closes the blots that are open. Continue?")) return;
    await library.saveNow();
    project.load(data);
    detach();
    await library.saveNow();
  };

  // ------------------------------------------------------------------ library

  const mapValues = (object, fn) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, fn(v)]));

  // A stored project as the text of a project file.
  async function fileText(id) {
    const stored = await store.load(id);
    if (!stored) throw new Error("This project is no longer in this browser.");
    return JSON.stringify({ ...stored.doc, images: mapValues(stored.images, imageio.binaryToPacked) });
  }

  library.rename = async function (meta, name) {
    if (meta.id === state.project.id) {
      state.project.name = name;
      app.changed("panel");
      return library.saveNow();
    }
    const stored = name && (await store.load(meta.id));
    if (stored) await store.put({ ...stored.meta, name, modified: Date.now() }, { ...stored.doc, name }, stored.images);
  };

  library.duplicate = async function (meta) {
    const stored = await store.load(meta.id);
    if (!stored) return;
    const now = Date.now();
    const copy = { ...stored.meta, ...model.project(), name: `${meta.name} copy`, modified: now };
    await store.put(copy, { ...stored.doc, name: copy.name }, stored.images);
  };

  library.remove = async function (meta) {
    await store.remove(meta.id);
    if (meta.id !== state.project.id) return;
    app.clear();
    detach();
    remember(null);
  };

  // Every project of this browser in one zip file: the project files, and a
  // list of them.
  library.exportAll = async function () {
    const list = await store.list();
    const used = new Set();
    const entries = [];
    const index = [];
    for (const meta of list) {
      let file = `projects/${project.fileName(meta.name)}`;
      for (let n = 2; used.has(file); n++) file = `projects/${project.fileName(`${meta.name} ${n}`)}`;
      used.add(file);
      entries.push({ name: file, data: await fileText(meta.id) });
      index.push({ id: meta.id, name: meta.name, created: meta.created, modified: meta.modified, file });
    }
    entries.unshift({ name: "library.json", data: JSON.stringify({ app: "web_blot", kind: "library", version: 1, projects: index }, null, 1) });
    const day = new Date().toISOString().slice(0, 10);
    dom.download(`web_blot_library_${day}${library.SUFFIX}`, zip.write(entries), "application/zip");
    return list.length;
  };

  // Add the projects of a library file. Nothing in the browser is replaced: a
  // project that is here unchanged is skipped, one that is here in another
  // state is added beside it. Returns { added, skipped, failed: [names] }.
  library.importFile = async function (file) {
    const entries = zip.read(await file.arrayBuffer());
    const decoder = new TextDecoder();
    const text = (entry) => decoder.decode(entry.data);
    const listEntry = entries.find((e) => e.name === "library.json");
    const listed = new Map();
    if (listEntry) {
      const list = JSON.parse(text(listEntry));
      if (list.app !== "web_blot" || list.kind !== "library") throw new Error("This is not a web_blot library file.");
      for (const info of list.projects || []) listed.set(info.file, info);
    }
    const files = entries.filter((e) => e.name.endsWith(project.SUFFIX));
    if (!files.length) throw new Error("There are no web_blot projects in this file.");
    const here = new Map((await store.list()).map((meta) => [meta.id, meta]));
    const outcome = { added: 0, skipped: 0, failed: [] };
    for (const entry of files) {
      const stem = entry.name.split("/").pop().slice(0, -project.SUFFIX.length);
      try {
        const info = listed.get(entry.name) || {};
        const have = info.id ? here.get(info.id) : null;
        if (have && have.modified === info.modified) {
          outcome.skipped++;
          continue;
        }
        const doc = project.upgrade(JSON.parse(text(entry)));
        const images = mapValues(doc.images || {}, imageio.packedToBinary);
        delete doc.images;
        const now = Date.now();
        const name = `${info.name || doc.name || stem}${have ? " (imported)" : ""}`;
        const meta = {
          id: info.id && !have ? info.id : model.project().id,
          name,
          created: info.created || now,
          modified: info.modified || now,
          blots: doc.blots.map((b) => b.name),
        };
        await store.put(meta, { ...doc, name: have || !doc.name ? name : doc.name }, images);
        here.set(meta.id, meta);
        outcome.added++;
      } catch (error) {
        outcome.failed.push(`${stem}: ${error.message}`);
      }
    }
    return outcome;
  };

  // what an import did, in words
  library.describe = ({ added, skipped, failed }) =>
    [`${added} project${added === 1 ? "" : "s"} added`, skipped ? `${skipped} already here` : "",
      failed.length ? `not read: ${failed.join("; ")}` : ""].filter(Boolean).join(", ") + ".";

  // ------------------------------------------------------------------- dialog

  let dialog = null;

  const megabytes = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

  // a hidden file input and the button that opens it
  function fileButton(label, t, accept, onFile, title) {
    const input = dom.el("input", {
      type: "file", accept, "data-t": `${t}-file`, style: "display:none",
      onchange: () => {
        const file = input.files[0];
        input.value = "";
        if (file) onFile(file);
      },
    });
    return [dom.button(label, t, () => input.click(), title), input];
  }

  async function render(message = "") {
    const list = await store.list();
    const usage = await store.estimate();
    // do something, then show the list as it is afterwards
    const act = (action, done) => async () => {
      try {
        const said = await action();
        if (done) done();
        else await render(typeof said === "string" ? said : "");
      } catch (error) {
        await render(error.message);
      }
    };
    const row = (meta) => {
      const current = meta.id === state.project.id;
      return dom.el("tr", { "data-t": "library-row", class: current ? "current" : "" },
        dom.el("td", {}, dom.text(meta.name, "library-name", (v) => act(() => library.rename(meta, v.trim()))(),
          { title: "Rename" })),
        dom.el("td", { class: "wrap" }, meta.blots.join(", ")),
        dom.el("td", {}, new Date(meta.modified).toLocaleString()),
        dom.el("td", {},
          current ? dom.el("span", { class: "hint", "data-t": "library-current" }, "open")
            : dom.button("Open", "library-open", act(() => library.open(meta.id), () => dialog.close())),
          dom.button("Duplicate", "library-duplicate", act(() => library.duplicate(meta))),
          dom.button("Export", "library-export", act(async () => {
            dom.download(project.fileName(meta.name), await fileText(meta.id), "application/json");
          }), "Download this project as a project file."),
          dom.button("Delete", "library-delete", act(async () => {
            if (confirm(`Delete '${meta.name}' from this browser? This cannot be undone.`)) await library.remove(meta);
          }))));
    };
    dialog.replaceChildren(...[
      dom.el("div", { class: "library-head" },
        dom.el("h2", {}, "Projects in this browser"),
        dom.button("Close", "library-close", () => dialog.close())),
      dom.el("div", { class: "row" },
        dom.button("New project", "library-new", act(() => library.newProject(), () => dialog.close()),
          "Start an empty project; the open one stays in the list."),
        fileButton("Open project file…", "library-open-file", ".json",
          (file) => act(() => library.openFile(file), () => dialog.close())(),
          "Add a project file as a new project and open it."),
        dom.button("Export library", "library-export-all", act(async () => {
          const n = await library.exportAll();
          return `Exported ${n} project${n === 1 ? "" : "s"}.`;
        }), "Download all projects in one zip file, for a backup or to move them to another browser."),
        fileButton("Import library…", "library-import", ".zip",
          (file) => act(async () => library.describe(await library.importFile(file)))(),
          "Add the projects of a library file. Projects that are here are not replaced.")),
      message ? dom.el("p", { class: "notice", "data-t": "library-message" }, message) : null,
      list.length
        ? dom.el("table", { class: "grid library-list", "data-t": "library-list" },
            dom.el("tr", {}, ["Project", "Blots", "Last changed", ""].map((h) => dom.el("th", {}, h))),
            list.map(row))
        : dom.el("p", { class: "empty" }, "No project is stored yet. A project is stored as soon as it has a blot."),
      dom.el("p", { class: "hint", "data-t": "library-usage" },
        usage && usage.quota ? `${megabytes(usage.usage || 0)} of ${megabytes(usage.quota)} used. ` : "",
        "Projects are saved here as you work, in this browser on this computer only. The browser can clear this storage, for example when its site data is deleted, so export the library for anything you need to keep."),
    ].filter(Boolean));
  }

  // The list of projects, with `message` above it.
  library.show = async function (message = "") {
    if (!usable) return;
    await library.saveNow();
    if (!dialog) {
      dialog = dom.el("dialog", { class: "library", "data-t": "library" });
      document.body.append(dialog);
    }
    await render(message);
    if (!dialog.open) dialog.showModal();
  };

  // -------------------------------------------------------------------- start

  app.views.push(() => {
    if (document.activeElement !== nameField) nameField.value = state.project.name;
    nameField.placeholder = project.title();
    schedule();
  });

  // Find out whether the browser stores anything, and open the project that
  // was open last time.
  library.start = async function () {
    usable = await store.available();
    listButton.disabled = !usable;
    if (!usable) {
      setStatus("failed", "Not stored", "This browser does not let the page store projects (a private window, or storage is blocked). Use Save project to keep your work.");
      return;
    }
    window.addEventListener("pagehide", library.saveNow);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") library.saveNow();
    });
    const last = recall();
    if (last && !state.blots.length) {
      try {
        await library.open(last, false);
      } catch (error) {
        remember(null);
      }
    }
    schedule();
  };
})();
