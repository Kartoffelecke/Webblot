# web_blot

Western blot / gel analysis in the browser: prepare several blots side by side,
mark lanes, quantify bands from lane profiles and build a labelled multi-panel
figure. A function-complete prototype of [napari-blot](../napari-blot) in plain
HTML and JavaScript; the visual design is not done yet.

## Use

Open `index.html` in a browser (double-click). There is nothing to install and
no server; the files can also be put on any web host.

- **Add blots…** opens one or more images (16-bit TIFF, PNG, JPEG). Every blot
  is a card; all cards stay visible. Click a card to make it the one the side
  panel works on. Exposure (min, max, gamma, invert) is set on each card.
- **Order**: drag a card by its ⠿ handle and drop it beside another card to
  change the order; this is also the order of the panels in the figure.
- **Brightfield**: a blot can have a brightfield image of the same membrane
  (with the visible marker) merged into its display. Choose a file in the
  Prepare panel, or drag another blot by its handle onto the blot's image. A
  second row of min, max and gamma for the brightfield then appears under the
  image. *Split off* makes it a blot of its own again, with the name and
  settings it had. The brightfield is never measured. It is left out of the
  figure unless *Show the brightfield (marker) in the figure* is ticked for
  that blot on the Figure tab.
- **Prepare**: rotate, straighten along a drawn line, crop, copy the setup from
  another blot. Crop rectangles and straighten lines stay on the blot, can be
  adjusted, and are applied with a button. Rotation and crop apply to the
  brightfield too.
- **Lanes**: detect lanes (from the signal or evenly spaced, optionally inside a
  drawn gel area) and edit them on the blot: drag to move, handles for length,
  width and tilt, Delete to remove.
- **Quantify**: one plot per lane. Drag a peak's borders, double-click to add a
  peak, right-click to remove one, Shift + double-click for background anchors.
  The table has one row per lane and one column per peak number.
- **Figure**: the figure stacks the blots as panels. Per blot: figure area, lane
  labels, MW and band markers. For all panels: label style, font size, gel
  width, line width, order. Export as SVG (the gel's own pixels embedded,
  editable text) or PNG; PDF through Print.
- **Lane labels**: rows of text, one entry per lane. Tick *Collapse identical*
  on a row to give neighbouring lanes with the same text one shared label: a
  merged cell in the table style, otherwise one centred text with a bar below.
- **Save project** downloads one `.webblot.json` with all blots, settings and
  the original image data; **Open project…** restores it. While this is a
  prototype, a project saved by another version of the page cannot be opened.

## Differences from napari-blot

- All blots are visible at once; the figure is always the multi-panel figure.
- The lane plots are always the stacked view.
- No zoom inside an image or a plot; "Blot size" scales all cards.
- No TIFF export; PDF through the print dialog.
- Projects are single files with the images inside, instead of sidecar files.
- napari-blot's `.blot.json` files cannot be opened.

The measured numbers agree with napari-blot: the same algorithms are used, and
the tests compare the two directly.

## Layout

```
index.html
css/app.css
js/vendor/     UTIF.js (TIFF decoding) and pako, pinned copies with licences
js/core/       no interface code: numerics, image reading, lanes, quantification, figure
js/ui/         state, workspace cards, side panels, lane plots, project files
tests/         browser tests (Python, Playwright)
```

Scripts are plain `<script>` files sharing one global `WB` object, not modules,
so that the page works when opened from the file system.

Script file names matter: content blockers refuse files by name. `quant.js`, the
obvious name for the quantification code, is the name of a tracking script and
is on the EasyPrivacy list, so that file is called `quantification.js`. If a
script does not load, the page says which one instead of starting.

## Tests

```sh
cd tests
uv sync
uv run playwright install chromium webkit   # once
uv run pytest
```

The tests run in Chromium (Chrome, Edge) and in WebKit (Safari's engine).

`test_core_parity.py` runs each core function in the page and compares it with
napari-blot's Python implementation (expected in `../napari-blot`).
`test_ui.py` drives the interface with real mouse and keyboard events.
`uv run python screenshots.py <folder>` writes screenshots of the main views
using the blot in `../napari-blot/data`.
