// Light or dark: the system's choice unless one was made here. Loaded in the
// head, before anything is drawn, so that the page does not flash.
(function () {
  "use strict";
  const KEY = "web_blot.theme";
  const root = document.documentElement;
  const stored = () => {
    try {
      return localStorage.getItem(KEY);
    } catch (error) {
      return null;
    }
  };
  const system = () => (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const apply = (theme) => {
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
  };
  apply(stored());
  window.WBTheme = {
    // "light" or "dark", as the page is shown now
    current: () => root.dataset.theme || system(),
    // switch to the other one and remember it; the system's own choice is not stored
    toggle() {
      const next = this.current() === "dark" ? "light" : "dark";
      apply(next === system() ? null : next);
      try {
        if (next === system()) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch (error) {
        // lasts until the page is closed
      }
      return next;
    },
  };
})();
