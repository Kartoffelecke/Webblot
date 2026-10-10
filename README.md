# web_blot

Western blot / gel analysis in the browser: prepare several blots side by side,
mark lanes, quantify bands from lane profiles and build a labelled multi-panel
figure. A function-complete prototype in plain HTML and JavaScript; the visual
design is not done yet.

## Use

Open `index.html` in a browser (double-click). There is nothing to install and
no server; the files can also be put on any web host.

- **Add blots…** opens one or more images (16-bit TIFF, PNG, JPEG). Every blot
  is a card; all cards stay visible. Click a card to make it the one the side
  panel works on. Exposure (min, max, gamma, invert) is set on each card.
- **Zoom**: the −, % and + buttons on a card, or Ctrl / ⌘ + wheel (or a pinch)
  over the image, which zooms at the pointer. On a zoomed blot the wheel, or
  dragging the image itself, moves the view; the % button shows the whole blot
  again. Zooming only changes what is shown.
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
  brightfield too. *New blot from area* makes the crop rectangle a blot of its
  own instead and leaves the blot whole, for cutting one image into several
  blots.
- **Lanes**: detect lanes (from the signal or evenly spaced, optionally inside a
  drawn gel area) and edit them on the blot: drag to move, handles for length,
  width and tilt, Delete to remove.
- **Background**: per lane a rolling ball (default), one straight line, anchors
  set by hand, or *valley to valley* as in Fiji: each peak is measured above
  the straight line between its two borders, so there the borders decide the
  result.
- **Peaks**: *Detect* marks the bands of a lane. A peak ends where its flank
  has flattened (the signal falls at a tenth of the flank's steepest slope or
  less): at its foot, or at the dip towards a neighbouring hump, whether or
  not that hump is a peak of its own. A double band is therefore measured as
  two peaks, or as its first hump only; to measure it as one, drag the border
  or give both peaks the same number.
- **Quantify**: one plot per lane. Drag a peak's borders, double-click to add a
  peak, right-click to remove one, Shift + double-click for background anchors.
  The table has one row per lane and one column per peak number. With
  *Normalize across samples* ticked, each peak is divided by its largest area
  among the lanes, so every column runs up to 1; this applies to the table,
  Copy and the CSV, and is saved with the project. *Copy* puts the numbers on
  the clipboard for pasting into a spreadsheet; tick *Copy headers* to include
  the title row and the lane numbers, which the CSV file always has.
- **Figure**: the figure stacks the blots as panels. Per blot: figure area, lane
  labels, MW and band markers. For all panels: label style, font size, gel
  width, line width (mm), order. Export as SVG (the gel's own pixels embedded
  and grouped with their border, editable text) or PNG; PDF through Print.
- **Figure area**: a switch per blot, *Whole image* or *Selected area only*.
  Switched on, a box appears on the blot to move and resize; switched off, the
  box stays where it was, greyed out, for when it is switched on again. The
  same switch is in the *Cropped* column of the panel list, with one in the
  column's header for all blots at once.
- **Markers** (MW and band) stand at the side of the blot with a thin line
  across it and are dragged up and down from anywhere along that line. In the
  figure they are beside the figure area. With *Decrowd labels*, labels on one
  side of a gel that would overlap are written further out, each with a longer
  line; the lines stay straight, so for bands that are almost on top of each
  other move a marker by hand.
- **Label tables** (lane labels, MW and band markers) work like a sheet: Enter
  and the up and down arrows move between rows, and cells copied from a
  spreadsheet can be pasted in. A list copied as a column and pasted into the
  lane labels goes along the lanes. A list pasted into a marker table's Label
  column goes down the markers; y and label side by side, pasted into the y
  column, also add the markers that are missing.
- **Panels**: drag the bar left of the side panel to change its width, and the
  bar above the lane plots or the figure preview to change their height;
  double-click a bar for the default. The sizes are kept by the browser.
- **Lane labels**: rows of text, one entry per lane. Tick *Collapse identical*
  on a row to give neighbouring lanes with the same text one shared label: a
  merged cell in the table style, otherwise one centred text with a bar below.
- **Projects** are stored in the browser as you work; nothing has to be
  pressed, and after a reload the project that was open is there again. The
  field next to the title names the project (empty: it goes by its first
  blot). **Projects…** lists all projects of this browser: open another one,
  start a new one, rename, duplicate, delete.
- **Save project** downloads the open project as one `.webblot.json` with all
  blots, settings and the original image data; **Open project…** adds such a
  file as a new project and opens it.
- **Export library** (under Projects…) downloads every project in one
  `.webblot.zip`; **Import library…** adds the projects of such a file. Nothing
  is replaced on import: a project that is here unchanged is skipped, one that
  has changed here gets the file's version beside it as "… (imported)".

The browser's storage is not a backup. It belongs to one browser on one
computer, and the browser can clear it (deleted site data, a private window, or
on its own when space runs low). Export the library for anything you need to
keep. If the browser stores nothing, the page says "Not stored" and works with
project files only. Two tabs on the same project do not overwrite each other:
the one that is behind stops saving and offers to reload or to keep its state
as a copy.

## Compared with Fiji's gel analyzer

Checked against Fiji (ImageJ 1.54g) on the same lanes and peak borders;
`test_core.py` keeps some of its numbers.

| | Fiji | web_blot |
|---|---|---|
| Lanes | rectangles, all the size of the first, not tilted | each its own size, tilt possible |
| Profile | mean across the lane's width | the same: identical numbers for untilted lanes |
| Values | linear, unless "Uncalibrated OD" is ticked | linear |
| Background | straight lines drawn by hand, usually valley to valley | rolling ball, straight line, anchors, or valley to valley |
| Area | pixels enclosed on the plot picture + half the perimeter | sum of profile minus background, in intensity x px |

With the valley-to-valley background and the same borders, Fiji's area is
web_blot's times the scale of Fiji's plot picture, which is one number for all
lanes of a Fiji session and so cancels when bands are normalised within a gel.
What remains is Fiji's rounding to plot pixels: about 1 % for ordinary peaks,
and 5 to 30 % too small for peaks that are only a few pixels high on its plot.
The rolling ball gives other numbers than valley to valley, by a few per cent
for separate bands on a flat background and by tens of per cent for bands that
sit on a slope or close together.

With "Uncalibrated OD" ticked, Fiji reduces the image to 8 bits and takes a
logarithm of the profile; that is not a constant factor and is not reproduced here.

## Files

A project file (`.webblot.json`, version 7):

```
{ "app": "web_blot", "version": 7, "name": "...", "style": {...}, "normalize": false,
  "images": { "<key>": { "w", "h", "dtype": "uint16" | "float32", "data": "<base64>" } },
  "blots": [{ "name", "include", "labels", "roi", "session": { "transform", "lanes", "figure" },
              "wb": "<key>", "bf": "<key>" | null, "bf_origin": {...} | null }] }
```

Each image is in the file once; blots made from the same image (*New blot from
area*) share it. Older files still open: up to version 6 a figure area was in
use whenever a blot had one (now `figure.crop_on` says so), version 5 had the
line width in points (`style.line_width`; it is converted to `line_width_mm`),
version 4 also had each image inside its blot. Versions before 4 do not open.

Project files from version 4 on and library files stay readable: when a format
changes, it gets a new version number and the page converts the older ones on
opening (`project.upgrade` in `js/ui/project.js`).

A library file (`.webblot.zip`) is an ordinary zip file:

```
library.json                    { "app": "web_blot", "kind": "library", "version": 1,
                                  "projects": [{ "id", "name", "created", "modified", "file" }] }
projects/<name>.webblot.json    one project file per project
```

Unzipped, each project file opens on its own. A zip of project files without
`library.json` can be imported too.

## Limits

- No zoom inside a plot.
- No TIFF export; PDF through the print dialog.

## Layout

```
index.html
css/app.css
js/vendor/     UTIF.js (TIFF decoding) and pako, pinned copies with licences
js/core/       no interface code: numerics, image reading, lanes, quantification, figure,
               zip files, the browser's storage
js/ui/         state, workspace cards, side panels, lane plots, project files, the library
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

`test_core.py` runs each core function in the page and compares the result with
numpy / scipy, or with the reference values recorded in `tests/data`
(`reference.json`, and `reference.npz` for the long curves). After a deliberate
change to how peaks are found, `uv run python record_reference.py` records the
values that depend on it again; look at the difference before committing it.
`test_ui.py` drives the interface with real mouse and keyboard events.
`test_library.py` covers the projects in the browser and the library file.
`uv run python screenshots.py <folder>` writes screenshots of the main views
using the real blot `tests/data/chemidoc_lc3.tif`; the tests that use this blot
are skipped if the file is not there.
