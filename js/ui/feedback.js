// What the page tells the user: short messages at the bottom of the window,
// with a way back where something was removed, and questions before what
// cannot be undone.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const { dom } = WB;
  const feedback = (WB.feedback = {});

  function holder() {
    let node = document.getElementById("toasts");
    if (!node) {
      node = dom.el("div", { id: "toasts", role: "status", "aria-live": "polite" });
      document.body.append(node);
    }
    // above an open dialog, which is drawn over everything else in the page
    const open = [...document.querySelectorAll("dialog[open]")].pop();
    (open || document.body).append(node);
    return node;
  }

  // Say `message`. An error stays until it is closed, anything else goes after
  // a few seconds. `action`: { label, run } adds a button, such as Undo.
  feedback.toast = function (message, { error = false, action = null } = {}) {
    const node = dom.el("div", { class: `toast${error ? " error" : ""}`, "data-t": error ? "toast-error" : "toast" },
      dom.el("span", { "data-t": "toast-text" }, message));
    const close = () => node.remove();
    if (action)
      node.append(dom.button(action.label, "toast-action", () => {
        close();
        action.run();
      }));
    node.append(dom.icon("close", "toast-close", close, "Dismiss", "small"));
    holder().append(node);
    if (!error) setTimeout(close, action ? 9000 : 5000);
    return node;
  };

  feedback.error = (message) => feedback.toast(message, { error: true });

  // Ask before something that cannot be undone. Resolves to true or false.
  // `ok` names what will happen, as the button says it.
  feedback.confirm = function (message, ok, { danger = false } = {}) {
    return new Promise((resolve) => {
      const dialog = dom.el("dialog", { class: "confirm", "data-t": "confirm" });
      const done = (answer) => {
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      const yes = dom.primary(ok, "confirm-ok", () => done(true));
      if (danger) yes.classList.add("danger");
      dialog.append(
        dom.el("p", { "data-t": "confirm-text" }, message),
        dom.el("div", { class: "dialog-foot" }, dom.button("Cancel", "confirm-cancel", () => done(false)), yes));
      dialog.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        done(false);
      });
      document.body.append(dialog);
      dialog.showModal();
      yes.focus();
    });
  };
})();
