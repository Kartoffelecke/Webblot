"""Shared fixtures: the page under test, the test images and the reference values."""

import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(__file__).resolve().parent / "data"
REAL_BLOT = DATA / "chemidoc_lc3.tif"

INDEX_URL = (ROOT / "index.html").as_uri()

# Passing arrays to the page: images travel as flat lists.
TO_IMAGE = "([w, h, data]) => ({ w, h, data: Float32Array.from(data) })"

# Every section of the side panel open, so that a test reaches a control
# without unfolding its section first. (Which sections are folded is a setting
# the browser keeps; "*" is for all that were never touched.)
ALL_SECTIONS_OPEN = """try { if (!localStorage.getItem("web_blot.sections")) localStorage.setItem("web_blot.sections", '{"*": true}'); } catch (e) {}"""


@pytest.fixture
def app(page):
    """The application, opened straight from the file system."""
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.add_init_script(ALL_SECTIONS_OPEN)
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


def make_blot(shape=(420, 640), n_lanes=8, band_ys=(90, 200, 320), seed=0, gradient=0.15, noise=0.01):
    """A synthetic blot with known lanes and bands: the image, a brightfield image and the ground truth."""
    rng = np.random.default_rng(seed)
    h, w = shape
    yy, xx = np.mgrid[:h, :w].astype(float)
    pitch = w / (n_lanes + 1)
    centers = pitch * (np.arange(n_lanes) + 1)
    lane_width = 0.7 * pitch
    sigma_y = 5.0

    volumes = rng.uniform(0.3, 1.0, size=(n_lanes, len(band_ys)))
    volumes[:, -1] = 0.8  # loading control
    wb = np.zeros(shape)
    for i, cx in enumerate(centers):
        # flat-topped band across the lane
        across = 1.0 / (1.0 + (np.abs(xx - cx) / (0.42 * lane_width)) ** 8)
        for j, by in enumerate(band_ys):
            along = np.exp(-0.5 * ((yy - by) / sigma_y) ** 2) / (sigma_y * np.sqrt(2 * np.pi))
            wb += volumes[i, j] * along * across * 10
    wb += gradient * (yy / h) + 0.05
    wb += rng.normal(0, noise, shape)

    ladder_ys = np.linspace(50, h - 50, 6)
    bf = np.full(shape, 0.9)
    across = 1.0 / (1.0 + (np.abs(xx - centers[0]) / (0.42 * lane_width)) ** 8)
    for ly in ladder_ys:
        bf -= 0.6 * np.exp(-0.5 * ((yy - ly) / 3.0) ** 2) * across
    bf += rng.normal(0, noise, shape)

    def to16(a):
        a = np.clip(a, 0, None)
        return (a / a.max() * 60000).astype(np.uint16)

    return {
        "wb": to16(wb),
        "bf": to16(bf),
        "centers": centers,
        "band_ys": np.asarray(band_ys, float),
        "ladder_ys": ladder_ys,
    }


@pytest.fixture(scope="session")
def ref():
    """The recorded numbers the core must reproduce: data/reference.json, and the long curves in data/reference.npz."""
    values = json.loads((DATA / "reference.json").read_text())
    with np.load(DATA / "reference.npz") as curves:
        values.update({key: curves[key] for key in curves.files})
    return values


def checked(pixels, expected):
    """`pixels`, after making sure it is the image the reference values were recorded for."""
    assert float(pixels.sum(dtype=np.float64)) == pytest.approx(expected, rel=1e-12), (
        "the generated test image has changed (another numpy?), so the reference values do not apply"
    )
    return pixels


@pytest.fixture(scope="session")
def blot(ref):
    b = make_blot()
    checked(b["wb"], ref["fingerprint"]["wb"])
    checked(b["bf"], ref["fingerprint"]["bf"])
    b["img"] = b["wb"].astype(np.float32)
    return b


@pytest.fixture(scope="session")
def real_blot():
    """A real blot (ChemiDoc, 16-bit TIFF), if it is there."""
    if not REAL_BLOT.exists():
        pytest.skip(f"no {REAL_BLOT.name} in tests/data")
    return REAL_BLOT


# ----------------------------------------------------------------- UI helpers


class Ui:
    """Thin wrapper around the page for driving the interface like a user."""

    def __init__(self, page):
        self.page = page

    def t(self, name, nth=0):
        return self.page.locator(f"[data-t={name}]").nth(nth)

    def click(self, name, nth=0):
        # let a rebuild of the panel that is still to come happen first, so that the
        # click does not land on a button that is being replaced
        self.flush()
        self.t(name, nth).click()

    def set(self, name, value, nth=0):
        """Type into a field and commit it, as leaving the field does."""
        # the panel is rebuilt after a change; let that happen first, then work on one
        # and the same field from start to end
        self.flush()
        field = self.t(name, nth).element_handle()
        # select what is there first: typing into a number field does not always replace it (WebKit on Linux)
        field.select_text()
        field.fill(str(value))
        assert field.input_value() == str(value), f"{name}: {field.input_value()!r} instead of {value!r}"
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

    def confirm(self, yes=True):
        """Answer the question the page is asking; returns what it asked."""
        text = self.t("confirm-text").inner_text()
        self.click("confirm-ok" if yes else "confirm-cancel")
        self.flush()
        return text

    def document(self):
        """What is open, as text that is the same after it was written and read again: its
        settings, without the name of the folder and the names the images go by."""
        return self.page.evaluate(
            """(() => { const d = WB.project.serialize(); delete d.images; d.name = "";
                return JSON.stringify(d).replace(/"(wb|bf)":"[0-9a-f]+"/g, '"$1":"x"'); })()"""
        )

    def saved(self):
        """Wait until everything is written, pictures and tables included."""
        self.flush()
        self.page.evaluate("WB.library.saveNow()")

    def files(self):
        """{ path: size } of all that is in the work folder."""
        return dict(self.page.evaluate("WB.tree.files([]).then((all) => all.map(([path, data]) => [path.join('/'), data.length]))"))

    def read(self, path):
        """The text of a file of the work folder."""
        return self.page.evaluate("(path) => WB.tree.readText(path.split('/'))", path)

    def download(self, name):
        with self.page.expect_download() as info:
            self.click(name)
        return info.value


@pytest.fixture
def ui(app):
    app.set_viewport_size({"width": 1500, "height": 950})
    return Ui(app)


@pytest.fixture
def blot_files(tmp_path, blot, ref):
    """Two synthetic blots as TIFF files."""
    import tifffile

    control = checked(make_blot(seed=5)["wb"], ref["fingerprint"]["control"])
    paths = []
    for name, data in (("target", blot["wb"]), ("control", control)):
        path = tmp_path / f"{name}.tif"
        tifffile.imwrite(path, data)
        paths.append(path)
    return paths
