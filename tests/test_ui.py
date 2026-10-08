"""The interface, driven with real mouse and keyboard events in a browser."""

import base64
import json
import re
import struct

import numpy as np
import pytest
import tifffile
from conftest import INDEX_URL

from napari_blot import lanes, quant
from napari_blot.model import Lane


def png_size(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


def py_lane(d):
    return Lane(d["x_center"], d["y0"], d["y1"], d["width"], d["tilt_deg"])


def test_opens_from_the_file_system_with_a_sample(ui):
    assert ui.page.url.startswith("file://")
    ui.click("add-sample")
    ui.flush()
    assert ui.state("s.blots.length") == 1
    assert ui.page.locator("[data-t=card] canvas").count() == 1


def test_all_blots_are_visible_and_adjusted_side_by_side(ui, blot_files, blot):
    ui.add_files(*blot_files)
    assert ui.state("s.blots.map((b) => b.name)") == ["target", "control"]
    cards = ui.page.locator("[data-t=card]")
    assert cards.count() == 2 and cards.nth(0).is_visible() and cards.nth(1).is_visible()
    assert ui.state("[s.blots[0].work.wb.w, s.blots[0].work.wb.h]") == [640, 420]
    # the loaded pixels are the file's pixels
    assert ui.state("Array.from(s.blots[0].raw.wb.data.slice(0, 5))") == blot["wb"].ravel()[:5].tolist()

    def mean_brightness(index):
        return ui.page.evaluate(
            """(index) => {
                const c = document.querySelectorAll("[data-t=card] canvas")[index];
                const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
                let s = 0;
                for (let i = 0; i < d.length; i += 4) s += d[i];
                return s / (d.length / 4);
            }""",
            index,
        )

    before = [mean_brightness(0), mean_brightness(1)]
    # lower the max slider on the first card only
    slider = cards.nth(0).locator("[data-t=max]")
    slider.evaluate("(el) => { el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * 0.2); el.dispatchEvent(new Event('input', { bubbles: true })); }")
    ui.flush()
    after = [mean_brightness(0), mean_brightness(1)]
    assert after[0] > before[0] + 5 and after[1] == before[1]
    limits = ui.state("s.blots.map((b) => b.session.transform.contrast_limits[1])")
    assert limits[0] < limits[1]

    # invert only the second
    cards.nth(1).locator("[data-t=invert]").check()
    ui.flush()
    assert mean_brightness(1) > 150 and ui.state("s.blots.map((b) => b.session.transform.invert_lut)") == [False, True]
    # clicking a card selects it
    cards.nth(0).locator(".card-head .dim").click()
    ui.flush()
    assert ui.state("b.name") == "target" and "selected" in cards.nth(0).get_attribute("class")


def test_rotate_straighten_and_crop(ui, tmp_path):
    yy, xx = np.mgrid[:300, :500].astype(float)
    tilted = (1000 * np.exp(-0.5 * ((yy - (150 + 0.08 * (xx - 250))) / 3) ** 2)).astype(np.uint16)
    path = tmp_path / "tilted.tif"
    tifffile.imwrite(path, tilted)
    ui.add_files(path)

    ui.set("angle", 90)
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == [300, 500]
    ui.click("rot-cw")
    ui.flush()
    assert ui.state("b.session.transform.rotation_deg") == 0 and ui.state("[b.work.wb.w, b.work.wb.h]") == [500, 300]

    # draw a line along the band; the image is rotated so that it becomes level
    ui.click("tool-level")
    ui.flush()
    ui.drag_on_card(0, (150 - 0.08 * 200, 50), (150 + 0.08 * 200, 450))
    # nothing happens yet: the line stays on the blot until it is applied
    assert ui.state("s.tool") is None and ui.state("b.session.transform.rotation_deg") == 0
    assert ui.page.locator("[data-t=level-shape]").is_visible()
    ui.click("level-apply")
    ui.flush()
    assert ui.state("b.pending.level") is None and ui.page.locator("[data-t=level-shape]").count() == 0
    assert ui.state("b.session.transform.rotation_deg") == pytest.approx(np.degrees(np.arctan(0.08)), abs=0.3)
    ridge = ui.state(
        """(() => { const { w, h, data } = b.work.wb; const out = [];
            for (let x = 60; x < w - 60; x += 20) { let best = 0; for (let y = 0; y < h; y++) if (data[y * w + x] > data[best * w + x]) best = y; out.push(best); }
            return out; })()"""
    )
    assert max(ridge) - min(ridge) <= 3

    # crop; lanes drawn before stay on the same pixels
    ui.tab("lanes")
    ui.click("lane-add")
    ui.flush()
    x_before = ui.state("b.session.lanes[0].x_center")
    w, h = ui.state("[b.work.wb.w, b.work.wb.h]")
    ui.tab("prepare")
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (40, 60), (h - 50, w - 80))
    assert ui.state("b.session.transform.crop") is None and ui.page.locator("[data-t=crop-shape]").is_visible()
    ui.click("crop-apply")
    ui.flush()
    assert ui.page.locator("[data-t=crop-shape]").count() == 0
    crop = ui.state("b.session.transform.crop")
    assert crop == pytest.approx([40, 60, h - 50, w - 80], abs=3)
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == [crop[3] - crop[1], crop[2] - crop[0]]
    assert ui.state("b.session.lanes[0].x_center") == pytest.approx(x_before - crop[1])
    ui.click("crop-reset")
    ui.flush()
    assert ui.state("b.session.transform.crop") is None
    assert ui.state("b.session.lanes[0].x_center") == pytest.approx(x_before)
    # changing the rotation resets the crop
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (40, 60), (200, 300))
    ui.click("crop-apply")
    ui.flush()
    assert ui.state("b.session.transform.crop") is not None
    ui.set("angle", 2)
    assert ui.state("b.session.transform.crop") is None


def test_lanes_detect_and_edit_with_the_mouse(ui, blot_files, blot):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.flush()
    centers = ui.state("b.session.lanes.map((l) => l.x_center)")
    assert centers == pytest.approx([ln.x_center for ln in lanes.detect_lanes(blot["img"], n_lanes=8)], abs=1e-6)
    assert ui.page.locator("[data-t=lane]").count() == 8

    # drag lane 3 to the right
    lane = ui.state("b.session.lanes[2]")
    ui.drag_on_card(0, (200, lane["x_center"]), (200, lane["x_center"] + 12))
    assert ui.state("s.lane") == 2
    assert ui.state("b.session.lanes[2].x_center") == pytest.approx(lane["x_center"] + 12, abs=3)

    # its handles: width, top edge, tilt
    ui.drag_on_card(0, (lane["y0"] + (lane["y1"] - lane["y0"]) / 2, lane["x_center"] + 12 + lane["width"] / 2), (210, lane["x_center"] + 12 + 15))
    assert ui.state("b.session.lanes[2].width") == pytest.approx(30, abs=4)
    ui.drag_on_card(0, (lane["y0"], lane["x_center"] + 12), (lane["y0"] + 40, lane["x_center"] + 12))
    assert ui.state("b.session.lanes[2].y0") == pytest.approx(lane["y0"] + 40, abs=3)
    knob = ui.page.locator("[data-t=handle-lane-tilt]").bounding_box()
    start = (knob["x"] + knob["width"] / 2, knob["y"] + knob["height"] / 2)
    ui.drag(start, (start[0] - 25, start[1]))
    assert 2 < ui.state("b.session.lanes[2].tilt_deg") < 20

    # panel edits
    ui.set("lane-width", 40)
    assert set(ui.state("b.session.lanes.map((l) => l.width)")) == {40}
    ui.set("lane-smile", 4)
    tilts = ui.state("b.session.lanes.map((l) => l.tilt_deg)")
    assert tilts[0] == pytest.approx(-4) and tilts[-1] == pytest.approx(4)

    # Delete removes the current lane; a lane dragged past its neighbour is renumbered
    ui.page.locator("[data-t=card] .dim").click()
    ui.page.keyboard.press("Delete")
    ui.flush()
    assert ui.state("b.session.lanes.length") == 7
    first = ui.state("b.session.lanes[0]")
    second = ui.state("b.session.lanes[1].x_center")
    ui.drag_on_card(0, (300, first["x_center"]), (300, second + 20))
    xs = ui.state("b.session.lanes.map((l) => l.x_center)")
    assert xs == sorted(xs) and ui.state("s.lane") == 1

    # evenly spaced inside a drawn gel area
    ui.choose("lane-method", "even")
    ui.set("lane-count", 7)
    ui.click("tool-roi")
    ui.flush()
    ui.drag_on_card(0, (50, 100), (400, 590))
    roi = ui.state("b.roi")
    assert roi == pytest.approx([50, 100, 400, 590], abs=3)
    ui.click("detect-lanes")
    ui.flush()
    got = ui.state("b.session.lanes.map((l) => [l.x_center, l.y0, l.y1])")
    expected = lanes.detect_lanes(blot["img"], n_lanes=7, roi=tuple(v + 0.5 for v in roi), method="even")
    assert np.allclose(got, [[ln.x_center, ln.y0, ln.y1] for ln in expected], atol=1e-6)


@pytest.fixture
def quantified(ui, blot_files):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.flush()
    return ui


def test_quantify_table_matches_python(quantified, blot):
    ui = quantified
    assert ui.page.locator("svg.plot").count() == 8
    assert ui.state("b.session.lanes.map((l) => l.peaks.length)") == [3] * 8
    found = lanes.detect_lanes(blot["img"], n_lanes=8)
    profiles, bases = [], []
    for lane in found:
        profile = lanes.extract_profile(blot["img"], lane)
        base = quant.compute_baseline(profile, lane.baseline)
        lane.peaks = quant.detect_peaks(profile, base)
        quant.number_peaks(lane)
        profiles.append(profile)
        bases.append(base)
    bands, rows = quant.results_table(found, profiles, bases)
    got = ui.state("WB.app.results(b)")
    assert got["bands"] == bands
    assert np.allclose(got["rows"], rows, rtol=1e-3)

    # the table on screen and the CSV download show the same numbers
    cells = ui.page.locator("[data-t=results] tr").nth(1).locator("td").all_inner_texts()
    assert [float(c) for c in cells] == pytest.approx(got["rows"][0], rel=1e-4)
    csv = ui.download("results-csv")
    assert csv.suggested_filename == "target_areas.csv"
    lines = open(csv.path()).read().splitlines()
    assert lines[0] == "Lane,Peak 1,Peak 2,Peak 3" and len(lines) == 9
    assert [float(v) for v in lines[3].split(",")[1:]] == pytest.approx(rows[2], rel=1e-3)


def test_peaks_are_edited_in_the_plots_with_the_mouse(quantified):
    ui = quantified
    page = ui.page
    peak = ui.state("b.session.lanes[4].peaks[1]")

    # drag the right border of lane 5's second peak outwards
    ui.drag(ui.on_plot(4, peak["end"]), ui.on_plot(4, peak["end"] + 20))
    assert ui.state("s.lane") == 4
    assert ui.state("b.session.lanes[4].peaks[1].end") == pytest.approx(peak["end"] + 20, abs=2)
    assert ui.state("b.session.lanes[4].peaks[1].start") == peak["start"]
    assert ui.state("b.session.lanes[0].peaks[1].end") == peak["end"]
    # the side panel now shows lane 5's peaks, with the new border
    assert float(ui.t("peak-end", 1).input_value()) == pytest.approx(peak["end"] + 20, abs=2)
    # the shaded area follows the borders
    assert page.locator("svg.plot").nth(4).locator("[data-t=peak-fill]").count() == 3

    # right-click removes a peak, in the lane it was clicked in
    page.mouse.click(*ui.on_plot(6, 0.5 * (peak["start"] + peak["end"])), button="right")
    ui.flush()
    assert ui.state("b.session.lanes.map((l) => l.peaks.length)") == [3, 3, 3, 3, 3, 3, 2, 3]
    assert ui.state("b.session.lanes[6].peaks.map((p) => p.band_id)") == [1, 2]
    assert ui.state("s.lane") == 6
    assert ui.state("WB.app.results(b).rows[6][2]") is None

    # double-click on the band brings it back, grown to the background
    page.mouse.dblclick(*ui.on_plot(6, peak["apex"] + 3))
    ui.flush()
    restored = ui.state("b.session.lanes[6].peaks[1]")
    assert restored["apex"] == peak["apex"] and restored["band_id"] == 2
    assert restored["start"] == pytest.approx(peak["start"], abs=3) and restored["end"] == pytest.approx(peak["end"], abs=3)

    # a hand-edited number survives adding a peak; Renumber resets it
    ui.set("peak-number", 9, nth=2)
    page.mouse.dblclick(*ui.on_plot(6, 30))
    ui.flush()
    assert sorted(ui.state("b.session.lanes[6].peaks.map((p) => p.band_id)")) == [1, 2, 3, 9]
    ui.click("renumber")
    ui.flush()
    assert ui.state("b.session.lanes[6].peaks.map((p) => p.band_id)") == [1, 2, 3, 4]

    # leaving a peak out
    ui.t("peak-use", 0).uncheck()
    ui.flush()
    assert ui.state("b.session.lanes[6].peaks[0].quantify") is False
    # the image shows the peak borders too
    assert page.locator("[data-t=peak-mark]").count() == sum(ui.state("b.session.lanes.map((l) => l.peaks.length)")) * 2


def test_backgrounds_are_edited_in_the_plots(quantified):
    ui = quantified
    page = ui.page
    ui.state("WB.app.select(b.id, 1)")
    ui.flush()
    area = lambda: ui.state("WB.quant.peakArea(WB.app.curves(b, b.session.lanes[1]).profile, WB.app.curves(b, b.session.lanes[1]).baseline, b.session.lanes[1].peaks[0])")
    rolling = area()

    # straight line: typed heights, then a handle dragged in the plot
    ui.choose("bg-method", "linear")
    assert ui.state("b.session.lanes[1].baseline.linear_ends") is None
    assert page.locator("svg.plot").nth(1).locator("[data-t=line-end]").count() == 2
    ui.set("bg-line-start", 1000)
    ui.set("bg-line-end", 1000)
    assert ui.state("b.session.lanes[1].baseline.linear_ends") == [1000, 1000]
    assert area() > rolling
    n = ui.state("WB.app.curves(b, b.session.lanes[1]).profile.length")
    ui.drag(ui.on_plot(1, n - 1, 1000), ui.on_plot(1, n - 1, 20000))
    ends = ui.state("b.session.lanes[1].baseline.linear_ends")
    assert ends[0] == 1000 and ends[1] == pytest.approx(20000, rel=0.05)
    ui.click("bg-line-auto")
    ui.flush()
    assert ui.state("b.session.lanes[1].baseline.linear_ends") is None

    # manual anchors: edit by hand, drag one, add and remove with Shift + double-click
    ui.choose("bg-method", "rolling")
    ui.click("bg-edit")
    ui.flush()
    anchors = ui.state("b.session.lanes[1].baseline.anchors")
    assert ui.state("b.session.lanes[1].baseline.method") == "manual" and len(anchors) == 8
    assert area() == pytest.approx(rolling, rel=0.1)
    ui.drag(ui.on_plot(1, anchors[2][0], anchors[2][1]), ui.on_plot(1, anchors[2][0], anchors[2][1] + 8000))
    moved = ui.state("b.session.lanes[1].baseline.anchors[2]")
    assert moved[1] == pytest.approx(anchors[2][1] + 8000, rel=0.1) and moved[0] == pytest.approx(anchors[2][0], abs=2)
    page.keyboard.down("Shift")
    page.mouse.dblclick(*ui.on_plot(1, 30, 9000))
    ui.flush()
    assert len(ui.state("b.session.lanes[1].baseline.anchors")) == 9
    page.mouse.dblclick(*ui.on_plot(1, 30, 9000))
    page.keyboard.up("Shift")
    ui.flush()
    assert len(ui.state("b.session.lanes[1].baseline.anchors")) == 8

    # apply to all lanes; other lanes were on rolling ball until now
    assert ui.state("b.session.lanes[5].baseline.method") == "rolling"
    ui.click("bg-all")
    ui.flush()
    assert set(ui.state("b.session.lanes.map((l) => l.baseline.method)")) == {"manual"}
    # Shift + double-click in a lane on another method switches it to anchors
    ui.state("(b.session.lanes[3].baseline = WB.model.baseline(), WB.app.changed('quant'))")
    ui.flush()
    page.keyboard.down("Shift")
    page.mouse.dblclick(*ui.on_plot(3, 200, 9000))
    page.keyboard.up("Shift")
    ui.flush()
    assert ui.state("b.session.lanes[3].baseline.method") == "manual"
    assert len(ui.state("b.session.lanes[3].baseline.anchors")) == 9


def figure_texts(ui, cls=None):
    selector = "[data-t=preview] svg text" + (f".{cls}" if cls else "")
    return ui.page.locator(selector).all_text_contents()


@pytest.fixture
def figured(ui, blot_files):
    """Two blots with lanes, a figure area, labels on the first and markers on both."""
    ui.add_files(*blot_files)
    for index in (0, 1):
        ui.select_blot(index)
        ui.tab("lanes")
        ui.set("lane-count", 8)
        ui.click("detect-lanes")
        ui.flush()
    ui.tab("figure")
    return ui


def test_figure_labels_markers_and_panels(figured):
    ui = figured
    page = ui.page
    ui.select_blot(0)
    # figure area drawn on the first blot's card: a strip around the top band
    ui.click("tool-figarea")
    ui.flush()
    ui.drag_on_card(0, (60, 20), (120, 620))
    assert ui.state("b.session.figure.crop") == pytest.approx([60, 20, 120, 620], abs=3)

    # label rows: one collapsing identical neighbours, and a titled one
    assert ui.page.locator("[data-t=label-add-span]").count() == 0
    ui.click("label-add")
    ui.click("label-add")
    ui.flush()
    assert not ui.t("label-collapse", 0).is_checked()
    ui.t("label-collapse", 0).check()
    ui.flush()
    assert ui.state("b.session.figure.label_rows.map((r) => r.collapse)") == [True, False]
    cells = page.locator("[data-t=label-row]").nth(0).locator("[data-t=label-cell]")
    cells.nth(0).fill("WT")
    cells.nth(0).dispatch_event("change")
    cells.nth(4).fill("KO")
    cells.nth(4).dispatch_event("change")
    ui.click("label-fill", 0)
    ui.flush()
    assert ui.state("b.session.figure.label_rows[0].values") == ["WT"] * 4 + ["KO"] * 4
    row = page.locator("[data-t=label-row]").nth(1)
    row.locator("[data-t=label-title]").fill("Drug")
    row.locator("[data-t=label-title]").dispatch_event("change")
    for i in range(8):
        cell = row.locator("[data-t=label-cell]").nth(i)
        cell.fill("+" if i % 2 else "-")
        cell.dispatch_event("change")
    ui.flush()

    # markers: placed, labelled, one dragged on the blot
    ui.set("mw-count", 2)
    ui.click("mw-place")
    ui.flush()
    ui.set("mw-text", "70", nth=0)
    ui.set("mw-text", "55", nth=1)
    ui.set("mw-unit", " kDa")
    ui.click("band-add")
    ui.flush()
    ui.set("band-text", "Target")
    y = ui.state("b.session.figure.band_markers[0].y")
    x1 = ui.state("b.session.figure.crop[3]")
    ui.drag_on_card(0, (y, x1 - 15), (y + 10, x1 - 15))
    assert ui.state("b.session.figure.band_markers[0].y") == pytest.approx(y + 10, abs=3)

    # second blot: its own strip and band marker, no labels of its own
    ui.select_blot(1)
    ui.click("tool-figarea")
    ui.flush()
    ui.drag_on_card(1, (285, 20), (355, 620))
    ui.click("band-add")
    ui.flush()
    ui.set("band-text", "GAPDH")

    texts = figure_texts(ui)
    assert texts.count("WT") == 1 and texts.count("KO") == 1 and texts.count("+") == 4 and "Drug" in texts
    assert "70 kDa" in texts and "55 kDa" in texts and "Target" in texts and "GAPDH" in texts
    svg = page.locator("[data-t=preview] svg")
    images = svg.locator("image")
    assert images.count() == 2
    boxes = [ui.rect(images.nth(i)) for i in range(2)]
    assert boxes[0]["width"] == pytest.approx(boxes[1]["width"], abs=0.5) and boxes[0]["x"] == pytest.approx(boxes[1]["x"], abs=0.5)
    assert boxes[1]["y"] > boxes[0]["y"] + boxes[0]["height"]
    # the gap is the requested 2 mm (the preview shows one point as two pixels)
    gap_pt = (boxes[1]["y"] - boxes[0]["y"] - boxes[0]["height"]) / 2
    assert gap_pt == pytest.approx(2 * 72 / 25.4, abs=0.3)
    # every label sits above the first gel; band labels sit beside their own gel
    for label in svg.locator("text.lane-label").all():
        box = ui.rect(label)
        assert box["y"] + box["height"] <= boxes[0]["y"] + 1
    gapdh = ui.rect(svg.locator("text.band-label", has_text="GAPDH"))
    assert boxes[1]["y"] < gapdh["y"] + gapdh["height"] / 2 < boxes[1]["y"] + boxes[1]["height"]
    assert gapdh["x"] > boxes[1]["x"] + boxes[1]["width"]
    # all strokes use the line width
    assert set(page.evaluate("[...document.querySelectorAll('[data-t=preview] svg line, [data-t=preview] svg rect')].map((e) => e.getAttribute('stroke-width'))")) == {"0.5"}

    # style: table labels, unit once, line width; panel order and visibility
    ui.select_blot(0)
    ui.choose("label-style", "table")
    ui.choose("mw-unit-position", "top")
    ui.set("line-width", 1)
    texts = figure_texts(ui)
    assert texts.count("kDa") == 1 and "70" in texts and "70 kDa" not in texts and texts.count("WT") == 1
    assert set(page.evaluate("[...document.querySelectorAll('[data-t=preview] svg line')].map((e) => e.getAttribute('stroke-width'))")) == {"1"}
    ui.click("panel-down", 0)
    ui.flush()
    assert ui.state("s.blots.map((b) => b.name)") == ["control", "target"]
    band_labels = figure_texts(ui, "band-label")
    assert band_labels == ["GAPDH", "Target"]
    # the labelled blot is now the lower panel: its labels need room between the gels
    images = page.locator("[data-t=preview] svg image")
    boxes = [ui.rect(images.nth(i)) for i in range(2)]
    assert (boxes[1]["y"] - boxes[0]["y"] - boxes[0]["height"]) / 2 > 2 * 1.7 * 8
    ui.t("panel-include", 0).uncheck()
    ui.flush()
    assert page.locator("[data-t=preview] svg image").count() == 1 and figure_texts(ui, "band-label") == ["Target"]


def test_rotated_labels_stay_above_the_gel(figured):
    ui = figured
    ui.select_blot(0)
    ui.click("label-add")
    ui.flush()
    ui.state("(b.session.figure.label_rows[0].values = b.session.lanes.map((_, i) => `Sample ${i + 1}`), WB.app.changed('figure'))")
    for rotation in ("0", "45", "90"):
        ui.choose("label-rotation", rotation)
        svg = ui.page.locator("[data-t=preview] svg")
        gel = ui.rect(svg.locator("image").first)
        labels = svg.locator("text.lane-label").all()
        assert len(labels) == 8
        lane_x = ui.state("b.session.lanes.map((l) => l.x_center)")
        for i, label in enumerate(labels):
            box = ui.rect(label)
            assert box["y"] + box["height"] <= gel["y"] + 0.5, rotation
            x = gel["x"] + (lane_x[i] + 0.5) / 640 * gel["width"]
            if rotation == "45":
                # the text starts at the lane; turning it lifts its top-left
                # corner to the left by about its height
                assert box["x"] == pytest.approx(x, abs=0.9 * 8 * 2)
            else:
                assert box["x"] + box["width"] / 2 == pytest.approx(x, abs=2)


def test_export_keeps_the_image_pixels(figured, blot):
    ui = figured
    ui.select_blot(0)
    ui.state("(b.session.figure.crop = [49.5, 99.5, 249.5, 499.5], WB.app.changed('figure'))")  # 200 x 400 px
    ui.t("panel-include", 1).uncheck()
    ui.flush()

    svg_file = ui.download("export-svg")
    assert svg_file.suggested_filename == "target_figure.svg"
    svg = open(svg_file.path()).read()
    assert svg.startswith("<svg") and 'font-family="Arial' in svg and "<text" not in svg  # no labels yet
    (data,) = re.findall(r'href="data:image/png;base64,([^"]+)"', svg)
    assert png_size(base64.b64decode(data)) == (400, 200)
    width_pt = float(re.search(r'<image x="0" y="[\d.-]+" width="([\d.]+)"', svg).group(1))
    assert width_pt == pytest.approx(60 / 25.4 * 72, abs=0.01)

    # the embedded pixels are the crop with the exposure applied, nothing else
    lo, hi = ui.state("b.session.transform.contrast_limits")
    expected = np.minimum(np.floor(np.clip((blot["img"][50:250, 100:500].astype(np.float64) - lo) / (hi - lo), 0, 1) * 256), 255)
    got = ui.page.evaluate(
        """async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
            const ctx = c.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            return Array.from({ length: c.width * c.height }, (_, i) => d[4 * i]);
        }""",
        "data:image/png;base64," + data,
    )
    assert np.array_equal(np.array(got).reshape(200, 400), expected)

    # PNG at lossless resolution: one image pixel per output pixel
    png_file = ui.download("export-png")
    width, height = png_size(open(png_file.path(), "rb").read())
    native = 400 / (60 / 25.4)
    assert ui.state("WB.figurepanel.build().nativeDpi") == pytest.approx(native)
    assert width == pytest.approx(400, abs=8) and height == pytest.approx(200, abs=8)
    worst = ui.page.evaluate(
        """async () => {
            const built = WB.figurepanel.build();
            const blob = await WB.figure.toPng(built, built.nativeDpi);
            const bitmap = await createImageBitmap(blob);
            const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
            const ctx = c.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
            const gel = blob.gels[0];
            if (gel.width !== 400 || gel.height !== 200) throw new Error(`gel is ${gel.width} x ${gel.height}`);
            const out = ctx.getImageData(gel.x, gel.y, 400, 200).data;
            const b = WB.app.blot();
            const [lo, hi] = b.session.transform.contrast_limits;
            const gray = WB.processing.toGray8(WB.processing.crop(b.work.wb, [50, 100, 250, 500]), lo, hi);
            // away from the 1-pixel border line
            let worst = 0;
            for (let y = 3; y < 197; y++) for (let x = 3; x < 397; x++)
                worst = Math.max(worst, Math.abs(out[4 * (y * 400 + x)] - gray[y * 400 + x]));
            return worst;
        }"""
    )
    assert worst <= 1

    # custom dpi resamples
    ui.choose("resolution", "0")
    ui.set("dpi", 72)
    small = ui.download("export-png")
    assert png_size(open(small.path(), "rb").read())[0] < 200


def test_project_file_restores_everything(figured, tmp_path):
    ui = figured
    ui.select_blot(0)
    ui.tab("prepare")
    ui.set("angle", 1.5)
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (10, 12), (400, 620))
    ui.click("crop-apply")
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.choose("bg-method", "linear")
    ui.set("bg-line-start", 3000)
    ui.tab("figure")
    ui.click("label-add")
    ui.flush()
    ui.t("label-cell", 0).fill("a")
    ui.t("label-cell", 0).dispatch_event("change")
    ui.set("mw-count", 3)
    ui.click("mw-place")
    ui.set("gap", 5)
    ui.choose("label-style", "table")
    ui.state("(s.blots[1].name = 'Loading control', s.blots[1].labels = true, WB.app.changed('blots'))")
    ui.flush()

    before = ui.state("JSON.stringify(WB.project.serialize())")
    results = ui.state("WB.app.results(s.blots[0])")
    figure = ui.state("WB.figurepanel.build().svg")
    saved = ui.download("save-project")
    assert saved.suggested_filename == "target.webblot.json"
    path = tmp_path / saved.suggested_filename
    saved.save_as(path)
    stored = json.loads(path.read_text())
    assert stored["app"] == "web_blot" and len(stored["blots"]) == 2 and stored["blots"][0]["wb"]["dtype"] == "uint16"

    # a fresh page
    ui.page.goto(INDEX_URL)
    ui.page.wait_for_function("window.WB && WB.project")
    assert ui.state("s.blots.length") == 0
    ui.t("open-project").set_input_files(str(path))
    ui.page.wait_for_function("WB.state.blots.length === 2")
    ui.flush()
    assert ui.state("JSON.stringify(WB.project.serialize())") == before
    assert ui.state("s.blots.map((b) => b.name)") == ["target", "Loading control"]
    assert ui.state("WB.app.results(s.blots[0])") == results
    assert ui.state("WB.figurepanel.build().svg") == figure
    assert ui.state("[s.blots[0].work.wb.w, s.blots[0].session.transform.rotation_deg, s.style.gap_mm]")[1:] == [1.5, 5]
    assert ui.page.locator("[data-t=card]").count() == 2


def test_copy_setup_between_blots(figured):
    ui = figured
    ui.select_blot(0)
    ui.tab("prepare")
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (20, 30), (400, 600))
    ui.click("crop-apply")
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.tab("figure")
    ui.click("label-add")
    ui.flush()
    ui.state("(b.session.figure.label_rows[0].values = 'abcdefgh'.split(''), WB.app.changed('figure'))")
    source = ui.state("[b.session.transform.crop, b.session.lanes.map((l) => l.x_center)]")

    ui.select_blot(1)
    ui.tab("prepare")
    ui.choose("copy-from", str(ui.state("s.blots[0].id")))
    assert ui.state("[b.session.transform.crop, b.session.lanes.map((l) => l.x_center)]") == source
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == ui.state("[s.blots[0].work.wb.w, s.blots[0].work.wb.h]")
    assert ui.state("b.session.lanes.every((l) => l.peaks.length === 0)")
    assert ui.state("b.session.figure.label_rows[0].values.join('')") == "abcdefgh"
    # independent afterwards, and the source is untouched
    ui.state("(b.session.lanes[0].x_center += 10, b.session.figure.label_rows[0].values[0] = 'x')")
    assert ui.state("s.blots[0].session.lanes[0].x_center") == source[1][0]
    assert ui.state("s.blots[0].session.figure.label_rows[0].values[0]") == "a"
    assert ui.state("s.blots[0].session.lanes.every((l) => l.peaks.length === 3)")


def test_blots_can_be_removed_and_reordered(ui, blot_files):
    ui.add_files(*blot_files)
    ui.click("blot-down", 0)
    ui.flush()
    assert ui.state("s.blots.map((b) => b.name)") == ["control", "target"]
    assert ui.page.locator("[data-t=card] [data-t=blot-name]").nth(0).input_value() == "control"
    ui.page.once("dialog", lambda d: d.accept())
    ui.click("blot-remove", 0)
    ui.flush()
    assert ui.state("s.blots.map((b) => b.name)") == ["target"] and ui.state("b.labels") is True
    ui.t("blot-name").fill("Renamed")
    ui.t("blot-name").dispatch_event("change")
    ui.flush()
    assert ui.state("b.name") == "Renamed" and ui.t("selected-name").inner_text() == "Renamed"


def test_drawn_shapes_are_visible_adjustable_and_applied_on_request(ui, blot_files):
    ui.add_files(*blot_files)
    page = ui.page

    def shape_box(name):
        box = page.locator(f"[data-t={name}]").bounding_box()
        return box

    # every tool shows its shape while it is being drawn, also on a card that
    # was not the selected one (selecting it redraws the card)
    for tab, tool in (("prepare", "tool-crop"), ("prepare", "tool-level"), ("lanes", "tool-roi"), ("figure", "tool-figarea")):
        ui.select_blot(1)
        ui.tab(tab)
        ui.click(tool)
        ui.flush()
        start, end = ui.on_card(0, 80, 100), ui.on_card(0, 300, 500)
        page.mouse.move(*start)
        page.mouse.down()
        page.mouse.move((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
        page.wait_for_timeout(80)  # several frames: the card is redrawn in between
        page.mouse.move(*end)
        page.wait_for_timeout(80)
        drawn = page.locator("[data-t=drawing]")
        assert drawn.count() == 1 and drawn.is_visible(), tool
        box = drawn.bounding_box()
        assert box["width"] == pytest.approx(end[0] - start[0], abs=3), tool
        assert box["height"] == pytest.approx(end[1] - start[1], abs=3), tool
        page.mouse.up()
        ui.flush()
        assert page.locator("[data-t=drawing]").count() == 0
        assert ui.state("b.name") == "target"
    ui.tab("prepare")

    # the crop rectangle stays, can be moved and resized, and nothing is cropped yet
    assert ui.state("b.pending.crop") == pytest.approx([80, 100, 300, 500], abs=3)
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == [640, 420]
    assert ui.t("crop-apply").is_enabled() and shape_box("crop-shape")["width"] > 100
    ui.drag_on_card(0, (190, 300), (200, 320))  # move by (+10, +20)
    assert ui.state("b.pending.crop") == pytest.approx([90, 120, 310, 520], abs=4)
    ui.drag_on_card(0, (310, 520), (350, 600))  # bottom-right corner
    assert ui.state("b.pending.crop") == pytest.approx([90, 120, 350, 600], abs=4)
    ui.drag_on_card(0, (90, 120), (60, 40))  # top-left corner
    crop = ui.state("b.pending.crop")
    assert crop == pytest.approx([60, 40, 350, 600], abs=4)

    # the line stays too; its ends can be dragged
    line = ui.state("b.pending.level")
    assert np.allclose(line, [[80, 100], [300, 500]], atol=3)
    ui.drag_on_card(0, (300, 500), (100, 520))
    assert np.allclose(ui.state("b.pending.level"), [[80, 100], [100, 520]], atol=3)
    assert ui.state("b.session.transform.rotation_deg") == 0

    # each blot keeps its own shapes; the other blot has none
    assert ui.state("s.blots[1].pending") == {"crop": None, "level": None}

    # discard removes a shape without applying it
    ui.click("level-discard")
    ui.flush()
    assert ui.state("b.pending.level") is None and page.locator("[data-t=level-shape]").count() == 0
    assert not ui.t("level-apply").is_enabled() and ui.state("b.pending.crop") is not None

    # apply: the image is cropped to the adjusted rectangle and the shape is gone
    ui.click("crop-apply")
    ui.flush()
    applied = ui.state("b.session.transform.crop")
    assert applied == pytest.approx(crop, abs=1)
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == [applied[3] - applied[1], applied[2] - applied[0]]
    assert ui.state("b.pending.crop") is None and page.locator("[data-t=crop-shape]").count() == 0
    assert not ui.t("crop-apply").is_enabled()

    # Escape stops drawing, and discards a shape that is waiting
    ui.click("tool-crop")
    ui.flush()
    page.keyboard.press("Escape")
    ui.flush()
    assert ui.state("s.tool") is None
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (20, 20), (100, 200))
    assert ui.state("b.pending.crop") is not None
    page.locator("[data-t=card] .dim").first.click()
    page.keyboard.press("Escape")
    ui.flush()
    assert ui.state("b.pending.crop") is None and ui.state("b.session.transform.crop") == applied

    # the shapes are not part of a saved project
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (20, 20), (100, 200))
    assert "pending" not in ui.state("JSON.stringify(WB.project.serialize())")


def canvas_pixel(ui, y, x, card=0):
    """Grey level of a card's image at image point (y, x)."""
    return ui.page.evaluate(
        "([card, y, x]) => document.querySelectorAll('[data-t=card] canvas')[card].getContext('2d').getImageData(x, y, 1, 1).data[0]",
        [card, y, x],
    )


def set_slider(locator, fraction):
    locator.evaluate(
        "(el, f) => { el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * f); el.dispatchEvent(new Event('input', { bubbles: true })); }",
        fraction,
    )


def test_brightfield_overlay_with_its_own_exposure(ui, blot_files, blot, tmp_path):
    ui.add_files(blot_files[0])
    page = ui.page
    card = page.locator("[data-t=card]")
    bf_path = tmp_path / "bf.tif"
    tifffile.imwrite(bf_path, blot["bf"][::2, ::2])  # half size: it is fitted to the blot
    ladder = (int(blot["ladder_ys"][2]), int(blot["centers"][0]))  # a marker band; the blot has nothing there
    band = (int(blot["band_ys"][0]), int(blot["centers"][3]))  # a band of the blot; the brightfield has nothing there
    without = canvas_pixel(ui, *ladder)
    # one exposure row as long as there is no brightfield
    assert card.locator(".exposure").count() == 1 and card.locator("[data-t=bf-min]").count() == 0

    ui.t("bf-file").set_input_files(str(bf_path))
    page.wait_for_function("WB.app.blot().work.bf !== null")
    ui.flush()
    # the stored image stays as read; what is shown is fitted to the blot
    assert ui.state("[b.raw.bf.w, b.raw.bf.h]") == [320, 210]
    assert ui.state("[b.work.bf.w, b.work.bf.h]") == [640, 420] and ui.t("bf-name").inner_text() == "bf"
    # bright bands on dark: the dark marker band of the brightfield shows up bright
    assert canvas_pixel(ui, *ladder) > without + 100

    # a second row of min / max / gamma appears, for the brightfield only
    rows = card.locator(".exposure")
    assert rows.count() == 2
    assert [r.strip().split()[0] for r in rows.all_inner_texts()] == ["Blot", "Brightfield"]
    blot_limits = ui.state("b.session.transform.contrast_limits")
    bf_limits = ui.state("b.session.transform.bf_contrast_limits")
    empty = (10, 630)  # nothing in either image
    band_before, empty_before = canvas_pixel(ui, *band), canvas_pixel(ui, *empty)
    set_slider(card.locator("[data-t=bf-min]"), 0.95)  # the brightfield's membrane is no longer at its top level
    ui.flush()
    assert canvas_pixel(ui, *empty) > empty_before + 30  # so it shows as a haze
    assert ui.state("b.session.transform.bf_contrast_limits[0]") > bf_limits[0]
    assert ui.state("b.session.transform.contrast_limits") == blot_limits
    assert canvas_pixel(ui, *band) == band_before
    ui.set("bf-gamma", 3)
    assert ui.state("[b.session.transform.bf_gamma, b.session.transform.gamma]") == [3, 1]
    hazy = canvas_pixel(ui, *empty)
    ui.set("bf-gamma", 0.3)
    assert canvas_pixel(ui, *empty) != hazy  # gamma acts on the brightfield too
    ui.set("bf-gamma", 3)
    # the blot's own row leaves the brightfield alone
    changed = ui.state("b.session.transform.bf_contrast_limits")
    set_slider(card.locator("[data-t=max]"), 0.3)
    ui.set("gamma", 0.8)
    assert ui.state("b.session.transform.bf_contrast_limits") == changed and ui.state("b.session.transform.bf_gamma") == 3
    assert ui.state("b.session.transform.contrast_limits[1]") < blot_limits[1]
    # Auto on the brightfield row resets only the brightfield
    card.locator("[data-t=bf-auto]").click()
    ui.flush()
    assert ui.state("b.session.transform.bf_contrast_limits") == pytest.approx(bf_limits)
    assert float(card.locator("[data-t=bf-min]").input_value()) == pytest.approx(bf_limits[0], rel=1e-3)
    ui.set("bf-gamma", 1)
    card.locator("[data-t=auto]").click()
    ui.flush()  # Auto rebuilds the sliders; wait for that before typing into one
    ui.set("gamma", 1)
    assert ui.state("[b.session.transform.gamma, b.session.transform.bf_gamma]") == [1, 1]
    assert ui.state("b.session.transform.contrast_limits") == pytest.approx(blot_limits)

    ui.t("bf-show").uncheck()
    ui.flush()
    assert canvas_pixel(ui, *ladder) == without
    ui.t("bf-show").check()
    # inverted display: both are shown dark on light and the darker one wins
    card.locator("[data-t=invert]").check()
    ui.flush()
    assert canvas_pixel(ui, *ladder) < 120 and canvas_pixel(ui, 10, 630) > 150
    # rotation and crop apply to both images
    ui.set("angle", 90)
    assert ui.state("[b.work.bf.w, b.work.bf.h]") == ui.state("[b.work.wb.w, b.work.wb.h]") == [420, 640]
    # the exposure is part of a saved project
    ui.set("bf-gamma", 1.5)
    saved = ui.state("JSON.stringify(WB.project.serialize())")
    assert '"bf_gamma":1.5' in saved
    ui.state("WB.project.load(JSON.parse(JSON.stringify(WB.project.serialize())))")
    ui.flush()
    assert ui.state("JSON.stringify(WB.project.serialize())") == saved
    ui.tab("prepare")
    page.once("dialog", lambda d: d.accept())
    ui.click("bf-remove")
    ui.flush()
    assert ui.state("b.raw.bf") is None and page.locator("[data-t=bf-show]").count() == 0
    assert page.locator("[data-t=card] .exposure").count() == 1


def test_blots_are_reordered_and_merged_by_dragging(ui, blot_files, blot, tmp_path):
    marker = tmp_path / "marker.tif"
    tifffile.imwrite(marker, blot["bf"])
    ui.add_files(blot_files[0], marker, blot_files[1])
    page = ui.page
    page.locator("[data-t=card-size]").evaluate("(el) => { el.value = '260'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
    ui.flush()
    cards = page.locator("[data-t=card]")
    names = lambda: ui.state("s.blots.map((b) => b.name)")
    assert names() == ["target", "marker", "control"]

    def drag(source, target, where):
        """Drag a card by its handle: onto the image, or onto the left/right of the header."""
        if where == "image":
            cards.nth(source).locator("[data-t=blot-grip]").drag_to(cards.nth(target).locator("svg.overlay"))
        else:
            head = cards.nth(target).locator(".card-head").bounding_box()
            card = cards.nth(target).bounding_box()
            x = 12 if where == "before" else card["width"] - 12
            cards.nth(source).locator("[data-t=blot-grip]").drag_to(cards.nth(target), target_position={"x": x, "y": head["height"] / 2})
        ui.flush()

    # order: dropped beside a card, away from its image
    drag(2, 0, "before")
    assert names() == ["control", "target", "marker"]
    drag(0, 2, "after")
    assert names() == ["target", "marker", "control"]
    drag(0, 1, "after")
    assert names() == ["marker", "target", "control"]
    drag(1, 0, "before")
    assert names() == ["target", "marker", "control"]
    assert cards.nth(0).locator("[data-t=blot-name]").input_value() == "target"
    # the figure follows the order of the cards
    ui.tab("figure")
    assert page.locator("[data-t=panel-row]").all_inner_texts()[0].strip().startswith("target")

    # give the marker blot settings of its own; they must survive a merge and a split
    ui.select_blot(1)
    ui.tab("prepare")
    ui.set("angle", 90)
    ui.tab("lanes")
    ui.click("lane-add")
    ui.flush()
    marker_state = ui.state("JSON.stringify(b.session)")
    marker_pixels = ui.state("Array.from(b.raw.wb.data.slice(0, 50))")

    # dropped onto another blot's image: it becomes that blot's brightfield
    drag(1, 0, "image")
    assert names() == ["target", "control"] and ui.state("b.name") == "target"
    assert ui.state("Array.from(b.raw.bf.data.slice(0, 50))") == marker_pixels
    assert "+ marker" in cards.nth(0).locator("[data-t=dim]").inner_text()
    assert cards.nth(0).locator(".exposure").count() == 2 and cards.nth(1).locator(".exposure").count() == 1
    ui.tab("prepare")
    assert ui.t("bf-name").inner_text() == "marker"
    ladder = (int(blot["ladder_ys"][2]), int(blot["centers"][0]))
    lit = canvas_pixel(ui, *ladder)
    ui.t("bf-show").uncheck()
    ui.flush()
    assert lit > 100 + canvas_pixel(ui, *ladder)

    # a merged pair survives saving and opening a project
    saved = ui.state("JSON.stringify(WB.project.serialize())")
    ui.state("WB.project.load(JSON.parse(JSON.stringify(WB.project.serialize())))")
    ui.flush()
    assert ui.state("JSON.stringify(WB.project.serialize())") == saved
    ui.select_blot(0)
    ui.tab("prepare")

    # split: the marker is a blot again, right after the target, exactly as it was
    ui.click("bf-split")
    ui.flush()
    assert names() == ["target", "marker", "control"]
    assert ui.state("s.blots[0].raw.bf") is None and ui.state("s.blots[0].bfOrigin") is None
    assert ui.state("JSON.stringify(s.blots[1].session)") == marker_state
    assert ui.state("Array.from(s.blots[1].raw.wb.data.slice(0, 50))") == marker_pixels
    assert ui.state("[s.blots[1].work.wb.w, s.blots[1].work.wb.h]") == [420, 640]
    assert cards.count() == 3 and page.locator("[data-t=bf-split]").count() == 0

    # dropping onto a blot that already has a brightfield swaps them: nothing is lost
    drag(1, 0, "image")
    drag(1, 0, "image")
    assert names() == ["target", "marker"] and ui.state("s.blots[0].bfOrigin.name") == "control"
    # a blot that itself has a brightfield takes it along and gets it back
    drag(0, 1, "image")
    assert names() == ["marker"] and ui.state("b.bfOrigin.name") == "target"
    ui.tab("prepare")
    ui.click("bf-split")
    ui.flush()
    assert ui.state("s.blots.map((b) => [b.name, b.bfOrigin ? b.bfOrigin.name : null])") == [["marker", None], ["target", "control"]]
    # dropping a blot on itself does nothing
    drag(0, 0, "image")
    drag(0, 0, "after")
    assert names() == ["marker", "target"]


def test_project_files_of_another_version_are_refused(ui):
    ui.click("add-sample")
    ui.flush()
    other = ui.state("(() => { const d = WB.project.serialize(); d.version -= 1; return JSON.stringify(d); })()")
    message = ui.page.evaluate("(text) => { try { WB.project.load(JSON.parse(text)); return null; } catch (e) { return e.message; } }", other)
    assert "another version" in message
    assert ui.state("s.blots.length") == 1  # what was open is untouched


def test_what_a_tab_shows_is_in_view_without_scrolling(ui):
    """Reported: detect lanes on the sample, press Quantify, 'nothing happens'."""
    page = ui.page
    page.set_viewport_size({"width": 1200, "height": 640})  # a small laptop window
    ui.click("add-sample")
    ui.flush()
    page.locator("[data-t=card-size]").evaluate("(el) => { el.value = '700'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.tab("quantify")
    # the plots are on screen, below the blot, and say what to do next
    first = page.locator("svg.plot").first
    assert page.locator("svg.plot").count() == ui.state("b.session.lanes.length") > 0
    box = ui.rect(first)
    assert 0 < box["y"] and box["y"] + box["height"] <= 640
    notice = page.locator("[data-t=no-peaks]")
    assert notice.is_visible() and ui.rect(notice)["y"] < 640
    notice.locator("button").click()
    ui.flush()
    assert all(n > 0 for n in ui.state("b.session.lanes.map((l) => l.peaks.length)"))
    assert page.locator("[data-t=no-peaks]").count() == 0 and page.locator("[data-t=peak-region]").count() > 0
    # the blot is still reachable above, and the figure preview is in view on its tab
    assert ui.rect(page.locator("[data-t=card] canvas"))["y"] < 300
    ui.tab("figure")
    preview = ui.rect(page.locator("[data-t=preview] svg"))
    assert 0 < preview["y"] < 640 - 80
    # the other tabs give the blots the whole area again
    ui.tab("prepare")
    assert "split" not in (page.locator("main").get_attribute("class") or "")


@pytest.mark.parametrize("blocked", ["quantification.js", "lanes.js", "UTIF.js", "figurepanel.js"])
def test_a_script_that_does_not_load_is_reported(page, blocked):
    """Reported: a content blocker refused one script and Quantify silently did nothing."""
    page.route(f"**/{blocked}", lambda route: route.abort())
    page.goto(INDEX_URL)
    message = page.locator("[data-t=load-error]")
    message.wait_for()
    assert blocked in message.inner_text() and "blocker" in message.inner_text()
    assert page.locator("[data-t=add-blots]").count() == 0


def test_script_names_are_not_on_content_blocker_lists():
    """`quant.js` is the name of a tracking script and is refused by EasyPrivacy."""
    import re
    from conftest import ROOT

    scripts = re.findall(r'<script src="([^"]+)"', (ROOT / "index.html").read_text())
    assert len(scripts) > 10 and all((ROOT / s).exists() for s in scripts)
    # names of well-known tracking and advertising scripts that blockers match by file name
    refused = {"quant.js", "analytics.js", "ga.js", "gtm.js", "track.js", "tracker.js", "tracking.js", "pixel.js", "beacon.js",
               "ads.js", "ad.js", "advert.js", "banner.js", "stats.js", "counter.js", "piwik.js", "matomo.js", "fingerprint.js"}
    assert not refused & {s.rsplit("/", 1)[-1].lower() for s in scripts}


def test_brightfield_can_be_part_of_the_figure(ui, blot_files, blot, tmp_path):
    marker = tmp_path / "marker.tif"
    tifffile.imwrite(marker, blot["bf"])
    ui.add_files(blot_files[0])
    page = ui.page
    ladder = (int(blot["ladder_ys"][2]), int(blot["centers"][0]))  # a marker band; the blot has nothing there
    band = (int(blot["band_ys"][0]), int(blot["centers"][3]))

    def figure_pixel(y, x):
        """Grey level in the gel of the first panel at image point (y, x)."""
        return page.evaluate(
            """([y, x]) => { const gel = WB.figurepanel.build().gels[0];
                return gel.pixels.getContext("2d").getImageData(x - gel.box[1], y - gel.box[0], 1, 1).data[0]; }""",
            [y, x],
        )

    ui.tab("figure")
    # without a brightfield there is nothing to switch on
    assert page.locator("[data-t=figure-bf]").count() == 0
    plain = [figure_pixel(*ladder), figure_pixel(*band)]

    ui.tab("prepare")
    ui.t("bf-file").set_input_files(str(marker))
    page.wait_for_function("WB.app.blot().work.bf !== null")
    ui.tab("figure")
    # off by default: the figure is the blot alone, also while the card shows the merge
    assert not ui.t("figure-bf").is_checked()
    assert [figure_pixel(*ladder), figure_pixel(*band)] == plain
    assert canvas_pixel(ui, *ladder) > plain[0] + 100

    ui.t("figure-bf").check()
    ui.flush()
    assert ui.state("b.session.figure.show_bf") is True
    # the marker band is in the figure, and the figure shows what the card shows
    assert figure_pixel(*ladder) > plain[0] + 100 and figure_pixel(*band) == plain[1]
    for point in (ladder, band, (10, 630), (200, 300)):
        assert figure_pixel(*point) == canvas_pixel(ui, *point)
    # it is in the exported file
    svg = open(ui.download("export-svg").path()).read()
    (data,) = re.findall(r'href="data:image/png;base64,([^"]+)"', svg)
    exported = page.evaluate(
        """async ([url, y, x]) => { const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const c = document.createElement("canvas"); c.width = bitmap.width; c.height = bitmap.height;
            const ctx = c.getContext("2d"); ctx.drawImage(bitmap, 0, 0); return ctx.getImageData(x, y, 1, 1).data[0]; }""",
        ["data:image/png;base64," + data, *ladder],
    )
    assert exported == figure_pixel(*ladder)

    # it follows the brightfield's own exposure and the blot's display, and the figure area
    set_slider(page.locator("[data-t=card] [data-t=bf-min]"), 0.95)
    ui.flush()
    assert figure_pixel(10, 630) == canvas_pixel(ui, 10, 630) > plain[0] + 30
    page.locator("[data-t=card] [data-t=bf-auto]").click()
    page.locator("[data-t=card] [data-t=invert]").check()
    ui.flush()
    assert figure_pixel(*ladder) == canvas_pixel(ui, *ladder) < 120  # dark marker on a light gel
    ui.state("(b.session.figure.crop = [99.5, 9.5, 299.5, 399.5], WB.app.changed('figure'))")
    ui.flush()
    assert figure_pixel(*ladder) == canvas_pixel(ui, *ladder)
    # hiding the brightfield on the card does not take it out of the figure
    ui.tab("prepare")
    ui.t("bf-show").uncheck()
    ui.flush()
    assert figure_pixel(*ladder) < 120 and canvas_pixel(ui, *ladder) > 150

    # only this blot: a second blot with a brightfield stays plain; and it is saved
    ui.add_files(blot_files[1])
    ui.t("bf-file").set_input_files(str(marker))
    page.wait_for_function("WB.app.blot().work.bf !== null")
    ui.flush()
    assert ui.state("s.blots.map((b) => b.session.figure.show_bf)") == [True, False]
    saved = ui.state("JSON.stringify(WB.project.serialize())")
    ui.state("WB.project.load(JSON.parse(JSON.stringify(WB.project.serialize())))")
    ui.flush()
    assert ui.state("JSON.stringify(WB.project.serialize())") == saved
    assert ui.state("s.blots.map((b) => b.session.figure.show_bf)") == [True, False]


def test_collapse_identical_merges_neighbouring_labels(figured):
    ui = figured
    page = ui.page
    ui.select_blot(0)
    ui.t("panel-include", 1).uncheck()
    ui.click("label-add")
    ui.flush()
    ui.state("(b.session.figure.label_rows[0].values = ['WT', 'WT', 'WT', 'KO', 'KO', '', 'WT', 'WT'], WB.app.changed('figure'))")
    ui.flush()
    svg = page.locator("[data-t=preview] svg")
    labels = lambda: svg.locator("text.lane-label").all_text_contents()
    lines = lambda: page.evaluate(
        "[...document.querySelectorAll('[data-t=preview] svg line')].map((l) => ['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k))))"
    )
    gel = ui.rect(svg.locator("image"))
    lane_x = [gel["x"] + (x + 0.5) / 640 * gel["width"] for x in ui.state("b.session.lanes.map((l) => l.x_center)")]
    centre = lambda label: (lambda r: r["x"] + r["width"] / 2)(ui.rect(label))

    # not collapsed: one text per lane, no bars
    assert labels() == ["WT", "WT", "WT", "KO", "KO", "WT", "WT"] and lines() == []

    # collapsed, plain style: one centred text per run of identical neighbours, with a bar below it
    ui.t("label-collapse").check()
    ui.flush()
    assert labels() == ["WT", "KO", "WT"]  # the empty lane separates, and is not labelled
    texts = svg.locator("text.lane-label")
    assert centre(texts.nth(0)) == pytest.approx(lane_x[1], abs=1.5)  # middle of lanes 1-3
    assert centre(texts.nth(1)) == pytest.approx((lane_x[3] + lane_x[4]) / 2, abs=1.5)
    assert centre(texts.nth(2)) == pytest.approx((lane_x[6] + lane_x[7]) / 2, abs=1.5)
    bars = lines()
    assert len(bars) == 3 and all(y1 == y2 for _, y1, _, y2 in bars)
    for bar, label in zip(sorted(bars), [texts.nth(i) for i in range(3)]):
        box = ui.rect(label)
        left, right = [page.evaluate("([x]) => { const s = document.querySelector('[data-t=preview] svg'); return new DOMPoint(x, 0).matrixTransform(s.getScreenCTM()).x; }", [x]) for x in (bar[0], bar[2])]
        assert left < box["x"] and right > box["x"] + box["width"]  # the bar spans the label
        bar_y = page.evaluate("([y]) => { const s = document.querySelector('[data-t=preview] svg'); return new DOMPoint(0, y).matrixTransform(s.getScreenCTM()).y; }", [bar[1]])
        assert box["y"] + box["height"] <= bar_y + 1 < gel["y"] + 1  # text, then bar, then gel

    # collapsed, table style: merged cells; fewer cell borders than without collapsing
    ui.choose("label-style", "table")
    assert labels() == ["WT", "KO", "WT"]
    merged = len(lines())
    ui.t("label-collapse").uncheck()
    ui.flush()
    assert labels() == ["WT", "WT", "WT", "KO", "KO", "WT", "WT"]
    assert len(lines()) == merged + 4  # the separators inside the merged cells are back: 2 + 1 + 1
    ui.t("label-collapse").check()
    ui.flush()

    # saved with the project
    saved = ui.state("JSON.stringify(WB.project.serialize())")
    assert '"collapse":true' in saved
    ui.state("WB.project.load(JSON.parse(JSON.stringify(WB.project.serialize())))")
    ui.flush()
    assert ui.state("JSON.stringify(WB.project.serialize())") == saved
