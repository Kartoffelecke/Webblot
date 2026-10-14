# web_blot

Western blot and gel analysis in the browser: prepare blot images, mark lanes,
measure bands and build a labelled multi-panel figure. Plain HTML and
JavaScript; nothing to install, no server, images stay on your computer.

## Start

Open `index.html` in a browser. Add blot images with **Add blots** or by
dropping them on the page (16-bit TIFF, PNG, JPEG), or try **Sample**.

## Folders

The panel at the left lists your folders, one per experiment, with their blots
and figures. Everything is saved as you work.

- **Where**: in Chrome and Edge, *Choose folder…* works in a folder on your
  computer; after a browser restart the page asks once to be let in again.
  Otherwise, and in Safari and Firefox, the folders are kept by the browser.
  That storage belongs to one browser and can be cleared, so download what you
  need to keep.
- **Moving folders**: *Download folder* (header) and *All* (left panel) give a
  zip file that unpacks to the layout below; *Open file…* takes such a zip back
  in, beside what is there.
- Files changed outside the page are read again when you return to it.

## The four steps

The numbered bar under the header leads through the steps of the selected
blot; keys `1`–`4` switch, `?` lists all mouse and key actions. The panel on
the right belongs to the current step, with its usual action as the coloured
button.

1. **Prepare**: rotate, straighten along a drawn line, crop, or cut an area
   out as a new blot. A brightfield image of the same membrane (the marker) can
   be merged into a blot's display: choose a file, or drag another blot by its
   handle onto the image. It is shown, never measured.
2. **Lanes**: detect lanes (from the signal or evenly spaced, optionally within
   a drawn gel area), then move, resize and tilt them on the blot.
3. **Quantify**: one profile per lane: the mean intensity across the lane
   width at each pixel along it. Peaks are detected or added by double-click;
   a peak ends where its flank has flattened. Drag borders to adjust. Areas are
   the sum of profile minus background between the borders, shown per lane and
   peak number, optionally normalised to the largest lane, and downloadable as
   CSV.
4. **Figure**: the blots stacked as panels, each with its own area of the
   image, lane labels (pasted from a spreadsheet if you like), MW and band
   markers. A folder can have several figures. Export as SVG (the gel's own
   pixels, editable text), PNG, or PDF through Print.

On a blot: Ctrl / ⌘ + wheel zooms, drag a card by its handle to reorder.
Removing a blot or lane can be undone from the message at the bottom.

## Background

Chosen per lane in the Quantify step:

- **Rolling ball** (default): the lower envelope of the profile.
- **Straight line**: one line per lane, from its ends or set by hand, or for
  all lanes from **Draw background area**: the mean of a box on empty membrane.
- **Valley to valley**: each peak measured above the straight line between its
  two borders, as with lines drawn by hand in Fiji's gel analyzer.
- **Manual anchors**: points dragged in the plot.

With the same lanes, borders and valley-to-valley background, the numbers are
those of Fiji's gel analyzer up to one scale factor (which cancels when bands
are normalised within a gel) and Fiji's rounding to plot pixels.

## Total protein

To measure a whole region of each lane, smear included:

1. Choose *Straight line* and **Draw background area** on empty membrane,
   beside the lanes and away from the dye front. Every lane gets that flat
   background.
2. Mark the region in one lane as a peak, then press **To all** in its row of
   the peaks table: every lane gets the region at the same image rows.

This assumes the signal is in the linear range (nothing saturated in the
region) and the background is even across the blot.

## Files

```
<work folder>/
  <Folder>/
    folder.json          order of the blots, figure last edited, normalize option
    <Blot>/
      blot.json          all settings: rotation, crop, exposure, lanes, peaks, labels, markers
      raw.tif            the image as 16-bit grey TIFF
      brightfield.tif    its brightfield image, if any
      view.png           the blot as shown (turned, cropped, exposure)
      lanes.png          the same with lanes and peak borders
      areas.csv          band areas, lanes by peaks
      profiles.csv       lane, position_px, intensity, background
    <Figure>/
      figure.json        which blots, the area of each, the style
      figure.svg, figure.png
```

The page reads the JSON files and the TIFFs; the pictures and CSVs are written
for reading without it and follow every change. Positions in `blot.json` are
pixels of the turned and cropped image, as in `view.png`. Every JSON file has
`app`, `kind` and `version`.

## Code and tests

```
index.html, css/   page and styles (light and dark)
js/core/           numerics, image files, lanes, quantification, figure, zip, work folder
js/ui/             the interface
tests/             browser tests (Python, Playwright, Chromium and WebKit)
```

Scripts are plain `<script>` files sharing one global `WB`, so the page runs
from the file system.

```sh
cd tests
uv sync
uv run playwright install chromium webkit   # once
uv run pytest
```
