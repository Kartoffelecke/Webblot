// The page: header, the four steps, the regions, and start-up.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, num, imageio, panels, quantify, figurepanel, library, feedback } = WB;

  // The steps a blot goes through, in order: key, name, and what the step is for.
  const STEPS = [
    ["prepare", "Prepare", "Turn, straighten and crop the blot so that its lanes run straight down."],
    ["lanes", "Lanes", "Mark the lanes: detect them, then adjust them on the blot."],
    ["quantify", "Quantify", "Find the bands of each lane and measure them."],
    ["figure", "Figure", "Label lanes and bands, and export the figure."],
  ];

  app.setStep = function (key) {
    state.tab = key;
    state.tool = null;
    app.changed("panel", "tool");
  };

  // ------------------------------------------------------------------- files

  async function addFiles(files) {
    const problems = [];
    for (const file of files) {
      try {
        if (/\.(json|zip)$/i.test(file.name)) await library.importFile(file);
        else app.addBlot(file.name.replace(/\.[^.]+$/, ""), await imageio.readFile(file));
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      }
    }
    if (problems.length) feedback.error(`Could not open:\n${problems.join("\n")}`);
  }
  app.addFiles = addFiles;

  app.addSample = function () {
    const sample = WB.sample({ seed: state.blots.length + 1 });
    app.addBlot(`Sample ${state.blots.length + 1}`, sample.wb, sample.bf).bfOrigin = app.origin({ name: "Marker" });
    app.changed("blots");
  };

  // ------------------------------------------------------------------ header

  function topBar() {
    const files = dom.el("input", {
      type: "file", multiple: true, accept: "image/*,.tif,.tiff", "data-t": "add-files", hidden: true,
      onchange: async () => { await addFiles([...files.files]); files.value = ""; },
    });
    const projectFile = dom.el("input", {
      type: "file", accept: ".zip", "data-t": "open-project", hidden: true,
      onchange: async () => {
        const file = projectFile.files[0];
        projectFile.value = "";
        if (!file) return;
        try {
          await library.importFile(file);
        } catch (error) {
          feedback.error(`Could not open the file: ${error.message}`);
        }
      },
    });
    const [nameField] = library.headerParts();
    const theme = dom.icon(WBTheme.current() === "dark" ? "sun" : "moon", "theme", () => {
      theme.replaceChildren(WB.icon(WBTheme.toggle() === "dark" ? "sun" : "moon"));
    }, "Light or dark", "quiet");
    return dom.el("header", { class: "topbar" },
      dom.el("span", { class: "brand" }, dom.el("span", { class: "brand-mark" }, dom.el("i", {})), "web_blot"),
      nameField,
      library.statusPart(),
      dom.el("span", { class: "spacer" }),
      dom.button([WB.icon("download"), "Download folder"], "save-project",
        () => library.downloadOpen().catch((error) => feedback.error(error.message)),
        "Download the open folder as a zip file that unpacks to what is on disk."),
      dom.el("span", { class: "divider" }),
      theme,
      dom.icon("help", "help", showHelp, "What the mouse and the keys do", "quiet"),
      files, projectFile);
  }

  // The steps as the page's navigation, and beside them what concerns all blots.
  function stepsBar() {
    const steps = STEPS.map(([key, label], i) => [
      i ? WB.icon("chevron-right") : null,
      dom.el("button", { type: "button", class: "step", "data-t": `tab-${key}`, "data-step": key, onclick: () => app.setStep(key) },
        dom.el("span", { class: "n" }, i + 1), label),
    ]);
    return dom.el("nav", { class: "steps", "aria-label": "Steps" },
      dom.icon("sidebar", "tree-toggle", () => {
        layout.treeHidden = !layout.treeHidden;
        applyLayout();
        storeLayout();
        app.changed("tool");
      }, "Show or hide the folders", "quiet"),
      dom.el("div", { class: "stepper" }, steps),
      dom.el("span", { class: "spacer" }),
      dom.el("div", { class: "view-controls" },
        dom.el("label", { title: "Size of the blots on the page" }, "Size", dom.el("input", {
          type: "range", min: 200, max: 1100, step: 10, value: state.cardWidth, "data-t": "card-size",
          oninput: (ev) => { state.cardWidth = Number(ev.target.value); app.changed("tool"); },
        })),
        dom.check("Hide blots", state.hideBlots, "hide-blots", (v) => { state.hideBlots = v; app.changed("tool"); },
          "Give the whole area to the lane plots or the figure."),
        dom.el("span", { class: "divider" }),
        dom.button("Sample", "add-sample", app.addSample, "Add a made-up blot with eight lanes."),
        dom.primary([WB.icon("plus"), "Add blots"], "add-blots", () => document.querySelector("[data-t=add-files]").click(),
          "Open one or more blot images; each becomes a blot. Images can also be dropped on the page.")));
  }

  // which step is open, and what the selected blot already has
  function renderSteps() {
    const blot = app.blot();
    const done = {
      prepare: !!blot,
      lanes: !!blot && blot.session.lanes.length > 0,
      quantify: !!blot && blot.session.lanes.some((lane) => lane.peaks.length),
      figure: false,
    };
    document.querySelectorAll("button.step").forEach((button, i) => {
      const key = button.dataset.step;
      const current = state.tab === key;
      button.classList.toggle("active", current);
      button.classList.toggle("done", done[key] && !current);
      button.setAttribute("aria-current", current ? "step" : "false");
      button.querySelector(".n").replaceChildren(done[key] && !current ? WB.icon("check") : String(i + 1));
    });
    document.getElementById("body").classList.toggle("no-blots", !state.blots.length);
  }

  function showHelp() {
    const row = (what, how) => [dom.el("dt", {}, what), dom.el("dd", {}, how)];
    const key = (...names) => names.map((n, i) => [i ? " + " : "", dom.el("kbd", {}, n)]);
    const dialog = dom.el("dialog", { class: "help", "data-t": "help-dialog" },
      dom.el("div", { class: "dialog-head" }, dom.el("h2", {}, "Mouse and keys"),
        dom.el("span", { class: "spacer" }),
        dom.button("Tour of the page", "help-tour", () => { dialog.close(); WB.tour.start(); }, "What is where on the page."),
        dom.button("Walk through an analysis", "help-walkthrough", () => { dialog.close(); WB.tour.walkthrough(); },
          "The sample blot taken through all four steps, in a folder of its own."),
        dom.icon("close", "help-close", () => dialog.close(), "Close", "quiet")),
      dom.el("div", { class: "dialog-body" },
        dom.el("h3", {}, "Everywhere"),
        dom.el("dl", {},
          row("Go to a step", [key("1"), " to ", key("4")]),
          row("Stop drawing, or discard what was drawn", key("Esc")),
          row("Add blots", "Drop image files on the page"),
          row("Order of the blots", "Drag a blot by its handle beside another one"),
          row("Brightfield image", "Drag a blot by its handle onto another blot's image")),
        dom.el("h3", {}, "On a blot"),
        dom.el("dl", {},
          row("Zoom", [key("Ctrl"), " or ", key("⌘"), " + wheel, or pinch"]),
          row("Move a zoomed blot", "Wheel, or drag the image"),
          row("Move a lane", "Drag it; its handles change length, width and tilt"),
          row("Remove the current lane", [key("Delete"), " on the Lanes step"]),
          row("Move a marker", "Drag it up or down, anywhere along its line")),
        dom.el("h3", {}, "In a lane plot"),
        dom.el("dl", {},
          row("Move a peak's border", "Drag it"),
          row("Add a peak", "Double-click the band"),
          row("Remove a peak", "Right-click it"),
          row("Background anchor", [key("Shift"), " + double-click adds one, or removes the one under the pointer"])),
        dom.el("h3", {}, "In the lane strip under a plot"),
        dom.el("dl", {},
          row("Move a peak's border", "Drag it"),
          row("Tilt a peak", "Drag the knob above it, for a band that runs crooked; double-click the knob to straighten it")),
        dom.el("h3", {}, "In a table of labels"),
        dom.el("dl", {},
          row("Next row", [key("Enter"), " or ", key("↓")]),
          row("Fill from a spreadsheet", "Copy the cells there and paste them into the first cell here"))));
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // -------------------------------------------------------------- side panel

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
    if (!blot) {
      side.replaceChildren();
      return;
    }
    const index = STEPS.findIndex(([key]) => key === state.tab);
    const [, label, lead] = STEPS[index];
    const next = STEPS[index + 1];
    const body = state.tab === "prepare" ? panels.prepare(blot)
      : state.tab === "lanes" ? panels.lanes(blot)
      : state.tab === "quantify" ? quantify.panel(blot)
      : figurepanel.panel(blot);
    side.replaceChildren(
      dom.el("div", { class: "side-head" },
        dom.el("div", { class: "step-title" }, `Step ${index + 1} · ${label}`),
        dom.el("div", { class: "selected-name", "data-t": "selected-name", title: blot.name }, blot.name),
        dom.el("div", { class: "lead" }, lead)),
      ...body.flat().filter(Boolean),
      next ? dom.el("div", { class: "side-foot" },
        dom.button([`Next: ${next[1]}`, WB.icon("arrow-right")], "next-step", () => app.setStep(next[0]))) : "");
    if (focus) {
      const target = side.querySelectorAll(`[data-t="${focus[0]}"]`)[focus[1]];
      if (target) target.focus();
    }
  }

  // ------------------------------------------------------------------- layout

  // Sizes the user gave the side panel and the lower panel by dragging their
  // bars; null is the default. A setting of the page, not of the project.
  const LAYOUT = "web_blot.layout";
  const layout = { side: null, lower: null, tree: null, treeHidden: false };
  const storeLayout = () => {
    try {
      localStorage.setItem(LAYOUT, JSON.stringify(layout));
    } catch (error) {
      // the size then lasts until the page is closed
    }
  };
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
    document.getElementById("tree").style.width = layout.tree ? `${num.clip(layout.tree, 150, Math.max(0.4 * window.innerWidth, 150))}px` : "";
    document.getElementById("body").classList.toggle("no-tree", !!layout.treeHidden);
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
    const store = storeLayout;
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
    // window, so that what the step shows is in view without scrolling
    const main = panel.parentNode;
    main.classList.toggle("split", !!state.blots.length && (state.tab === "quantify" || state.tab === "figure"));
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
    "WB.tree": "js/core/tree.js",
    "WB.processing": "js/core/processing.js",
    "WB.lanes": "js/core/lanes.js",
    "WB.quant": "js/core/quantification.js",
    "WB.sample": "js/core/sample.js",
    "WB.figure": "js/core/figure.js",
    "WB.icon": "js/ui/icons.js",
    "WB.feedback": "js/ui/feedback.js",
    "WB.workspace": "js/ui/workspace.js",
    "WB.panels": "js/ui/panels.js",
    "WB.quantify": "js/ui/quantify.js",
    "WB.figurepanel": "js/ui/figurepanel.js",
    "WB.library": "js/ui/library.js",
    "WB.tour": "js/ui/tour.js",
  };

  // A script that did not load (a missing file, or one refused by a content
  // blocker) would otherwise only show up later as a control that does nothing.
  function missingParts() {
    const present = (path) => path.split(".").reduce((o, key) => (o ? o[key] : undefined), window) !== undefined;
    return Object.entries(PARTS).filter(([path]) => !present(path)).map(([, file]) => file);
  }

  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

  function start() {
    const missing = missingParts();
    if (missing.length) {
      const el = (tag, text, kids = []) => {
        const node = document.createElement(tag);
        node.textContent = text;
        node.append(...kids);
        return node;
      };
      const box = el("div", "", [
        el("h1", "web_blot could not start"),
        el("p", "These files were not loaded:"),
        el("ul", "", missing.map((file) => el("li", file))),
        el("p", "If the files exist, a content or ad blocker is probably refusing them. Switch it off for this page and reload."),
      ]);
      box.className = "fatal";
      box.dataset.t = "load-error";
      document.getElementById("app").replaceChildren(box);
      return;
    }
    document.getElementById("app").replaceChildren(
      topBar(),
      stepsBar(),
      dom.el("div", { id: "body" },
        dom.el("aside", { id: "tree", "aria-label": "Folders" }),
        dragBar("tree-bar", "tree", (e) => e.clientX - 3, "Drag to change the width of the folders; double-click for the default."),
        dom.el("main", {},
          dom.el("div", { id: "workspace" }),
          dragBar("lower-bar", "lower", (e) => document.querySelector("main").getBoundingClientRect().bottom - 10 - e.clientY - 5.5, // the bar is 11 px high
            "Drag to change the height of this panel; double-click for the default."),
          dom.el("div", { id: "lower" },
            dom.el("div", { id: "lower-title", "data-t": "lower-title" }),
            dom.el("div", { id: "lower-body" }))),
        dragBar("side-bar", "side", (e) => window.innerWidth - e.clientX - 3,
          "Drag to change the width of the side panel; double-click for the default."),
        dom.el("aside", { id: "side", "aria-label": "Settings of the step" })));
    app.views.push(renderSteps, renderSide, renderLower);
    applyLayout();
    window.addEventListener("resize", () => {
      applyLayout();
      app.changed("tool");
    });
    // dropping image files anywhere adds them as blots
    const carriesFiles = (ev) => ev.dataTransfer && [...ev.dataTransfer.types].includes("Files");
    document.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      document.body.classList.toggle("dropping", carriesFiles(ev));
    });
    document.addEventListener("dragleave", (ev) => {
      if (!ev.relatedTarget) document.body.classList.remove("dropping");
    });
    document.addEventListener("drop", (ev) => {
      ev.preventDefault();
      document.body.classList.remove("dropping");
      if (ev.dataTransfer.files.length) addFiles([...ev.dataTransfer.files]);
    });
    // 1 to 4 go to the steps, ? shows what else there is
    document.addEventListener("keydown", (ev) => {
      if (typing() || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector("dialog[open]")) return;
      const step = STEPS[Number(ev.key) - 1];
      if (step) app.setStep(step[0]);
      else if (ev.key === "?") showHelp();
    });
    app.changed("blots", "panel");
    app.flush();
    library.ready = library.start();
    // a first visit gets the tour, once the folder that was open is there again
    library.ready.then(WB.tour.offer, WB.tour.offer);
  }

  start();
})();
