"""Total protein: one flat background from an empty area, and one region in every lane."""

import json
import math

import numpy as np
import pytest
import tifffile


@pytest.fixture
def quantified(ui, blot_files):
    """The first test blot with eight lanes and their peaks, on the Quantify step."""
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.flush()
    return ui


def expected_level(box, image):
    """Mean of the pixels inside a drawn box (pixel edges at .5), as the page takes it."""
    y0, x0, y1, x1 = (math.floor(v + 1) for v in box)  # whole pixels, halves up (Math.round)
    return float(image[min(y0, y1):max(y0, y1), min(x0, x1):max(x0, x1)].astype(np.float64).mean())


def lines(ui):
    return ui.state("b.session.lanes.map((l) => [l.baseline.method, l.baseline.from_area === true, l.baseline.linear_ends])")


def test_a_flat_background_from_an_empty_area_for_every_lane(quantified, blot_files):
    ui = quantified
    image = tifffile.imread(blot_files[0])
    # only with the straight line, and with a word on what it is for
    assert ui.t("tool-bg-area").count() == 0
    ui.choose("bg-method", "linear")
    assert "total protein" in ui.t("bg-area-hint").inner_text()
    ui.click("tool-bg-area")
    ui.flush()
    ui.drag_on_card(0, (100, 5), (180, 30))  # left of the first lane: no band there
    box = ui.state("b.bgArea")
    assert box == pytest.approx([100, 5, 180, 30], abs=3)
    level = expected_level(box, image)
    assert ui.state("WB.app.backgroundLevel(b)") == pytest.approx(level, rel=1e-9)
    # every lane: a flat line at that height
    assert lines(ui) == [["linear", True, [pytest.approx(level, rel=1e-9)] * 2]] * 8
    assert f"{level:.5g}"[:4] in ui.t("bg-area-level").inner_text()
    # the areas are what is above it between the borders
    above = ui.state(
        """b.session.lanes.map((l) => { const p = WB.app.curves(b, l).profile; const v = WB.app.backgroundLevel(b);
            return l.peaks.map((k) => { const [a, e] = WB.quant.peakBounds(k, p.length); let s = 0;
                for (let i = a; i < e; i++) s += 0.5 * (p[i] - v + p[i + 1] - v); return s; }); })"""
    )
    assert np.allclose(ui.state("WB.app.results(b).rows"), above, rtol=1e-9)
    # the box stays on the blot; moved, the lines follow
    card = ui.page.locator("[data-t=card]").first
    assert card.locator("[data-t=bg-area]").count() == 1 and "background" in card.locator("svg.overlay").text_content()
    ui.drag_on_card(0, (140, 17), (140, 600))  # to the right of the last lane
    box = ui.state("b.bgArea")
    assert box[1] > 560 and ui.state("b.session.lanes[5].baseline.linear_ends[0]") == pytest.approx(expected_level(box, image), rel=1e-9)

    # one lane set by hand leaves the box; "Apply to all lanes" brings them back
    ui.state("(WB.app.select(b.id, 2), 0)")
    ui.flush()
    ui.set("bg-line-start", 1000)
    assert lines(ui)[2][:2] == ["linear", False] and "set by hand" in ui.t("bg-area-level").inner_text()
    ui.state("(WB.app.select(b.id, 0), 0)")
    ui.flush()
    ui.click("bg-all")
    ui.flush()
    assert all(line[1] for line in lines(ui)) and len({tuple(line[2]) for line in lines(ui)}) == 1
    # lanes found again take it too
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.tab("quantify")
    assert all(line[:2] == ["linear", True] for line in lines(ui))

    # it follows the signal: dark bands, and a crop keeps it on the same pixels
    before = ui.state("WB.app.backgroundLevel(b)")
    ui.state("(b.session.transform.bands_dark = true, b.cache.signal = null, b.cache.profiles.clear(), WB.app.syncBackground(b), WB.app.changed('quant'))")
    assert ui.state("WB.app.backgroundLevel(b)") == pytest.approx(float(image.max()) - before, rel=1e-6)
    assert ui.state("b.session.lanes[0].baseline.linear_ends[0]") == pytest.approx(float(image.max()) - before, rel=1e-6)
    ui.state("(b.session.transform.bands_dark = false, b.cache.signal = null, WB.app.syncBackground(b), 0)")
    ui.state("(WB.app.setCrop(b, [20, 0, 400, 640]), 0)")
    assert ui.state("WB.app.backgroundLevel(b)") == pytest.approx(before, rel=1e-9) and ui.state("b.bgArea[0]") == pytest.approx(box[0] - 20)

    # kept in blot.json, and there again after a reload
    ui.saved()
    doc = json.loads(ui.read("target/target/blot.json"))
    assert doc["background_area"] == ui.state("b.bgArea") and all(lane["baseline"]["from_area"] for lane in doc["lanes"])
    document = ui.document()
    ui.page.reload()
    ui.page.evaluate("WB.library.ready")
    ui.flush()
    assert ui.document() == document and ui.state("WB.app.backgroundLevel(b)") == pytest.approx(before, rel=1e-9)
    # removed: the lines keep their height, set by hand from now on
    ui.tab("quantify")
    ui.click("bg-area-remove")
    assert ui.state("b.bgArea") is None and lines(ui)[0][:2] == ["linear", False]
    assert ui.state("b.session.lanes[0].baseline.linear_ends[0]") == pytest.approx(before, rel=1e-9)


def test_one_region_in_every_lane(quantified):
    ui = quantified
    # lanes that start at other heights, and one that is tilted
    ui.state("(b.session.lanes[3].y0 += 25, b.session.lanes[5].tilt_deg = 4, WB.app.changed('lanes'))")
    ui.state("(b.session.lanes[0].peaks = [{ start: 60, end: 260, apex: 90, band_id: 1, quantify: true }], WB.app.changed('quant'))")
    ui.flush()
    assert ui.state("b.session.lanes.map((l) => l.peaks.length)") == [1] + [3] * 7
    ui.click("peak-to-all")
    ui.flush()
    rows = ui.state(
        """b.session.lanes.map((l) => { const r = l.peaks.find((p) => p.band_id === 1);
            return [WB.lanes.profileToImageY(l, r.start), WB.lanes.profileToImageY(l, r.end), l.peaks.map((p) => p.band_id)]; })"""
    )
    # the same rows of the image in every lane
    for top, bottom, _ in rows:
        assert [top, bottom] == pytest.approx(rows[0][:2], abs=1e-6)
    # the peaks it overlaps are gone (the band at 200 px), the one below it is kept (320 px)
    assert [r[2] for r in rows] == [[1]] + [[1, 3]] * 7
    # its apex is the highest point inside, and it is measured as any peak
    assert ui.state("b.session.lanes[4].peaks[0].apex") == pytest.approx(ui.state("WB.lanes.positionAtImageY(b.session.lanes[4], 90)"), abs=3)
    table = ui.state("WB.app.results(b)")
    assert table["bands"] == [1, 3] and all(row[0] > 0 for row in table["rows"])
    # a second press changes nothing
    ui.click("peak-to-all")
    ui.flush()
    assert ui.state("WB.app.results(b)") == table

    # all peaks away, and back
    ui.click("peaks-clear")
    ui.flush()
    assert ui.state("b.session.lanes.every((l) => l.peaks.length === 0)") and "all lanes" in ui.t("toast").inner_text()
    ui.click("toast-action")
    ui.flush()
    assert ui.state("WB.app.results(b)") == table
