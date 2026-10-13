// The icons, as small line drawings on a 24 x 24 grid.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const NS = "http://www.w3.org/2000/svg";
  const PATHS = {
    up: "M12 19V5M6 11l6-6 6 6",
    down: "M12 5v14M6 13l6 6 6-6",
    close: "M6 6l12 12M18 6L6 18",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    check: "M5 12.5l4.5 4.5L19 7.5",
    "chevron-down": "M6 9l6 6 6-6",
    "chevron-right": "M9 6l6 6-6 6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z",
    moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
    help: "M9.2 9a3 3 0 115 2.3c-1 .8-2.2 1.5-2.2 3M12 18h.01M12 3a9 9 0 100 18 9 9 0 000-18z",
    folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
    download: "M12 4v11M7 11l5 5 5-5M5 20h14",
    upload: "M12 16V5M7 9l5-5 5 5M5 20h14",
    "turn-left": "M4 8h10a6 6 0 010 12h-3M4 8l4-4M4 8l4 4",
    "turn-right": "M20 8H10a6 6 0 000 12h3M20 8l-4-4M20 8l-4 4",
    fill: "M4 12h12M12 8l4 4-4 4M20 5v14",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01",
    grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
    chart: "M4 20h16M7 16v-5M12 16V6M17 16v-8",
    sidebar: "M4 5h16v14H4zM9 5v14",
  };
  // An icon by name; `title` is for a picture that stands alone.
  WB.icon = function (name) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `i i-${name}`);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", PATHS[name] || "");
    if (name === "grip") path.setAttribute("stroke-width", "2.6");
    svg.append(path);
    return svg;
  };
})();
