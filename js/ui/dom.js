// Small DOM helpers; the interface is built from plain elements.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const dom = (WB.dom = {});
  const SVG_NS = "http://www.w3.org/2000/svg";

  function fill(node, attrs, kids, isSvg) {
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (!isSvg && (key === "value" || key === "checked" || key === "disabled")) node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  dom.el = (tag, attrs, ...kids) => fill(document.createElement(tag), attrs, kids, false);
  dom.svg = (tag, attrs, ...kids) => fill(document.createElementNS(SVG_NS, tag), attrs, kids, true);

  dom.download = function (name, content, type = "application/octet-stream") {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = dom.el("a", { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ----- form controls; `t` becomes data-t, the handle used by the tests -----

  dom.button = (label, t, onClick, title) =>
    dom.el("button", { type: "button", "data-t": t, title, onclick: onClick }, label);

  dom.number = function (value, options, onChange) {
    const { t, min, max, step = "any", width = 70, disabled } = options;
    const input = dom.el("input", {
      type: "number",
      "data-t": t,
      min,
      max,
      step,
      value: value === null || value === undefined ? "" : value,
      disabled,
      style: `width:${width}px`,
      onchange: () => {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) onChange(v);
      },
    });
    return input;
  };

  dom.text = (value, t, onChange, attrs = {}) => {
    const input = dom.el("input", {
      type: "text",
      "data-t": t,
      value: value || "",
      ...attrs,
      onchange: () => onChange(input.value),
    });
    return input;
  };

  dom.check = function (label, checked, t, onChange, title) {
    const input = dom.el("input", {
      type: "checkbox",
      "data-t": t,
      checked: !!checked,
      onchange: () => onChange(input.checked),
    });
    return dom.el("label", { class: "check", title }, input, label);
  };

  dom.select = function (options, value, t, onChange) {
    const select = dom.el(
      "select",
      { "data-t": t, onchange: () => onChange(select.value) },
      options.map(([v, label]) => dom.el("option", { value: v }, label))
    );
    select.value = value;
    return select;
  };

  dom.row = (label, ...controls) =>
    dom.el("div", { class: "row" }, label ? dom.el("span", { class: "row-label" }, label) : null, controls);

  dom.group = (title, ...rows) => dom.el("fieldset", {}, dom.el("legend", {}, title), rows);
})();
