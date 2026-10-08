"""Shared fixtures: the page under test and napari-blot's Python core as reference."""

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
NAPARI_BLOT = ROOT.parent / "napari-blot"
sys.path.insert(0, str(NAPARI_BLOT / "src"))

INDEX_URL = (ROOT / "index.html").as_uri()

# Passing arrays to the page: images travel as flat lists.
TO_IMAGE = "([w, h, data]) => ({ w, h, data: Float32Array.from(data) })"


@pytest.fixture
def app(page):
    """The application, opened straight from the file system."""
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.goto(INDEX_URL)
    page.wait_for_function("window.WB && WB.quant")
    yield page
    assert not errors, f"JavaScript errors: {errors}"


def image_arg(array):
    """A 2D numpy array as the argument for a page function taking an image."""
    a = np.asarray(array, dtype=np.float32)
    return [a.shape[1], a.shape[0], a.ravel().tolist()]


def call(page, expression, *images, args=None):
    """Evaluate `expression` (a JS function of images and args) in the page."""
    script = f"""([images, args]) => {{
        const toImage = {TO_IMAGE};
        return ({expression})(...images.map(toImage), args);
    }}"""
    return page.evaluate(script, [[image_arg(i) for i in images], args])


@pytest.fixture(scope="session")
def blot():
    from napari_blot._sample import make_blot

    b = make_blot()
    b["img"] = b["wb"].astype(np.float32)
    return b


@pytest.fixture(scope="session")
def real_blot():
    """The ChemiDoc LC3 blot from napari-blot/data, if it is there."""
    files = sorted((NAPARI_BLOT / "data").glob("*.tif"))
    if not files:
        pytest.skip("no blot in napari-blot/data")
    return files[0]


# ----------------------------------------------------------------- UI helpers


class Ui:
    """Thin wrapper around the page for driving the interface like a user."""

    def __init__(self, page):
        self.page = page

    def t(self, name, nth=0):
        return self.page.locator(f"[data-t={name}]").nth(nth)

    def click(self, name, nth=0):
        self.t(name, nth).click()

    def set(self, name, value, nth=0):
        """Type into a field and commit it, as leaving the field does."""
        field = self.t(name, nth)
        field.fill(str(value))
        field.dispatch_event("change")
        self.flush()

    def choose(self, name, value, nth=0):
        self.t(name, nth).select_option(value)
        self.flush()

    def tab(self, name):
        self.click(f"tab-{name}")
        self.flush()

    def flush(self):
        self.page.evaluate("WB.app.flush()")

    def state(self, expression):
        """Evaluate a JS expression with `s` = state and `b` = the selected blot."""
        return self.page.evaluate(f"(() => {{ const s = WB.state; const b = WB.app.blot(); return {expression}; }})()")

    def add_files(self, *paths):
        before = self.page.evaluate("WB.state.blots.length")
        self.t("add-files").set_input_files([str(p) for p in paths])
        self.page.wait_for_function(f"WB.state.blots.length >= {len(paths)} + {before}")
        self.flush()

    def select_blot(self, index):
        self.page.evaluate(f"WB.app.select(WB.state.blots[{index}].id)")
        self.flush()

    def on_card(self, index, y, x):
        """Screen position of image point (y, x) on the card of blot `index`."""
        return self.page.evaluate(
            """([index, y, x]) => {
                const id = WB.state.blots[index].id;
                const svg = document.querySelector(`[data-t=card][data-id="${id}"] svg.overlay`);
                const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
                return [p.x, p.y];
            }""",
            [index, y, x],
        )

    def drag(self, start, end, steps=6):
        mouse = self.page.mouse
        mouse.move(*start)
        mouse.down()
        for i in range(1, steps + 1):
            mouse.move(start[0] + (end[0] - start[0]) * i / steps, start[1] + (end[1] - start[1]) * i / steps)
        mouse.up()
        self.flush()

    def drag_on_card(self, index, start, end):
        """Drag between two image points (y, x) on a card."""
        self.drag(self.on_card(index, *start), self.on_card(index, *end))

    def on_plot(self, lane, position, value=None):
        """Screen position of a profile position (and intensity) in a lane's plot."""
        return self.page.evaluate(
            """([lane, position, value]) => {
                const svg = document.querySelectorAll("svg.plot")[lane];
                svg.scrollIntoView({ block: "center" });
                const width = svg.getBoundingClientRect().width;
                const blot = WB.app.blot();
                const c = WB.app.curves(blot, blot.session.lanes[lane]);
                const n = c.profile.length;
                const lo = Math.min(WB.num.min(c.profile), WB.num.min(c.baseline));
                const top = WB.num.max(c.profile);
                const hi = top + 0.2 * (top - lo || 1);
                const x = 58 + (position / (n - 1)) * (width - 58 - 10);
                const v = value === null ? lo + 0.3 * (hi - lo) : value;
                const y = 16 + (1 - (v - lo) / (hi - lo)) * (124 - 16 - 18);
                const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
                return [p.x, p.y];
            }""",
            [lane, position, value],
        )

    def rect(self, locator):
        """Bounding rectangle of an element as the browser lays it out."""
        return locator.evaluate("(el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }")

    def download(self, name):
        with self.page.expect_download() as info:
            self.click(name)
        return info.value


@pytest.fixture
def ui(app):
    app.set_viewport_size({"width": 1500, "height": 950})
    return Ui(app)


@pytest.fixture
def blot_files(tmp_path, blot):
    """Two synthetic blots as TIFF files."""
    import tifffile

    from napari_blot._sample import make_blot

    paths = []
    for name, data in (("target", blot["wb"]), ("control", make_blot(seed=5)["wb"])):
        path = tmp_path / f"{name}.tif"
        tifffile.imwrite(path, data)
        paths.append(path)
    return paths
