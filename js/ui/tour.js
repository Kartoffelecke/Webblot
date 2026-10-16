// The tour: what a first visit shows over the page. One part of the page at a
// time is lit, with a card beside it saying what it is for. It is shown once;
// the help dialog offers it again.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom, app } = WB;
  const tour = (WB.tour = {});

  const SEEN = "web_blot.tour"; // "done" once the tour was finished or skipped

  // Each stop: the parts of the page it lights (selectors; all of them that are
  // on screen together), a title and what it says. Without a part on screen the
  // card stands in the middle.
  const STOPS = [
    {
      title: "Welcome to web_blot",
      text: "Analyse western blots and gels in the browser: prepare the images, mark the lanes, measure the bands and build a labelled figure. Your images never leave this computer.",
    },
    {
      parts: ["[data-t=add-sample]", "[data-t=add-blots]"],
      title: "Add your blots",
      text: "Open 16-bit TIFF, PNG or JPEG images, or drop them anywhere on the page. Each image becomes a blot. Sample adds a made-up blot to try things on.",
    },
    {
      parts: [".stepper"],
      title: "Four steps",
      text: "Prepare (rotate, crop, merge a marker image), Lanes, Quantify and Figure. The panel on the right always belongs to the step that is open. Keys 1 to 4 switch between them.",
    },
    {
      parts: ["#tree"],
      title: "Folders",
      text: "One folder per experiment, with its blots and figures. Everything is saved as you work, in the browser or, in Chrome and Edge, in a folder on your computer.",
    },
    {
      parts: ["[data-t=save-status]", "[data-t=save-project]"],
      title: "Saved, and taken along",
      text: "Here you see whether everything is saved. Download folder gives a zip file: keep it as a copy, or open it on another computer with Open file… in the folder panel.",
    },
    {
      parts: ["[data-t=help]"],
      title: "Help",
      text: "Lists what the mouse and the keys do on the blots and in the plots, and starts this tour again.",
    },
    {
      title: "Ready",
      text: "Start with your own images, or look around with the sample blot first.",
      last: true,
    },
  ];

  const PAD = 6; // px of room around a lit part
  const GAP = 12; // px between the lit part and the card

  // { left, top, right, bottom } around the parts of a stop that are on screen, or null
  function litBox(stop) {
    const rects = (stop.parts || [])
      .flatMap((sel) => [...document.querySelectorAll(sel)])
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)) - PAD,
      top: Math.min(...rects.map((r) => r.top)) - PAD,
      right: Math.max(...rects.map((r) => r.right)) + PAD,
      bottom: Math.max(...rects.map((r) => r.bottom)) + PAD,
    };
  }

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

  tour.start = function (at = 0) {
    if (document.querySelector("[data-t=tour]")) return;
    let index = at;
    const spot = dom.el("div", { class: "tour-spot", "data-t": "tour-spot" });
    const count = dom.el("span", { class: "tour-count", "data-t": "tour-count" });
    const title = dom.el("h2", { id: "tour-title", "data-t": "tour-title" });
    const text = dom.el("p", { "data-t": "tour-text" });
    const actions = dom.el("div", { class: "tour-actions" });
    const card = dom.el("div", { class: "tour-card", "data-t": "tour-card" },
      dom.el("div", { class: "tour-head" }, title, count), text, actions);
    const dialog = dom.el("dialog", { class: "tour", "data-t": "tour", "aria-labelledby": "tour-title" }, spot, card);

    const close = () => {
      remember();
      dialog.close();
    };
    const go = (to) => {
      index = Math.min(Math.max(to, 0), STOPS.length - 1);
      show();
    };

    function place() {
      const box = litBox(STOPS[index]);
      dialog.classList.toggle("centred", !box);
      if (!box) {
        spot.style.cssText = "";
        card.style.cssText = "";
        return;
      }
      Object.assign(spot.style, {
        left: `${box.left}px`, top: `${box.top}px`,
        width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px`,
      });
      // below the part if there is room, otherwise above it; beside it if neither
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = box.bottom + GAP;
      let left = (box.left + box.right) / 2 - w / 2;
      if (top + h > vh - GAP) top = box.top - GAP - h;
      if (top < GAP) {
        top = (box.top + box.bottom) / 2 - h / 2;
        left = box.right + GAP + w < vw - GAP ? box.right + GAP : box.left - GAP - w;
      }
      card.style.left = `${Math.min(Math.max(left, GAP), Math.max(vw - w - GAP, GAP))}px`;
      card.style.top = `${Math.min(Math.max(top, GAP), Math.max(vh - h - GAP, GAP))}px`;
    }

    function show() {
      const stop = STOPS[index];
      title.textContent = stop.title;
      text.textContent = stop.text;
      count.textContent = `${index + 1} of ${STOPS.length}`;
      const next = stop.last
        ? dom.primary("Done", "tour-done", close)
        : dom.primary([index ? "Next" : "Show me around", WB.icon("arrow-right")], "tour-next", () => go(index + 1));
      actions.replaceChildren(...[
        stop.last ? null : dom.button("Skip", "tour-skip", close, "Close the tour; the help (?) offers it again."),
        dom.el("span", { class: "spacer" }),
        index ? dom.button("Back", "tour-back", () => go(index - 1)) : null,
        stop.last ? dom.button("Try the sample blot", "tour-sample", () => { close(); app.addSample(); }) : null,
        next,
      ].filter(Boolean));
      place();
      next.focus();
    }

    // arrows go through the stops; Esc (the dialog's own cancel) closes
    dialog.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight" && index < STOPS.length - 1) go(index + 1);
      else if (ev.key === "ArrowLeft" && index > 0) go(index - 1);
    });
    dialog.addEventListener("cancel", remember);
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    dialog.addEventListener("close", () => {
      window.removeEventListener("resize", onResize);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    show();
  };

  // On a first visit, once the page has settled.
  tour.offer = function () {
    if (!tour.seen()) tour.start();
  };
})();
