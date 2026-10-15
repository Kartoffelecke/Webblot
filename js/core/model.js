// The data model: plain objects.
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const model = (WB.model = {});

  // The folder that is open: its name (empty: it goes by the name of its first
  // blot) and its directory in the work folder (null: not written yet).
  model.folder = () => ({ name: "", dir: null });

  // A figure of a folder: a name, a style, and for each blot that has to do
  // with it how it is shown: blot id -> { include, labels, crop, crop_on,
  // show_bf }. `dir` is its directory in the folder (null: not written yet).
  model.newFigure = (name = "Figure") => ({ id: model.newId(), name, style: model.style(), panels: new Map(), dir: null });

  // a random name for an image
  model.newId = function () {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  model.BASELINE_METHODS = ["none", "rolling", "linear", "manual", "valley"];

  model.baseline = () => ({
    method: "rolling",
    radius: 40,
    linear_ends: null, // heights at the lane's two ends; null = from the profile
    anchors: [], // manual anchors as [position along lane, intensity]
  });

  model.transform = () => ({
    rotation_deg: 0,
    crop: null, // [y0, x0, y1, x1] in the rotated image
    bands_dark: false,
    invert_lut: false,
    contrast_limits: null,
    gamma: 1,
    // the brightfield image merged into the display, if the blot has one
    bf_show: true,
    bf_invert: false, // tick if its marker bands are bright
    bf_contrast_limits: null,
    bf_gamma: 1,
  });

  model.figure = () => ({
    // The figure shows the whole image, or with `crop_on` only the area `crop`:
    // [y0, x0, y1, x1] in the working image, pixel-edge coordinates. The area
    // is kept while it is switched off.
    crop: null,
    crop_on: false,
    show_bf: false, // merge the blot's brightfield image (the marker) into the gel
    // { title, values: [one string per lane], collapse }; with `collapse`,
    // neighbouring lanes with the same text share one label
    label_rows: [],
    mw_markers: [], // { y, text }
    mw_side: "left",
    band_markers: [],
    band_side: "right",
  });

  model.session = () => ({
    transform: model.transform(),
    lanes: [],
    figure: model.figure(),
  });

  // Settings shared by all panels of the figure.
  model.style = () => ({
    label_rotation: 0,
    label_style: "plain", // "plain" or "table" (boxed cells)
    mw_unit: "",
    mw_unit_position: "each", // "each": after every label, "top": once above them
    font_size: 8,
    gel_width_mm: 60,
    line_width_mm: 0.2,
    decrowd: false, // move side labels that overlap outwards, each with a longer line
    lossless: true, // the gel keeps its own pixels
    dpi: 300,
    gap_mm: 2,
  });

  model.copy = (value) => JSON.parse(JSON.stringify(value));

  // Give `target` the geometry and lane labels of `source`: rotation, crop,
  // lanes (position, size, tilt, background settings), figure area and lane
  // labels. Not copied: peaks, exposure, markers.
  model.copySetup = function (source, target) {
    target.transform.rotation_deg = source.transform.rotation_deg;
    target.transform.crop = model.copy(source.transform.crop);
    target.lanes = source.lanes.map((lane) => ({
      ...model.copy(lane),
      peaks: [],
    }));
    target.figure.crop = model.copy(source.figure.crop);
    target.figure.crop_on = source.figure.crop_on;
    target.figure.label_rows = model.copy(source.figure.label_rows);
  };
})();
