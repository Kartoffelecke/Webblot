// Page layout and start-up.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, num, imageio, panels, quantify, figurepanel, project, library } = WB;

  const TABS = [
    ["prepare", "Prepare"],
    ["lanes", "Lanes"],
    ["quantify", "Quantify"],
    ["figure", "Figure"],
  ];

  async function addFiles(files) {
    const problems = [];
    for (const file of files) {
      try {
        if (file.name.endsWith(".json")) await library.openFile(file);
        else if (file.name.endsWith(".zip")) await library.show(library.describe(await library.importFile(file)));
        else app.addBlot(file.name.replace(/\.[^.]+$/, ""), await imageio.readFile(file));
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      }
    }
    if (problems.length) alert(`Could not open:\n${problems.join("\n")}`);
  }
  app.addFiles = addFiles;

  app.addSample = function () {
    const sample = WB.sample({ seed: state.blots.length + 1 });
    app.addBlot(`Sample ${state.blots.length + 1}`, sample.wb, sample.bf).bfOrigin = app.origin({ name: "Marker" });
    app.changed("blots");
  };

  function topBar() {
    const files = dom.el("input", {
      type: "file", multiple: true, accept: "image/*,.tif,.tiff", "data-t": "add-files", style: "display:none",
      onchange: async () => { await addFiles([...files.files]); files.value = ""; },
    });
    const projectFile = dom.el("input", {
      type: "file", accept: ".json", "data-t": "open-project", style: "display:none",
      onchange: async () => {
        const file = projectFile.files[0];
        projectFile.value = "";
        if (!file) return;
        try {
          await library.openFile(file);
        } catch (error) {
          alert(`Could not open the project: ${error.message}`);
        }
      },
    });
    return dom.el("header", {},
      dom.el("strong", {}, "web_blot"),
      library.headerParts(),
      dom.button("Add blots…", "add-blots", () => files.click(), "Open one or more blot images; each becomes a blot."),
      dom.button("Sample blot", "add-sample", app.addSample),
      dom.button("Open project…", "open-project-button", () => projectFile.click(),
        "Open a project file as a new project. The project that is open stays in the browser."),
      dom.button("Save project", "save-project", project.save, "Download this project as one file with all blots, settings and image data."),
      dom.el("label", {}, "Blot size", dom.el("input", {
        type: "range", min: 200, max: 1100, step: 10, value: state.cardWidth, "data-t": "card-size",
        oninput: (ev) => { state.cardWidth = Number(ev.target.value); app.changed("tool"); },
      })),
      dom.check("Hide blots", state.hideBlots, "hide-blots", (v) => { state.hideBlots = v; app.changed("tool"); },
        "Give the whole area to the lane plots or the figure."),
      library.statusPart(),
      files, projectFile);
  }

  function renderSide(kinds) {
    const side = document.getElementById("side");
    const relevant = ["blots", "select", "panel", "quant", "lanes", "tool"].some((k) => kinds.has(k));
    if (!side || !relevant) return;
    // keep the keyboard focus on the same control across the rebuild
    const active = document.activeElement;
    let focus = null;
    if (active && side.contains(active) && active.dataset.t) {
      const same = [...side.querySelectorAll(`[data-t="${active.dataset.t}"]`)];
      focus = [active.dataset.t, same.indexOf(active)];
    }
    const blot = app.blot();
    const body = !blot
      ? [dom.el("p", { class: "hint" }, "Add a blot to begin.")]
      : state.tab === "prepare" ? panels.prepare(blot)
      : state.tab === "lanes" ? panels.lanes(blot)
      : state.tab === "quantify" ? quantify.panel(blot)
      : figurepanel.panel(blot);
    side.replaceChildren(
      dom.el("nav", {}, TABS.map(([key, label]) =>
        dom.el("button", {
          type: "button", "data-t": `tab-${key}`, class: state.tab === key ? "active" : "",
          onclick: () => { state.tab = key; state.tool = null; app.changed("panel", "tool"); },
        }, label))),
      blot ? dom.el("p", { class: "selected-name", "data-t": "selected-name" }, blot.name) : null,
      ...body.flat().filter(Boolean));
    if (focus) {
      const target = side.querySelectorAll(`[data-t="${focus[0]}"]`)[focus[1]];
      if (target) target.focus();
    }
  }

  // ------------------------------------------------------------------- layout

  // Sizes the user gave the side panel and the lower panel by dragging their
  // bars; null is the default. A setting of the page, not of the project.
  const LAYOUT = "web_blot.layout";
  const layout = { side: null, lower: null };
  try {
    Object.assign(layout, JSON.parse(localStorage.getItem(LAYOUT)) || {});
  } catch (error) {
    // nothing stored, or no storage: the defaults
  }

  function applyLayout() {
    const side = document.getElementById("side");
    const main = document.querySelector("main");
    if (!side || !main) return;
    side.style.width = layout.side ? `${num.clip(layout.side, 260, Math.max(0.6 * window.innerWidth, 260))}px` : "";
    main.classList.toggle("sized", !!layout.lower);
    // the blots keep at least 120 px; 31 px are the padding of the area and the bar
    const room = main.getBoundingClientRect().height - 31 - 120;
    document.getElementById("lower").style.height = layout.lower ? `${num.clip(layout.lower, 120, Math.max(room, 120))}px` : "";
  }

  // A bar that is dragged to change `layout[key]`; `measure(event)` gives the
  // size for a pointer position. A double-click goes back to the default.
  function dragBar(id, key, measure, title) {
    const set = (value) => {
      layout[key] = value;
      applyLayout();
      app.changed("tool"); // the plots and overlays are drawn for the size they have
    };
    const store = () => {
      try {
        localStorage.setItem(LAYOUT, JSON.stringify(layout));
      } catch (error) {
        // the size then lasts until the page is closed
      }
    };
    return dom.el("div", {
      id, class: "dragbar", "data-t": id, title,
      onpointerdown: (ev) => {
        ev.preventDefault();
        const move = (e) => set(Math.round(measure(e)));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.classList.remove("resizing");
          store();
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
      ondblclick: () => {
        set(null);
        store();
      },
    });
  }

  let lowerShows = null; // what the lower area was last built for

  function renderLower(kinds) {
    const panel = document.getElementById("lower");
    const lower = document.getElementById("lower-body");
    if (!lower) return;
    const blot = app.blot();
    document.getElementById("lower-title").textContent =
      state.tab === "quantify" ? `Lane profiles${blot ? ` of ${blot.name}` : ""}` : state.tab === "figure" ? "Figure preview" : "";
    const shows = `${state.tab}:${state.selected}`;
    const onlySelection = [...kinds].every((k) => k === "select" || k === "display");
    if (onlySelection && shows === lowerShows && state.tab === "quantify") {
      // same plots, another current lane: move the highlight, keep the plots
      lower.querySelectorAll("svg.plot").forEach((svg) =>
        svg.classList.toggle("current", Number(svg.dataset.index) === state.lane));
      return;
    }
    lowerShows = shows;
    panel.className = state.tab;
    // with plots or a figure below, the blots keep to the upper part of the
    // window, so that what the tab shows is in view without scrolling
    const main = panel.parentNode;
    main.classList.toggle("split", state.tab === "quantify" || state.tab === "figure");
    applyLayout();
    if (state.tab === "quantify") quantify.renderPlots(lower);
    else if (state.tab === "figure") figurepanel.renderPreview(lower);
    else lower.replaceChildren();
  }

  // The parts every other script relies on, and the file that defines each.
  const PARTS = {
    UTIF: "js/vendor/UTIF.js",
    "WB.num": "js/core/num.js",
    "WB.model": "js/core/model.js",
    "WB.imageio": "js/core/imageio.js",
    "WB.zip": "js/core/zip.js",
    "WB.store": "js/core/store.js",
    "WB.processing": "js/core/processing.js",
    "WB.lanes": "js/core/lanes.js",
    "WB.quant": "js/core/quantification.js",
    "WB.sample": "js/core/sample.js",
    "WB.figure": "js/core/figure.js",
    "WB.workspace": "js/ui/workspace.js",
    "WB.panels": "js/ui/panels.js",
    "WB.quantify": "js/ui/quantify.js",
    "WB.figurepanel": "js/ui/figurepanel.js",
    "WB.project": "js/ui/project.js",
    "WB.library": "js/ui/library.js",
  };

  // A script that did not load (a missing file, or one refused by a content
  // blocker) would otherwise only show up later as a control that does nothing.
  function missingParts() {
    const present = (path) => path.split(".").reduce((o, key) => (o ? o[key] : undefined), window) !== undefined;
    return Object.entries(PARTS).filter(([path]) => !present(path)).map(([, file]) => file);
  }

  function start() {
    const missing = missingParts();
    if (missing.length) {
      document.getElementById("app").replaceChildren(
        dom.el("div", { class: "fatal", "data-t": "load-error" },
          dom.el("h1", {}, "web_blot could not start"),
          dom.el("p", {}, "These files were not loaded:"),
          dom.el("ul", {}, missing.map((file) => dom.el("li", {}, file))),
          dom.el("p", {}, "If the files exist, a content or ad blocker is probably refusing them. Switch it off for this page and reload.")));
      return;
    }
    document.getElementById("app").replaceChildren(
      topBar(),
      dom.el("div", { id: "body" },
        dom.el("main", {},
          dom.el("div", { id: "workspace" }),
          dragBar("lower-bar", "lower", (e) => document.querySelector("main").getBoundingClientRect().bottom - 10 - e.clientY - 5.5, // the bar is 11 px high
            "Drag to change the height of this panel; double-click for the default."),
          dom.el("div", { id: "lower" },
            dom.el("div", { id: "lower-title", "data-t": "lower-title" }),
            dom.el("div", { id: "lower-body" }))),
        dragBar("side-bar", "side", (e) => window.innerWidth - e.clientX - 3,
          "Drag to change the width of the side panel; double-click for the default."),
        dom.el("aside", { id: "side" })));
    app.views.push(renderSide, renderLower);
    applyLayout();
    window.addEventListener("resize", () => {
      applyLayout();
      app.changed("tool");
    });
    // dropping image files anywhere adds them as blots
    document.addEventListener("dragover", (ev) => ev.preventDefault());
    document.addEventListener("drop", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer.files.length) addFiles([...ev.dataTransfer.files]);
    });
    app.changed("blots", "panel");
    app.flush();
    library.ready = library.start();
  }

  start();
})();
