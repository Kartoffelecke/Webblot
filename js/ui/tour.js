// Tours over the page: one part of it at a time is lit, with a card beside it
// saying what it is for.
//
// - The page tour, on a first visit: what is where. It is shown once; the help
//   dialog offers it again.
// - The analysis walkthrough: the sample blot taken through all four steps in
//   a folder of its own, each step done by the page as a user would do it
//   (the same buttons are pressed), with a card saying what happened.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app, state, library, tree } = WB;
  const tour = (WB.tour = {});

  const SEEN = "web_blot.tour"; // "done" once the page tour was finished or skipped

  const PAD = 6; // px of room around a lit part
  const GAP = 12; // px between the lit part and the card

  // ------------------------------------------------------------------- stops
  //
  // A stop: the parts of the page it lights (selectors; all of them that are on
  // screen together), a title and what it says. Without a part on screen the
  // card stands in the middle. `enter` is done before the stop is shown, when
  // it is reached going forwards.

  const PAGE = [
    {
      title: "Welcome to webblot",
      text: "Quantify Western Blots and create publication-ready figures. Everything runs locally and your images never leave this computer.",
    },
    {
      parts: ["[data-t=add-sample]", "[data-t=add-blots]"],
      title: "Add your blots",
      text: "Open 16-bit TIFF, PNG or JPEG images, or drop them anywhere on the page. Each image becomes a blot.",
    },
    {
      parts: [".stepper"],
      title: "Four steps",
      text: "Prepare (rotate, crop, merge a marker image), Lanes, Quantify and Figure. The panel on the right always belongs to the step that is open. Keys 1 to 4 switch between them.",
    },
    {
      parts: ["#tree"],
      title: "Folders",
      text: "Your experiments are organized in folders. Each folder should contain all blots belonging to one experiment. On Chrome and Edge, the folder can be located on your disk directly. On other browsers, they live in the browser storage and should be downloaded occasionally.",
    },
    {
      parts: ["[data-t=save-status]", "[data-t=save-project]"],
      title: "Download a backup",
      text: "Download folder gives a zip file: keep it as a copy, or open it on another computer with Open file… in the folder panel.",
    },
    {
      parts: ["[data-t=help]"],
      title: "Help",
      text: "Lists what the mouse and the keys do on the blots and in the plots, and starts these tours again.",
    },
    {
      title: "Ready",
      text: "Start with your own images, or let the walkthrough take the sample blot through all four steps first: crop, lanes, quantification and figure.",
      end: [
        { label: "Walk through an analysis", t: "tour-walkthrough", primary: true, run: () => tour.walkthrough() },
        { label: "Done", t: "tour-done" },
      ],
    },
  ];

  // The sample, after the crop below: the rows of its ladder (in the
  // brightfield) and of its three bands.
  const CROP = [29.5, 19.5, 389.5, 619.5]; // [y0, x0, y1, x1] of the sample image, pixel edges
  const LADDER = [[20, "250"], [84, "130"], [148, "70"], [212, "35"], [276, "25"], [340, "15"]];
  const BANDS = [[60, "Protein A"], [170, "Protein B"], [290, "Loading control"]];
  const GROUPS = ["Control", "Control", "Control", "Control", "Treated", "Treated", "Treated", "Treated"];

  // what the walkthrough works on, and where the user was before it
  const walk = { blot: null, folder: null, before: null };
  const blot = () => app.blot(walk.blot);

  // the button of the page with this handle, pressed as by the user
  const press = (t) => {
    app.flush();
    const button = document.querySelector(`[data-t="${t}"]`);
    if (!button) throw new Error(`The page has no button "${t}" here.`);
    button.click();
  };

  const WALK = [
    {
      title: "An analysis, step by step",
      text: "This walkthrough takes a made-up blot through all four steps: crop, lanes, quantification and figure. It works in a new folder of its own, “Tutorial”; your folders stay as they are. Press Next to let the page do each step.",
    },
    {
      parts: ["[data-t=card]"],
      title: "1 · Prepare: the blot",
      text: "The sample blot has a brightfield image already merged. You can adjust the brightness with the sliders below.",
      enter: async () => {
        walk.before = state.folder.dir;
        if (tree.store.kind !== "none") {
          await library.newFolder("Tutorial");
          walk.folder = state.folder.dir;
        }
        app.addSample();
        walk.blot = state.blots[state.blots.length - 1].id;
        app.select(walk.blot);
        app.setStep("prepare");
      },
    },
    {
      parts: ["[data-t=card]", "[data-t=tool-crop]"],
      title: "Crop",
      text: "You can crop parts of the image or create a new blot from the selection.",
      enter: () => {
        blot().pending.crop = CROP;
        app.changed("panel", "tool");
      },
    },
    {
      parts: ["[data-t=card]", "[data-t=crop-apply]"],
      title: "Apply crop",
      text: "Apply crop keeps the area. The image file stays whole: the crop can be undone or changed later.",
      enter: () => press("crop-apply"),
    },
    {
      parts: ["[data-t=card]", "[data-t=detect-lanes]"],
      title: "2 · Lanes",
      text: "Detect lanes finds the lanes from the signal or distributes them equally. You can move, resize and tilt individual lanes",
      enter: () => {
        app.setStep("lanes");
        press("detect-lanes");
      },
    },
    {
      parts: ["#lower"],
      title: "3 · Quantify",
      text: "For each lane, the average intensity across its width is plotted below. The background is estimated using a rolling-ball method (default) but can also be set as a straight line or to connect the valleys of each peak.",
      enter: () => {
        app.setStep("quantify");
        press("detect-all");
      },
    },
    {
      parts: ["[data-t=results]", "[data-t=results-csv]"],
      title: "Quantification results",
      text: "You can copy the quantification results to the clipboard or download them as a CSV. Peaks are enumerated up-to-down for each lane.",
    },
    {
      parts: ["#lower"],
      title: "4 · Figure",
      text: "In this step you can prepare a multi-blot figure, with labeling, cropping and addition of protein and MW markers",
      enter: () => {
        app.setStep("figure");
        const b = blot();
        const fig = b.session.figure;
        fig.show_bf = true;
        fig.label_rows = [{ title: "", values: GROUPS.slice(0, b.session.lanes.length), collapse: true }];
        fig.mw_markers = LADDER.map(([y, text]) => ({ y, text }));
        fig.band_markers = BANDS.map(([y, text]) => ({ y, text }));
        state.style.mw_unit = "kDa";
        state.style.mw_unit_position = "top";
        app.changed("figure", "panel");
      },
    },
    {
      parts: ["[data-t=export-svg]", "[data-t=export-png]", "[data-t=export-print]"],
      title: "Export",
      text: "Here you can export the image (I'd recommend SVG)",
    },
    {
      parts: ["#tree"],
      title: "That's all",
      text: "Everything is saved in the folder “Tutorial” as ordinary files: the settings, the images, the plots, the table and the figure. Keep it to look at again, or delete it.",
      end: [
        { label: "Delete the tutorial folder", t: "walk-delete", run: () => endWalkthrough(true) },
        { label: "Keep it", t: "walk-keep", primary: true },
      ],
    },
  ];

  async function endWalkthrough(remove) {
    if (!remove || !walk.folder) return;
    await library.removeFolder(walk.folder);
    if (walk.before && library.folders.some((f) => f.name === walk.before)) await library.open(walk.before);
  }

  // ------------------------------------------------------------------ runner

  // [{ left, top, right, bottom }] of each part of a stop that is on screen,
  // with room around it and kept on screen
  function litBoxes(stop) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return (stop.parts || [])
      .flatMap((sel) => [...document.querySelectorAll(sel)])
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        left: Math.max(r.left - PAD, 0), top: Math.max(r.top - PAD, 0),
        right: Math.min(r.right + PAD, vw), bottom: Math.min(r.bottom + PAD, vh),
      }));
  }

  // the dimmed page with a hole for each lit part, and an outline around it
  function shade(svg, boxes) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = 8;
    const hole = (b) => {
      const w = b.right - b.left;
      const h = b.bottom - b.top;
      const k = Math.min(r, w / 2, h / 2);
      return `M${b.left + k},${b.top}h${w - 2 * k}a${k},${k} 0 0 1 ${k},${k}v${h - 2 * k}a${k},${k} 0 0 1 ${-k},${k}` +
        `h${-(w - 2 * k)}a${k},${k} 0 0 1 ${-k},${-k}v${-(h - 2 * k)}a${k},${k} 0 0 1 ${k},${-k}z`;
    };
    const holes = boxes.map(hole).join("");
    svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    svg.replaceChildren(
      dom.svg("path", { class: "tour-dim", d: `M0,0H${vw}V${vh}H0z${holes}`, "fill-rule": "evenodd" }),
      ...(holes ? [dom.svg("path", { class: "tour-outline", d: holes, "data-t": "tour-spot" })] : []));
  }

  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  // Show `stops`. Options: `back` (whether Back is offered), `skip` (what Skip says),
  // `onSkip` (done when closed before the end).
  function run(stops, { back = true, skip = "", onSkip = () => {}, onEnd = () => {} } = {}) {
    if (document.querySelector("dialog.tour[open]")) return;
    let index = 0;
    let busy = false;
    let finished = false;
    const svg = dom.svg("svg", { class: "tour-shade", "aria-hidden": "true" });
    const count = dom.el("span", { class: "tour-count", "data-t": "tour-count" });
    const title = dom.el("h2", { id: "tour-title", "data-t": "tour-title" });
    const text = dom.el("p", { "data-t": "tour-text" });
    const actions = dom.el("div", { class: "tour-actions" });
    const card = dom.el("div", { class: "tour-card", "data-t": "tour-card" },
      dom.el("div", { class: "tour-head" }, title, count), text, actions);
    const dialog = dom.el("dialog", { class: "tour", "data-t": "tour", "aria-labelledby": "tour-title" }, svg, card);

    const close = () => dialog.close();

    async function go(to) {
      if (busy || to < 0 || to >= stops.length) return;
      const forward = to > index;
      index = to;
      if (forward && stops[index].enter) {
        busy = true;
        dialog.classList.add("busy");
        try {
          await stops[index].enter();
        } catch (error) {
          busy = false;
          close();
          WB.feedback.error(`The walkthrough stopped: ${error.message}`);
          return;
        }
        app.flush();
        await frame();
        busy = false;
        dialog.classList.remove("busy");
      }
      show();
    }

    function place() {
      const boxes = litBoxes(stops[index]);
      shade(svg, boxes);
      dialog.classList.toggle("centred", !boxes.length);
      if (!boxes.length) {
        card.style.cssText = "";
        return;
      }
      // the card goes beside all of them together
      const box = {
        left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)),
        right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)),
      };
      // below the part if there is room, otherwise above it, otherwise beside it,
      // otherwise over its lower right corner
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = (box.left + box.right) / 2 - w / 2;
      let top;
      if (box.bottom + GAP + h <= vh - GAP) top = box.bottom + GAP;
      else if (box.top - GAP - h >= GAP) top = box.top - GAP - h;
      else {
        top = (box.top + box.bottom) / 2 - h / 2;
        if (box.right + GAP + w <= vw - GAP) left = box.right + GAP;
        else if (box.left - GAP - w >= GAP) left = box.left - GAP - w;
        else [left, top] = [box.right - w - GAP, box.bottom - h - GAP];
      }
      card.style.left = `${Math.min(Math.max(left, GAP), Math.max(vw - w - GAP, GAP))}px`;
      card.style.top = `${Math.min(Math.max(top, GAP), Math.max(vh - h - GAP, GAP))}px`;
    }

    function show() {
      const stop = stops[index];
      // the parts in view, as far as they can be scrolled there
      const first = (stop.parts || []).map((sel) => document.querySelector(sel)).find(Boolean);
      if (first) first.scrollIntoView({ block: "nearest", inline: "nearest" });
      title.textContent = stop.title;
      text.textContent = stop.text;
      count.textContent = `${index + 1} of ${stops.length}`;
      const buttons = stop.end
        ? stop.end.map((a) => (a.primary ? dom.primary : dom.button)(a.label, a.t, async () => {
          finished = true;
          close();
          if (a.run) await a.run();
          onEnd();
        }))
        : [dom.primary([index ? "Next" : "Start", WB.icon("arrow-right")], "tour-next", () => go(index + 1))];
      actions.replaceChildren(...[
        stop.end ? null : dom.button("Skip", "tour-skip", close, skip),
        dom.el("span", { class: "spacer" }),
        back && index ? dom.button("Back", "tour-back", () => go(index - 1)) : null,
        ...buttons,
      ].filter(Boolean));
      place();
      buttons[buttons.length - 1].focus();
    }

    // arrows go through the stops; Esc (the dialog's own cancel) closes
    dialog.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight" && !stops[index].end) go(index + 1);
      else if (ev.key === "ArrowLeft" && back) go(index - 1);
    });
    dialog.addEventListener("cancel", (ev) => {
      if (busy) ev.preventDefault();
    });
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    dialog.addEventListener("close", () => {
      window.removeEventListener("resize", onResize);
      dialog.remove();
      if (!finished) onSkip();
    });
    document.body.append(dialog);
    dialog.showModal();
    show();
  }

  // ----------------------------------------------------------------- the two

  const remember = () => {
    try {
      localStorage.setItem(SEEN, "done");
    } catch (error) {
      // no storage: the tour comes again next time
    }
  };

  tour.seen = function () {
    try {
      return localStorage.getItem(SEEN) === "done";
    } catch (error) {
      return false;
    }
  };

  tour.start = () => run(PAGE, { skip: "Close the tour; the help (?) offers it again.", onSkip: remember, onEnd: remember });

  tour.walkthrough = () => run(WALK, {
    back: false,
    skip: "Stop the walkthrough; what it did so far stays.",
    onSkip: () => {
      if (walk.folder) WB.feedback.toast(`The walkthrough stopped. Its folder “${walk.folder}” stays; delete it in the folder panel when you no longer need it.`);
    },
  });

  // On a first visit, once the page has settled.
  tour.offer = function () {
    if (!tour.seen()) tour.start();
  };
})();
