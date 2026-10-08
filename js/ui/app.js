// Page layout and start-up.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, imageio, panels, quantify, figurepanel, project } = WB;

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
        if (file.name.endsWith(".json")) await project.open(file);
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
        if (state.blots.length && !confirm("Opening a project closes the blots that are open. Continue?")) return;
        try {
          await project.open(file);
        } catch (error) {
          alert(`Could not open the project: ${error.message}`);
        }
      },
    });
    return dom.el("header", {},
      dom.el("strong", {}, "web_blot"),
      dom.button("Add blots…", "add-blots", () => files.click(), "Open one or more blot images; each becomes a blot."),
      dom.button("Sample blot", "add-sample", app.addSample),
      dom.button("Open project…", "open-project-button", () => projectFile.click()),
      dom.button("Save project", "save-project", project.save, "Download one file with all blots, settings and image data."),
      dom.el("label", {}, "Blot size", dom.el("input", {
        type: "range", min: 200, max: 1100, step: 10, value: state.cardWidth, "data-t": "card-size",
        oninput: (ev) => { state.cardWidth = Number(ev.target.value); app.changed("tool"); },
      })),
      dom.check("Hide blots", state.hideBlots, "hide-blots", (v) => { state.hideBlots = v; app.changed("tool"); },
        "Give the whole area to the lane plots or the figure."),
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

  let lowerShows = null; // what the lower area was last built for

  function renderLower(kinds) {
    const lower = document.getElementById("lower");
    if (!lower) return;
    const shows = `${state.tab}:${state.selected}`;
    const onlySelection = [...kinds].every((k) => k === "select" || k === "display");
    if (onlySelection && shows === lowerShows && state.tab === "quantify") {
      // same plots, another current lane: move the highlight, keep the plots
      lower.querySelectorAll("svg.plot").forEach((svg) =>
        svg.classList.toggle("current", Number(svg.dataset.index) === state.lane));
      return;
    }
    lowerShows = shows;
    lower.className = state.tab;
    // with plots or a figure below, the blots keep to the upper part of the
    // window, so that what the tab shows is in view without scrolling
    const main = lower.parentNode;
    main.classList.toggle("split", state.tab === "quantify" || state.tab === "figure");
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
        dom.el("main", {}, dom.el("div", { id: "workspace" }), dom.el("div", { id: "lower" })),
        dom.el("aside", { id: "side" })));
    app.views.push(renderSide, renderLower);
    window.addEventListener("resize", () => app.changed("tool"));
    // dropping image files anywhere adds them as blots
    document.addEventListener("dragover", (ev) => ev.preventDefault());
    document.addEventListener("drop", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer.files.length) addFiles([...ev.dataTransfer.files]);
    });
    app.changed("blots", "panel");
    app.flush();
  }

  start();
})();
