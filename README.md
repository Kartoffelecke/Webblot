# web_blot

Western blot / gel analysis in the browser: prepare several blots side by side,
mark lanes, quantify bands from lane profiles and build a labelled multi-panel
figure. Plain HTML and JavaScript, nothing to install.

## Use

Open `index.html` in a browser (double-click). There is nothing to install and
no server; the files can also be put on any web host.

The page follows a blot through four steps, shown as the numbered bar under the
header: **Prepare**, **Lanes**, **Quantify**, **Figure**. A tick marks the
steps the selected blot already has something for. The panel on the right
belongs to the current step: it says what the step is for, has the usual
action as its one coloured button, and ends with a button to the next step.
Its sections fold; the page remembers which are open. Keys `1` to `4` go to
the steps, and `?` (or the button at the top right) lists what the mouse and
the keys do. The page is light or dark with the system, or as set with the
button beside it.

Removing a blot or a lane asks nothing: the message at the bottom has an
*Undo*. Only what cannot be brought back is asked about first.

- **Add blots** opens one or more images (16-bit TIFF, PNG, JPEG). Every blot
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
- **Quantify**: one plot per lane. The current lane can still be moved and
  tilted here, on the blot or by number, and its plot follows. Drag a peak's borders, double-click to add a
  peak, right-click to remove one, Shift + double-click for background anchors.
  The table has one row per lane and one column per peak number. With
  *Normalize across lanes* ticked, each peak is divided by its largest area
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
- **Lane labels**: rows of text, one entry per lane. Tick *Collapse*
  on a row to give neighbouring lanes with the same text one shared label: a
  merged cell in the table style, otherwise one centred text with a bar below.
- **Folders**: the panel at the left lists your folders; a folder is one
  experiment, with its blots and figures under it. Click a folder to open it,
  a blot or figure to go to it; `+` makes a new folder; the field in the header
  renames the open one. Everything is saved as you work, nothing has to be
  pressed, and after a reload the folder that was open is there again.
- **Where it is kept**: in Chrome and Edge, *Choose folder…* lets the page work
  in a folder on your computer, where every blot and figure is a directory of
  ordinary files (see Files). After a restart of the browser the page asks once
  to be let into the folder again. Without that, and in Safari and Firefox,
  the same tree is kept by the browser. *Download folder* and *All* give it as
  a zip file that unpacks to exactly what would be on disk; *Open file…* takes
  such a zip back in. Nothing is replaced: a folder of a name that is there
  already comes in beside it.
- **Figures**: a folder can have several. The Figure step chooses the one being
  edited and makes new ones. Which blots a figure shows, the area of each and
  the style are the figure's own; lane labels and markers belong to the blots
  and appear in every figure that shows them.
- **From earlier versions**: project files (`.webblot.json`) and library files
  (`.webblot.zip`) open with *Open file…* and become folders. Projects that an
  earlier version kept in the browser are offered for moving in, and stay
  where they were until you remove them.

What the browser keeps is not a backup: it belongs to one browser on one
computer, and the browser can clear it. A folder on disk is yours like any
other; otherwise download what you need to keep. If the browser stores
nothing, the page says "Not stored" and works until it is closed. Files
changed outside the page (in Finder, or `blot.json` by hand) are read again
when you come back to it.

## Total protein

For a total protein stain (Stain-Free, Ponceau, Revert) the measure is the
signal of a whole region of each lane, smear included, not of single bands:

1. In the Quantify step, choose the background *Straight line* and **Draw
   background area** on empty membrane: beside the lanes, at their height, not
   under the dye front. The mean inside it becomes the flat background of every
   lane, and stays so when the box is moved or the image is cropped. A lane
   whose line is set by hand leaves it; *Apply to all lanes* brings them back.
2. Mark the region in one lane as a peak (double-click, then drag its borders)
   and press **To all** in its row of the peaks table: every lane gets the
   region at the same rows of the image. *Remove all* clears the peaks of all
   lanes first, if detection found single bands.

A rolling ball or valley-to-valley lines would take the smear between the bands
for background and measure too little. The method holds where the signal is in
the linear range (nothing saturated inside the region), and assumes the
background is the same across the blot: if it is not, a box on one side
measures the lanes on the other side wrongly.

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

```
<work folder>/
  <Folder>/                      one experiment (what a project used to be)
    folder.json                  order of the blots, the figure last edited, the normalize option
    <Blot>/
      blot.json                  everything about the blot
      raw.tif                    the image: 16-bit grey TIFF, whatever it was read from
      brightfield.tif            its brightfield image, if it has one
      view.png                   the blot as the page shows it: turned, cropped, exposure
      lanes.png                  the same with lanes and peak borders drawn
      areas.csv                  band areas, lanes by peaks
      profiles.csv               lane, position_px, intensity, background
    <Figure>/
      figure.json                which blots, the area of each, the style
      figure.svg, figure.png     the figure as it renders
```

- The page reads `folder.json`, `blot.json`, `raw.tif`, `brightfield.tif` and
  `figure.json`. The pictures and tables are written for reading without the
  page and are never read back; they follow a change after a moment.
- A directory with `blot.json` is a blot, one with `figure.json` a figure.
  Folders are one level: there are no folders in folders. Other files and
  directories are left alone.
- The names of the directories are the names shown, with characters a file
  system does not take replaced; the name itself is in the JSON.
- `raw.tif` holds whole numbers from 0 to 65535. An image that had other
  values (a colour image is averaged to grey) is rounded.
- `blot.json`: `name`, `transform` (rotation, crop, polarity, exposure), `lanes`
  (position, size, tilt, background, peaks), `lane_labels`, `mw_markers`,
  `band_markers` and their sides, `gel_area`, `brightfield`. Positions are in
  pixels of the turned and cropped image, as `view.png` shows it.
- `figure.json`: `name`, `panels` (`blot` is the blot's directory; `shown`,
  `area`, `area_on`, `show_brightfield`, `lane_labels`), in the order of the
  blots on the page, and `style`.
- Each JSON has `app`, `kind` and `version` (1). When a format changes, it gets
  a new version and the page converts the older ones on reading.

Files of earlier versions still open: project files (`.webblot.json`, versions
4 to 7; `project.upgrade` in `js/ui/project.js` converts them) and library
files (`.webblot.zip`, a zip of project files). Each project becomes a folder
and its one figure a figure directory.

## Limits

- No zoom inside a plot.
- No TIFF export; PDF through the print dialog.

## Layout

```
index.html
css/           tokens (colours, sizes; light and dark), base, components, layout
js/vendor/     UTIF.js (TIFF decoding) and pako, pinned copies with licences
js/core/       no interface code: numerics, image reading and writing, lanes,
               quantification, figure, zip files, the work folder (on disk or in the
               browser), the storage of earlier versions
js/ui/         state, workspace cards, side panels, lane plots, the folders and their
               files, project files of earlier versions,
               icons, messages and questions, theme
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
`test_folders.py` covers the work folder: what is written for a blot and a
figure, names, several figures, zip files, changes from outside, files and
storage of earlier versions, and working in a folder on disk (in Chromium, with
a directory of the browser standing in for the folder dialog).
`test_design.py` covers first use, the steps, folding sections, the themes
(including that text has enough contrast in both), undo and the questions.
`uv run python screenshots.py <folder>` writes screenshots of the main views
using the real blot `tests/data/chemidoc_lc3.tif`; the tests that use this blot
are skipped if the file is not there.
