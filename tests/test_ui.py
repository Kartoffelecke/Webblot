"""The interface, driven with real mouse and keyboard events in a browser."""

import base64
import io
import json
import math
import zipfile
import re
import struct

import numpy as np
import pytest
import tifffile
from conftest import INDEX_URL


def png_size(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


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
    assert centers == pytest.approx(blot["centers"], abs=1.5)
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
    # the same as the core gives for the drawn area, in pixel-edge coordinates
    expected = ui.state('WB.lanes.detect(WB.app.signal(b), { nLanes: 7, roi: b.roi.map((v) => v + 0.5), method: "even" }).map((l) => [l.x_center, l.y0, l.y1])')
    assert np.allclose(got, expected, atol=1e-6)


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


def test_quantify_table_shows_every_band(quantified):
    ui = quantified
    assert ui.page.locator("svg.plot").count() == 8
    assert ui.state("b.session.lanes.map((l) => l.peaks.length)") == [3] * 8
    got = ui.state("WB.app.results(b)")
    rows = np.array(got["rows"], dtype=float)
    assert got["bands"] == [1, 2, 3] and rows.shape == (8, 3) and np.all(rows > 0)
    # the loading control is the same in every lane of the test blot
    assert rows[:, 2].std() / rows[:, 2].mean() < 0.01

    # the table on screen and the CSV download show the same numbers
    cells = ui.page.locator("[data-t=results] tr").nth(1).locator("td").all_inner_texts()
    assert [float(c) for c in cells] == pytest.approx(got["rows"][0], rel=1e-4)
    csv = ui.download("results-csv")
    assert csv.suggested_filename == "target_areas.csv"
    lines = open(csv.path()).read().splitlines()
    assert lines[0] == "Lane,Peak 1,Peak 2,Peak 3" and len(lines) == 9
    assert [float(v) for v in lines[3].split(",")[1:]] == pytest.approx(got["rows"][2], rel=1e-5)


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
    assert ui.state("[b.session.figure.crop, b.session.figure.crop_on]") == [None, False] and page.locator("[data-t=figure-area]").count() == 0
    ui.t("figure-crop").check()
    ui.flush()
    # a box appears inside the image, to be adjusted by its corners
    assert ui.state("[b.session.figure.crop, b.session.figure.crop_on]") == [[41.5, 63.5, 377.5, 575.5], True]
    assert page.locator("[data-t=figure-area]").count() == 1
    ui.drag_on_card(0, (41.5, 63.5), (60, 20))
    ui.drag_on_card(0, (377.5, 575.5), (120, 620))
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
    ui.t("figure-crop").check()
    ui.flush()
    ui.drag_on_card(1, (377.5, 575.5), (355, 620))
    ui.drag_on_card(1, (41.5, 63.5), (285, 20))
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
    assert set(page.evaluate("[...document.querySelectorAll('[data-t=preview] svg line, [data-t=preview] svg rect')].map((e) => e.getAttribute('stroke-width'))")) == {"0.567"}  # 0.2 mm in points

    # style: table labels, unit once, line width; panel order and visibility
    ui.select_blot(0)
    ui.choose("label-style", "table")
    ui.choose("mw-unit-position", "top")
    ui.set("line-width", 1)
    texts = figure_texts(ui)
    assert texts.count("kDa") == 1 and "70" in texts and "70 kDa" not in texts and texts.count("WT") == 1
    assert set(page.evaluate("[...document.querySelectorAll('[data-t=preview] svg line')].map((e) => e.getAttribute('stroke-width'))")) == {"2.835"}
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
    ui.state("(b.session.figure.crop_on = true, b.session.figure.crop = [49.5, 99.5, 249.5, 499.5], WB.app.changed('figure'))")  # 200 x 400 px
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


def test_folder_download_restores_everything(figured, tmp_path, blot_files):
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

    before = ui.document()
    results = ui.state("WB.app.results(s.blots[0])")
    figure = ui.state("WB.figurepanel.build().svg")
    saved = ui.download("save-project")
    assert saved.suggested_filename == "target.zip"
    path = tmp_path / saved.suggested_filename
    saved.save_as(path)
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        assert {"target/folder.json", "target/target/blot.json", "target/target/raw.tif", "target/Loading control/blot.json", "target/Figure/figure.json"} <= names
        stored = json.loads(archive.read("target/target/blot.json"))
        assert stored["app"] == "web_blot" and stored["kind"] == "blot" and stored["transform"]["rotation_deg"] == 1.5
        assert np.array_equal(tifffile.imread(io.BytesIO(archive.read("target/target/raw.tif"))), tifffile.imread(blot_files[0]))

    # the page again: the folder is there as it was left
    ui.page.goto(INDEX_URL)
    ui.page.wait_for_function("window.WB && WB.library && WB.library.ready")
    ui.page.evaluate("WB.library.ready")
    ui.flush()
    assert ui.state("s.blots.length") == 2 and ui.document() == before
    # and from the downloaded file, as another folder
    ui.t("open-project").set_input_files(str(path))
    ui.page.wait_for_function("WB.state.folder.dir === 'target 2' && WB.state.blots.length === 2")
    ui.flush()
    assert ui.document() == before
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
    ui.click("blot-remove", 0)
    ui.flush()
    assert ui.state("s.blots.map((b) => b.name)") == ["target"] and ui.state("b.labels") is True
    # no question is asked: the message offers the way back
    assert "control" in ui.t("toast").inner_text()
    ui.click("toast-action")
    ui.flush()
    assert ui.state("s.blots.map((b) => [b.name, b.labels])") == [["control", False], ["target", True]]
    assert ui.page.locator("[data-t=card]").count() == 2 and ui.t("toast").count() == 0
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
    for tab, tool in (("prepare", "tool-crop"), ("prepare", "tool-level"), ("lanes", "tool-roi")):
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

    # the shapes are not saved
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (20, 20), (100, 200))
    assert "pending" not in json.dumps(ui.blot_json())


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

    # the brightfield's Invert is on its own row under the image, beside the blot's
    assert rows.nth(1).locator("[data-t=bf-invert]").count() == 1
    assert rows.nth(0).locator("[data-t=invert]").count() == 1
    assert page.locator("[data-t=bf-invert]").count() == 1  # and no longer in the side panel
    card.locator("[data-t=bf-invert]").check()
    ui.flush()
    assert ui.state("b.session.transform.bf_invert") is True
    assert canvas_pixel(ui, *ladder) < without + 100  # the marker band is no longer shown bright
    card.locator("[data-t=bf-invert]").uncheck()
    ui.flush()

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
    # the exposure is saved
    ui.set("bf-gamma", 1.5)
    saved = ui.document()
    assert '"bf_gamma":1.5' in saved
    ui.reopen()
    assert ui.document() == saved
    ui.tab("prepare")
    ui.click("bf-remove")
    assert "brightfield" in ui.confirm()
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

    # a merged pair survives saving and opening the folder
    saved = ui.document()
    ui.reopen()
    assert ui.document() == saved
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
    assert 0 < box["y"] and box["y"] + 124 <= 640  # its profile at least; the lane strip below it may need a scroll
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
    ui.state("(b.session.figure.crop_on = true, b.session.figure.crop = [99.5, 9.5, 299.5, 399.5], WB.app.changed('figure'))")
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
    saved = ui.document()
    ui.reopen()
    assert ui.document() == saved
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

    # saved with the folder
    saved = ui.document()
    assert '"collapse":true' in saved
    ui.reopen()
    assert ui.document() == saved


def test_zoom_and_pan_inside_a_blot(ui, blot_files):
    ui.add_files(*blot_files)
    card = ui.page.locator("[data-t=card]").nth(1)
    stage = ui.rect(card.locator(".stage"))
    assert ui.state("b.view") == {"zoom": 1, "x": 0, "y": 0}
    assert not card.locator("[data-t=zoom-reset]").is_enabled() and not card.locator("[data-t=zoom-out]").is_enabled()

    # the button zooms about the centre; the card keeps its size and only this blot is zoomed
    card.locator("[data-t=zoom-in]").click()
    assert ui.state("b.view") == pytest.approx({"zoom": 1.5, "x": 640 / 6, "y": 420 / 6})
    assert ui.state("s.blots[0].view.zoom") == 1
    assert ui.rect(card.locator(".stage")) == pytest.approx(stage)
    assert ui.rect(card.locator("canvas"))["width"] == pytest.approx(1.5 * stage["width"], abs=0.5)
    assert card.locator("[data-t=zoom-reset]").inner_text() == "150%"
    centre = [stage["x"] + stage["width"] / 2, stage["y"] + stage["height"] / 2]
    assert ui.on_card(1, 209.5, 319.5) == pytest.approx(centre, abs=0.5)
    # the image and the overlay show the same place
    canvas = ui.rect(card.locator("canvas"))
    assert [canvas["x"] + 320 / 640 * canvas["width"], canvas["y"] + 210 / 420 * canvas["height"]] == pytest.approx(centre, abs=0.5)

    # Ctrl + wheel zooms at the pointer: the image point under it stays there
    point = ui.on_card(1, 100, 200)
    ui.page.mouse.move(*point)
    ui.page.keyboard.down("Control")
    ui.page.mouse.wheel(0, -100)
    ui.page.keyboard.up("Control")
    ui.page.wait_for_function("WB.app.blot().view.zoom > 1.6")
    assert ui.on_card(1, 100, 200) == pytest.approx(point, abs=0.5)

    # the wheel alone moves the view, and so does dragging the image
    x, y = ui.state("[b.view.x, b.view.y]")
    ui.page.mouse.wheel(0, 40)
    ui.page.wait_for_function(f"WB.app.blot().view.y > {y}")
    y = ui.state("b.view.y")
    ui.drag(centre, [centre[0] + 30, centre[1] + 20])
    assert ui.state("[b.view.x, b.view.y]") == pytest.approx([x - 30 * ui.state("640 / b.view.zoom") / stage["width"], y - 20 * ui.state("420 / b.view.zoom") / stage["height"]], abs=0.5)
    # the view stays inside the image
    ui.page.mouse.move(centre[0], centre[1])
    ui.page.mouse.wheel(-5000, -5000)
    ui.page.wait_for_function("WB.app.blot().view.y === 0")
    assert ui.state("[b.view.x, b.view.y]") == [0, 0]

    # drawing on a zoomed blot lands on the image pixels under the pointer
    view = ui.state("b.view")
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(1, (30, 40), (180, 260))
    assert ui.state("b.pending.crop") == pytest.approx([30, 40, 180, 260], abs=2)
    assert ui.state("b.view") == view and view["zoom"] > 1.6  # drawing does not move the view

    # the % button shows everything again; another image size also does
    card.locator("[data-t=zoom-reset]").click()
    assert ui.state("b.view") == {"zoom": 1, "x": 0, "y": 0}
    assert ui.rect(card.locator("canvas")) == pytest.approx(stage, abs=0.5)
    card.locator("[data-t=zoom-in]").click()
    ui.click("crop-apply")
    ui.flush()
    assert ui.state("[b.work.wb.w, b.view.zoom]") == [220, 1]
    # zooming is not something a blot is measured or saved with
    assert "view" not in ui.blot_json()


def test_new_blot_from_a_crop_area(ui, blot_files):
    ui.add_files(*blot_files)
    ui.select_blot(0)
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("prepare")
    assert not ui.t("crop-new").is_enabled()
    ui.click("tool-crop")
    ui.flush()
    ui.drag_on_card(0, (50, 60), (150, 600))
    ui.click("crop-new")
    ui.flush()

    # the area is a blot of its own, right after the blot it was taken from, which is unchanged
    assert ui.state("s.blots.map((b) => b.name)") == ["target", "target 2", "control"]
    assert ui.page.locator("[data-t=card]").count() == 3
    assert ui.state("[b.name, b.session.transform.crop, b.work.wb.w, b.work.wb.h]") == ["target", None, 640, 420]
    crop = ui.state("s.blots[1].session.transform.crop")
    assert crop == pytest.approx([50, 60, 150, 600], abs=3)
    assert ui.state("[s.blots[1].work.wb.w, s.blots[1].work.wb.h]") == [crop[3] - crop[1], crop[2] - crop[0]]
    # it shows the pixels of the area, and has the lanes on the same pixels
    assert ui.page.evaluate(
        """([y0, x0]) => {
            const [a, b] = WB.state.blots;
            return [0, 1, 500, 2000].every((i) => {
                const y = Math.floor(i / b.work.wb.w), x = i % b.work.wb.w;
                return b.work.wb.data[i] === a.work.wb.data[(y + y0) * a.work.wb.w + x + x0];
            });
        }""",
        crop[:2],
    )
    assert ui.state("s.blots[1].session.lanes.map((l) => l.x_center)") == pytest.approx(
        [x - crop[1] for x in ui.state("b.session.lanes.map((l) => l.x_center)")]
    )
    # only one of them has the lane labels above it
    assert ui.state("s.blots.map((b) => b.labels)") == [True, False, False]

    # the rectangle is still there: move it and take the next area
    assert ui.state("b.pending.crop") is not None and ui.state("s.blots[1].pending.crop") is None
    ui.drag(ui.on_card(0, 100, 300), ui.on_card(0, 300, 300))
    ui.click("crop-new")
    ui.flush()
    assert ui.state("s.blots.map((b) => b.name)") == ["target", "target 2", "target 3", "control"]
    assert ui.state("s.blots[2].session.transform.crop") == pytest.approx([250, 60, 350, 600], abs=4)

    # the new blots are independent: cropping and lanes of one leave the others alone
    ui.select_blot(1)
    ui.click("crop-reset")
    ui.flush()
    assert ui.state("[s.blots[1].work.wb.h, s.blots[2].work.wb.h, s.blots[0].work.wb.h]") == [420, pytest.approx(100, abs=4), 420]
    ui.state("(s.blots[1].session.lanes.length = 2, 0)")
    assert ui.state("[s.blots[0].session.lanes.length, s.blots[2].session.lanes.length]") == [8, 8]

    # and they come back from the saved folder
    ui.reopen()
    assert ui.state("s.blots.map((b) => [b.name, b.work.wb.h])") == [["target", 420], ["target 2", 420], ["target 3", pytest.approx(100, abs=4)], ["control", 420]]


def test_normalize_across_samples(quantified):
    ui = quantified
    raw = ui.state("WB.app.results(b).rows")
    top = [max(row[j] for row in raw) for j in range(3)]
    assert not ui.t("normalize").is_checked()
    ui.t("normalize").check()
    ui.flush()

    # every peak is divided by its largest area among the lanes
    expected = [[v / top[j] for j, v in enumerate(row)] for row in raw]
    table = [[float(c) for c in ui.page.locator("[data-t=results] tr").nth(i + 1).locator("td").all_inner_texts()] for i in range(8)]
    assert np.allclose(table, expected, rtol=1e-4)
    assert [max(column) for column in zip(*table)] == [1, 1, 1] and min(min(row) for row in table) > 0
    csv = ui.download("results-csv")
    assert csv.suggested_filename == "target_normalized.csv"
    lines = open(csv.path()).read().splitlines()
    assert lines[0] == "Lane,Peak 1,Peak 2,Peak 3"
    assert np.allclose([[float(v) for v in line.split(",")[1:]] for line in lines[1:]], expected, rtol=1e-5)
    # the areas themselves are what they were
    assert ui.state("WB.app.results(b).rows") == raw
    assert float(ui.t("peak-area").inner_text()) == pytest.approx(raw[0][0], rel=1e-4)

    # a peak that a lane does not have stays empty; one that is not above the background anywhere is left out
    ui.state("(b.session.lanes[6].peaks[2].quantify = false, WB.app.changed('quant'))")
    ui.flush()
    assert ui.page.locator("[data-t=results] tr").nth(7).locator("td").all_inner_texts()[2] == ""
    assert ui.page.evaluate("WB.quant.normalizeRows([[2, 0, null], [4, -1, null], [null, 0, null]])") == [[0.5, None, None], [1, None, None], [None, None, None]]

    # the option is saved with the folder
    ui.reopen()
    assert ui.state("s.normalize") is True
    ui.t("normalize").uncheck()
    ui.flush()
    assert float(ui.page.locator("[data-t=results] tr").nth(1).locator("td").first.inner_text()) == pytest.approx(raw[0][0], rel=1e-4)


def test_copy_is_numbers_only_unless_headers_are_asked_for(quantified):
    ui = quantified
    ui.page.evaluate("Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text) => ((window.copied = text), Promise.resolve()) }, configurable: true })")
    rows = ui.state("WB.app.results(b).rows")
    assert not ui.t("copy-headers").is_checked()
    ui.click("results-copy")
    lines = ui.page.evaluate("window.copied").splitlines()
    assert len(lines) == 8 and all(len(line.split("\t")) == 3 for line in lines)
    assert [float(v) for v in lines[2].split("\t")] == pytest.approx(rows[2], rel=1e-5)

    ui.t("copy-headers").check()
    ui.click("results-copy")
    lines = ui.page.evaluate("window.copied").splitlines()
    assert lines[0] == "Lane\tPeak 1\tPeak 2\tPeak 3" and len(lines) == 9
    assert lines[3].split("\t")[0] == "3" and [float(v) for v in lines[3].split("\t")[1:]] == pytest.approx(rows[2], rel=1e-5)
    # the choice stays while the panel is rebuilt
    ui.state("WB.app.changed('quant')")
    ui.flush()
    assert ui.t("copy-headers").is_checked()

    # the file has them either way
    ui.t("copy-headers").uncheck()
    csv = ui.download("results-csv")
    assert open(csv.path()).read().splitlines()[0] == "Lane,Peak 1,Peak 2,Peak 3"


def test_each_gel_is_grouped_with_its_border_in_the_svg(ui, blot_files):
    ui.add_files(*blot_files)
    ui.tab("figure")
    groups = ui.page.evaluate(
        """() => { const svg = new DOMParser().parseFromString(WB.figurepanel.build().svg, "image/svg+xml");
            return [...svg.querySelectorAll("image")].map((image) => {
                const g = image.parentNode;
                return [g.tagName, g.getAttribute("class"), [...g.children].map((c) => c.getAttribute("class") || c.tagName)];
            }); }"""
    )
    assert groups == [["g", "gel", ["image", "gel-border"]]] * 2
    # the PNG is still drawn: the borders without the pictures
    png = ui.download("export-png")
    assert png_size(open(png.path(), "rb").read())[0] > 100


def test_line_width_is_in_mm(ui):
    ui.click("add-sample")
    ui.tab("figure")
    assert ui.state("s.style.line_width_mm") == 0.2 and ui.t("line-width").input_value() == "0.2"
    strokes = "[...new DOMParser().parseFromString(WB.figurepanel.build().svg, 'image/svg+xml').querySelectorAll('rect, line')].map((e) => e.getAttribute('stroke-width'))"
    assert set(ui.state(strokes)) == {"0.567"}
    ui.set("line-width", 0.5)
    assert set(ui.state(strokes)) == {"1.417"}


def test_decrowd_moves_overlapping_side_labels_outwards(ui):
    ui.click("add-sample")
    ui.tab("figure")
    ui.state(
        """(b.session.figure.mw_markers = [{ y: 100, text: "70" }, { y: 120, text: "55" }, { y: 300, text: "25" }],
            b.session.figure.band_markers = [{ y: 110, text: "Target" }], b.session.figure.band_side = "left", WB.app.changed("figure"))"""
    )
    ui.flush()
    labels = """(() => { const svg = document.querySelector("[data-t=preview] svg");
        const lines = [...svg.querySelectorAll("line")].map((l) => ["x1", "y1", "x2", "y2"].map((k) => Number(l.getAttribute(k))));
        return [...svg.querySelectorAll("text.mw-label, text.band-label")].map((t) => {
            const box = t.getBBox();
            const y = box.y + box.height / 2;
            const level = lines.filter((l) => l[1] === l[3]);
            const line = level.reduce((best, l) => (Math.abs(l[1] - y) < Math.abs(best[1] - y) ? l : best));
            return { text: t.textContent, right: box.x + box.width, left: box.x, top: box.y, bottom: box.y + box.height, line: Math.abs(line[2] - line[0]) };
        }); })()"""

    def overlapping(found):
        return [(a["text"], b["text"]) for i, a in enumerate(found) for b in found[i + 1 :]
                if a["left"] < b["right"] and b["left"] < a["right"] and a["top"] < b["bottom"] and b["top"] < a["bottom"]]

    off = {f["text"]: f for f in ui.state(labels)}
    # one column: the same right edge and line length (within what the shapes of the letters add)
    spread = lambda key: max(f[key] for f in off.values()) - min(f[key] for f in off.values())
    assert spread("right") < 0.5 and spread("line") < 0.01
    assert overlapping(list(off.values()))

    ui.t("decrowd").check()
    ui.flush()
    assert ui.state("s.style.decrowd") is True
    on = {f["text"]: f for f in ui.state(labels)}
    assert not overlapping(list(on.values()))
    # labels with room stay where they were; the others go further out, in the order of their height, with longer lines
    for text in ("70", "25"):
        assert on[text]["right"] == pytest.approx(off[text]["right"]) and on[text]["line"] == pytest.approx(off[text]["line"])
    assert on["55"]["right"] < on["Target"]["left"] and on["Target"]["right"] < on["70"]["left"]
    assert on["55"]["line"] > on["Target"]["line"] > on["70"]["line"]
    # each line ends just before its text
    for f in on.values():
        gel_edge = off["70"]["right"] + off["70"]["line"] + 0.3 * 8
        assert gel_edge - f["line"] - f["right"] == pytest.approx(0.3 * 8, abs=0.3)
    # labels on the other side are not in the way
    ui.choose("band-side", "right")
    on = {f["text"]: f for f in ui.state(labels)}
    assert on["55"]["right"] < on["70"]["left"] and on["Target"]["left"] > on["70"]["right"]
    assert on["Target"]["line"] == pytest.approx(off["Target"]["line"])
    # nothing overlapping: the same figure with and without
    ui.state("(b.session.figure.mw_markers[1].y = 200, b.session.figure.band_markers[0].y = 150, WB.app.changed('figure'))")
    ui.flush()
    with_option = ui.state("WB.figurepanel.build().svg")
    ui.t("decrowd").uncheck()
    ui.flush()
    assert ui.state("WB.figurepanel.build().svg") == with_option


def test_markers_stand_at_the_side_of_the_blot_and_are_dragged_anywhere_along_their_height(ui):
    ui.click("add-sample")
    ui.tab("figure")
    ui.state(
        """(b.session.figure.crop_on = true, b.session.figure.crop = [99.5, 199.5, 299.5, 449.5], b.session.figure.mw_markers = [{ y: 200, text: "55" }],
            b.session.figure.band_markers = [{ y: 250, text: "Target" }, { y: 380, text: "below" }], WB.app.changed("figure"))"""
    )
    ui.flush()
    card = ui.page.locator("[data-t=card]").first
    stage = ui.rect(card.locator(".stage"))
    mw, band = ui.rect(card.locator("[data-t=mw-marker-tick]")), ui.rect(card.locator("[data-t=band-marker-tick]").first)
    # at the edges of the image, not of the figure area in its middle
    assert mw["x"] == pytest.approx(stage["x"], abs=2) and band["x"] + band["width"] == pytest.approx(stage["x"] + stage["width"], abs=2)
    assert mw["y"] + mw["height"] / 2 == pytest.approx(ui.on_card(0, 200, 0)[1], abs=1.5)
    # a marker outside the figure area is dimmed
    assert card.locator("[data-t=band-marker-tick]").nth(1).get_attribute("opacity") == "0.4"

    # grabbed in the middle of the image, inside the figure area, and at the far side
    ui.drag_on_card(0, (200, 320), (230, 330))
    assert ui.state("b.session.figure.mw_markers[0].y") == pytest.approx(230, abs=2)
    ui.drag_on_card(0, (230, 600), (180, 600))
    assert ui.state("b.session.figure.mw_markers[0].y") == pytest.approx(180, abs=2)
    assert ui.state("b.session.figure.crop") == [99.5, 199.5, 299.5, 449.5]
    # the figure area can still be moved and resized
    ui.drag_on_card(0, (100, 200), (90, 190))
    assert ui.state("b.session.figure.crop.slice(0, 2)") == pytest.approx([89.5, 189.5], abs=2)
    ui.drag_on_card(0, (150, 300), (160, 310))
    assert ui.state("b.session.figure.crop.slice(0, 2)") == pytest.approx([99.5, 199.5], abs=3)

    # on a zoomed blot they stand at the side of what is shown
    ui.state("(WB.workspace.zoom(b, 2, [200, 320]), 0)")
    mw = ui.rect(card.locator("[data-t=mw-marker-tick]"))
    assert ui.state("b.view.x") > 100 and mw["x"] == pytest.approx(stage["x"], abs=2)
    assert mw["y"] + mw["height"] / 2 == pytest.approx(ui.on_card(0, ui.state("b.session.figure.mw_markers[0].y"), 320)[1], abs=1.5)


PASTE = """([selector, index, text]) => {
    const cell = document.querySelectorAll(selector)[index];
    cell.focus();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    return cell.dispatchEvent(event);
}"""


def test_labels_are_pasted_from_a_spreadsheet(ui, blot_files):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("figure")
    ui.click("label-add")
    ui.flush()

    def paste(selector, index, text):
        handled = not ui.page.evaluate(PASTE, [f"[data-t={selector}]", index, text])
        ui.flush()
        return handled

    rows = "b.session.figure.label_rows.map((r) => [r.title, ...r.values])"
    # a block: to the right and down, adding the row that is missing
    assert paste("label-cell", 1, "a\tb\tc\r\nd\te\tf\r\n")
    assert ui.state(rows) == [["", "", "a", "b", "c", "", "", "", ""], ["", "", "d", "e", "f", "", "", "", ""]]
    assert ui.page.locator("[data-t=label-row]").count() == 2
    # a list copied as a column goes along the lanes
    assert paste("label-cell", 8, "x\ny\nz\n")
    assert ui.state(rows)[1] == ["", "x", "y", "z", "f", "", "", "", ""] and len(ui.state(rows)) == 2
    # from the title column; what does not fit the lanes is dropped
    assert paste("label-title", 0, "Drug\t-\t+")
    assert paste("label-cell", 6, "1\t2\t3\t4")
    assert ui.state(rows)[0] == ["Drug", "-", "+", "b", "c", "", "", "1", "2"]
    # one value is an ordinary paste
    assert not paste("label-cell", 0, "single")
    assert ui.state(rows)[0][1] == "-"
    figure = ui.state("WB.figurepanel.build().svg")
    assert ">Drug<" in figure and ">z<" in figure

    # Enter goes to the cell below, as in a sheet
    ui.t("label-cell", 2).fill("new")
    ui.page.keyboard.press("Enter")
    ui.flush()
    assert ui.state(rows)[0][3] == "new"
    assert ui.page.evaluate("[document.activeElement.dataset.r, document.activeElement.dataset.c]") == ["1", "3"]
    ui.page.keyboard.press("ArrowUp")
    assert ui.page.evaluate("[document.activeElement.dataset.r, document.activeElement.dataset.c]") == ["0", "3"]

    # markers: a list of labels goes down the markers that are there
    ui.set("mw-count", 3)
    ui.click("mw-place")
    ui.flush()
    texts = "b.session.figure.mw_markers.map((m) => m.text)"
    assert paste("mw-text", 0, "250\n150\n100\n75\n")
    assert ui.state(texts) == ["250", "150", "100"]
    assert "1 pasted label has no marker" in ui.t("mw-paste-note").inner_text()
    assert paste("mw-text", 1, "a\tb")
    assert ui.state(texts) == ["250", "a", "b"] and ui.t("mw-paste-note").count() == 0
    # y and label side by side: markers that are missing are added
    assert paste("mw-y", 0, "400\tZ\n50,5\tX\n60\tY\n410\tW")
    assert ui.state("b.session.figure.mw_markers") == [{"y": 50.5, "text": "X"}, {"y": 60, "text": "Y"}, {"y": 400, "text": "Z"}, {"y": 410, "text": "W"}]
    assert ui.page.locator("[data-t=mw-text]").count() == 4


def test_side_and_lower_panel_can_be_resized(ui):
    page = ui.page
    ui.click("add-sample")
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.tab("quantify")
    side, lower = page.locator("#side"), page.locator("#lower")
    assert ui.rect(side)["width"] == 400 and ui.t("lower-title").inner_text() == "Lane profiles of Sample 1"
    # the lower panel is a surface of its own
    colours = page.evaluate("[getComputedStyle(document.querySelector('#lower')).backgroundColor, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('#lower')).borderTopWidth]")
    assert colours[0] == "rgb(255, 255, 255)" != colours[1] and colours[2] == "1px"
    plot = ui.rect(page.locator("svg.plot").first)["width"]
    height = ui.rect(lower)["height"]

    def drag_bar(name, dx, dy):
        bar = ui.rect(ui.t(name))
        start = [bar["x"] + bar["width"] / 2, bar["y"] + bar["height"] / 2]
        ui.drag(start, [start[0] + dx, start[1] + dy])

    drag_bar("side-bar", -150, 0)
    assert ui.rect(side)["width"] == pytest.approx(550, abs=3)
    assert ui.rect(page.locator("svg.plot").first)["width"] == pytest.approx(plot - 150, abs=4)
    # the plots are drawn for their new width
    assert float(page.locator("svg.plot").first.get_attribute("viewBox").split()[2]) == pytest.approx(ui.rect(page.locator("svg.plot").first)["width"], abs=1)
    drag_bar("lower-bar", 0, 90)
    assert ui.rect(lower)["height"] == pytest.approx(height - 90, abs=4)
    assert "sized" in page.locator("main").get_attribute("class")
    bottom = ui.rect(lower)["y"] + ui.rect(lower)["height"]
    assert bottom <= 950 and ui.rect(page.locator("#workspace"))["height"] > 100
    # it cannot be made to vanish, nor to take everything
    drag_bar("lower-bar", 0, 2000)
    assert ui.rect(lower)["height"] == pytest.approx(120, abs=2)
    drag_bar("lower-bar", 0, -2000)
    assert ui.rect(page.locator("#workspace"))["height"] >= 100
    drag_bar("side-bar", 2000, 0)
    assert ui.rect(side)["width"] == pytest.approx(260, abs=2)
    drag_bar("side-bar", -190, 0)
    width, lower_height = ui.rect(side)["width"], ui.rect(lower)["height"]

    # the sizes are the page's: they are there after a reload, also on the other tab
    page.evaluate("WB.library.saveNow()")
    page.reload()
    page.wait_for_function("window.WB && WB.library && WB.library.ready")
    page.evaluate("WB.library.ready")
    ui.flush()
    assert ui.rect(side)["width"] == pytest.approx(width, abs=1)
    ui.tab("figure")
    assert ui.rect(lower)["height"] == pytest.approx(lower_height, abs=2) and ui.t("lower-title").inner_text() == "Figure preview"
    assert page.locator("[data-t=preview] svg").is_visible()
    # a double-click gives the default back
    ui.t("side-bar").dblclick()
    ui.t("lower-bar").dblclick()
    ui.flush()
    assert ui.rect(side)["width"] == 400 and "sized" not in page.locator("main").get_attribute("class")
    # on the other tabs there is no lower panel
    ui.tab("prepare")
    assert not lower.is_visible() and not ui.t("lower-bar").is_visible()


def test_figure_area_is_switched_on_and_off(ui, blot_files):
    ui.add_files(*blot_files)
    ui.select_blot(0)
    ui.tab("figure")
    page = ui.page
    card = page.locator("[data-t=card]").first
    height = "WB.figurepanel.build().gels.map((g) => g.box[2] - g.box[0])"
    assert not ui.t("figure-crop").is_checked() and ui.state(height) == [420, 420]
    assert ui.t("tool-figarea").count() == 0 and ui.t("figarea-clear").count() == 0

    ui.t("figure-crop").check()
    ui.flush()
    ui.state("(b.session.figure.crop = [99.5, 49.5, 199.5, 599.5], WB.app.changed('figure'))")
    ui.flush()
    assert ui.state(height) == [100, 420]
    assert card.locator("[data-t=figure-area]").count() == 1 and card.locator("[data-t=figure-area-corner]").count() == 4

    # off: the whole image again; the box stays, grey, and cannot be moved
    ui.t("figure-crop").uncheck()
    ui.flush()
    assert ui.state("[b.session.figure.crop, b.session.figure.crop_on]") == [[99.5, 49.5, 199.5, 599.5], False]
    assert ui.state(height) == [420, 420]
    assert card.locator("[data-t=figure-area]").count() == 0 and card.locator("[data-t=figure-area-corner]").count() == 0
    ghost = card.locator("[data-t=figure-area-off]")
    assert ghost.count() == 1 and ghost.get_attribute("stroke") == "#9a9a9a" and float(ghost.get_attribute("opacity")) < 1
    box, stage = ui.rect(ghost), ui.rect(card.locator(".stage"))
    assert box["height"] == pytest.approx(100 * stage["height"] / 420, abs=1.5)
    ui.drag_on_card(0, (150, 300), (200, 350))
    assert ui.state("b.session.figure.crop") == [99.5, 49.5, 199.5, 599.5]
    # markers are placed over the whole image while it is off
    ui.set("mw-count", 2)
    ui.click("mw-place")
    assert ui.state("b.session.figure.mw_markers.map((m) => m.y)") == pytest.approx([41.5, 377.5])

    # on again: the same area as before
    ui.t("figure-crop").check()
    ui.flush()
    assert ui.state("[b.session.figure.crop, b.session.figure.crop_on]") == [[99.5, 49.5, 199.5, 599.5], True] and ui.state(height) == [100, 420]
    assert card.locator("[data-t=figure-area-off]").count() == 0

    # the same switch for every blot in the list of panels, and one for all of them
    assert [ui.t("panel-crop", i).is_checked() for i in range(2)] == [True, False] and not ui.t("panel-crop-all").is_checked()
    ui.t("panel-crop", 1).check()
    ui.flush()
    assert ui.state("s.blots.map((b) => b.session.figure.crop_on)") == [True, True] and ui.t("panel-crop-all").is_checked()
    assert ui.state("s.blots[1].session.figure.crop") == [41.5, 63.5, 377.5, 575.5] and ui.state(height) == [100, 336]
    assert page.locator("[data-t=card]").nth(1).locator("[data-t=figure-area]").count() == 1
    ui.t("panel-crop-all").uncheck()
    ui.flush()
    assert ui.state("s.blots.map((b) => b.session.figure.crop_on)") == [False, False] and ui.state(height) == [420, 420]
    assert page.locator("[data-t=figure-area-off]").count() == 2 and not ui.t("figure-crop").is_checked()
    ui.t("panel-crop-all").check()
    ui.flush()
    assert ui.state("s.blots.map((b) => [b.session.figure.crop_on, b.session.figure.crop[0]])") == [[True, 99.5], [True, 41.5]]
    ui.t("panel-crop", 0).uncheck()
    ui.flush()
    assert not ui.t("panel-crop-all").is_checked() and not ui.t("figure-crop").is_checked()

    # saved with the folder, the area that is off included
    ui.reopen()
    assert ui.state("s.blots.map((b) => [b.session.figure.crop_on, b.session.figure.crop[0]])") == [[False, 99.5], [True, 41.5]]


def test_valley_to_valley_background_in_the_quantify_tab(quantified):
    ui = quantified
    page = ui.page
    rolling = ui.state("WB.app.results(b).rows")
    borders = ui.state("b.session.lanes.map((l) => l.peaks.map((p) => [p.start, p.end]))")
    ui.choose("bg-method", "valley")
    # the line between the borders has no radius
    assert ui.t("valley-hint").is_visible() and ui.t("bg-radius").is_disabled()
    ui.click("bg-all")
    ui.flush()
    assert ui.state("b.session.lanes.map((l) => l.baseline.method)") == ["valley"] * 8
    # the same peaks, measured above the line between their borders
    assert ui.state("b.session.lanes.map((l) => l.peaks.map((p) => [p.start, p.end]))") == borders
    valley = ui.state("WB.app.results(b).rows")
    expected = ui.state(
        """b.session.lanes.map((l) => { const p = WB.app.curves(b, l).profile;
            return l.peaks.map((k) => { const [a, e] = WB.quant.peakBounds(k, p.length); let s = 0;
                const d = (i) => Math.max(p[i] - (p[a] + (p[e] - p[a]) * (i - a) / (e - a)), 0);
                for (let i = a; i < e; i++) s += 0.5 * (d(i) + d(i + 1));
                return s; }); })"""
    )
    assert np.allclose(valley, expected, rtol=1e-9)
    # close to the rolling ball on this clean blot, but not the same number
    assert np.allclose(valley, rolling, rtol=0.15) and not np.allclose(valley, rolling, rtol=1e-4)
    cells = page.locator("[data-t=results] tr").nth(1).locator("td").all_inner_texts()
    assert [float(c) for c in cells] == pytest.approx(valley[0], rel=1e-4)

    # the border decides: moved inwards, the line rises and the area shrinks
    before = valley[0][0]
    n = ui.state("WB.app.curves(b, b.session.lanes[0]).profile.length")
    start, apex = ui.state("[b.session.lanes[0].peaks[0].start, b.session.lanes[0].peaks[0].apex]")
    ui.drag(ui.on_plot(0, start), ui.on_plot(0, (start + apex) / 2))
    after = ui.state("WB.app.results(b).rows[0][0]")
    assert ui.state("b.session.lanes[0].peaks[0].start") == pytest.approx((start + apex) / 2, abs=2) and after < 0.9 * before
    # detecting again finds the peaks although this background has none without them
    ui.click("detect-all")
    ui.flush()
    assert ui.state("b.session.lanes.map((l) => l.peaks.length)") == [3] * 8
    assert ui.state("WB.app.results(b).rows[0][0]") == pytest.approx(before, rel=1e-9)
    # a double-click adds a peak here too
    ui.state("(b.session.lanes[2].peaks.splice(1, 1), WB.app.changed('quant'))")
    ui.flush()
    page.mouse.dblclick(*ui.on_plot(2, 200))
    ui.flush()
    assert ui.state("b.session.lanes[2].peaks.length") == 3 and ui.state("WB.app.results(b).rows[2][1]") == pytest.approx(valley[2][1], rel=0.02)

    # saved with the folder
    ui.reopen()
    assert ui.state("b.session.lanes[0].baseline.method") == "valley" and ui.state("WB.app.results(b).rows[0][0]") == pytest.approx(before, rel=1e-9)

    # Edit by hand puts the anchors at the ends and at the borders of every peak,
    # where the lines are anchored, not evenly spaced
    ui.tab("quantify")
    lane = ui.state("WB.state.lane")
    rows_before = ui.state("WB.app.results(b).rows")
    expected_x = ui.state(
        f"""(() => {{ const l = b.session.lanes[{lane}], n = WB.app.curves(b, l).profile.length;
            const xs = new Set([0, n - 1]);
            for (const p of l.peaks) for (const i of WB.quant.peakBounds(p, n)) xs.add(i);
            return [...xs].sort((p, q) => p - q); }})()"""
    )
    ui.click("bg-edit")
    ui.flush()
    assert ui.state(f"b.session.lanes[{lane}].baseline.method") == "manual"
    assert ui.state(f"b.session.lanes[{lane}].baseline.anchors.map((a) => a[0])") == expected_x
    # with the same lines under the peaks, the areas stay (unless the profile dips below a line)
    assert ui.state(f"WB.app.results(b).rows[{lane}]") == pytest.approx(rows_before[lane], rel=0.01)


def test_lane_strip_moves_and_tilts_peak_borders(quantified):
    ui = quantified
    page = ui.page
    # under every plot the lane itself, with the borders of its peaks
    assert page.locator("[data-t=lane-strip]").count() == page.locator("svg.plot").count() == 8
    assert page.locator("svg.plot").nth(0).locator("[data-t=strip-border]").count() == 2 * 3
    ui.state("WB.app.select(b.id, 0)")
    ui.flush()
    per_px = ui.on_plot(0, 101)[0] - ui.on_plot(0, 100)[0]  # screen px per profile position

    def centre(locator):
        r = ui.rect(locator)
        return (r["x"] + r["width"] / 2, r["y"] + r["height"] / 2)

    strip = page.locator("svg.plot").nth(0)
    border = lambda side: strip.locator(f"[data-t=strip-border][data-index='0'][data-side={side}]")
    knob = strip.locator("[data-t=strip-tilt][data-index='0']")
    assert strip.locator("[data-t=strip-tilt]").count() == 3  # one knob per peak

    # dragged, a border moves along the lane and stays straight
    start = ui.state("b.session.lanes[0].peaks[0].start")
    x, y = centre(border("start"))
    ui.drag((x, y), (x - 3 * per_px, y))
    ui.flush()
    assert ui.state("b.session.lanes[0].peaks[0].start") == pytest.approx(start - 3, abs=0.6)
    assert "tilt_deg" not in ui.state("b.session.lanes[0].peaks[0]")

    # the knob above the peak turns both borders together, about where they cross the centre line
    straight = ui.state("WB.app.results(b).rows[0][0]")
    start, end = ui.state("[b.session.lanes[0].peaks[0].start, b.session.lanes[0].peaks[0].end]")
    half = ui.state("WB.app.curves(b, b.session.lanes[0]).strip.m") / 2
    x, y = centre(knob)
    ui.drag((x, y), (x + 4 * per_px, y))
    ui.flush()
    # the knob stands 9 px above the 44 px strip, so 9 / 44 of the lane's width beyond its edge
    tilt = ui.state("b.session.lanes[0].peaks[0].tilt_deg")
    assert tilt == pytest.approx(-np.degrees(np.arctan(4 / (half * (1 + 18 / 44)))), abs=1.5)
    assert ui.state("[b.session.lanes[0].peaks[0].start, b.session.lanes[0].peaks[0].end]") == [start, end]
    # both borders are slanted alike, in the strip and on the blot
    slants = [ui.rect(border(side)) for side in ("start", "end")]
    assert slants[0]["width"] == pytest.approx(slants[1]["width"], abs=1) and slants[0]["width"] > 3
    marks = page.locator("[data-t=card] [data-t=peak-mark]")
    for i in (0, 1):  # lane 1, peak 1, start and end
        assert float(marks.nth(i).get_attribute("y1")) != pytest.approx(float(marks.nth(i).get_attribute("y2")), abs=0.5)
    tilted = ui.state("WB.app.results(b).rows[0][0]")
    assert tilted != pytest.approx(straight, rel=1e-6)
    assert float(ui.t("peak-area").inner_text()) == pytest.approx(tilted, rel=1e-4)
    assert strip.locator("[data-t=peak-border-span]").count() == 2

    # a double-click on the knob makes the peak straight again
    page.mouse.dblclick(*centre(knob))
    ui.flush()
    assert "tilt_deg" not in ui.state("b.session.lanes[0].peaks[0]")
    assert ui.state("WB.app.results(b).rows[0][0]") == pytest.approx(straight, rel=1e-12)
    assert ui.state("b.session.lanes[0].peaks.length") == 3  # and no peak was added

    # "To all" takes the tilt along; it is saved with the folder
    ui.state("(b.session.lanes[0].peaks[0].tilt_deg = 12, WB.app.changed('quant'))")
    ui.flush()
    ui.t("peak-to-all").click()
    ui.flush()
    assert ui.state("b.session.lanes.map((l) => l.peaks.find((p) => p.band_id === 1).tilt_deg)") == [12] * 8
    ui.reopen()
    assert ui.state("b.session.lanes[3].peaks.find((p) => p.band_id === 1).tilt_deg") == 12

    # a blot saved when each border had a tilt of its own reads as one tilt, their mean
    ui.page.evaluate(
        """async () => {
            const path = [WB.state.folder.dir, WB.app.blot().disk.dir, "blot.json"];
            const doc = JSON.parse(await WB.tree.readText(path));
            const p = doc.lanes[2].peaks[0];
            delete p.tilt_deg;
            Object.assign(p, { start_tilt_deg: 10, end_tilt_deg: 5 });
            await WB.tree.store.write(path, new TextEncoder().encode(JSON.stringify(doc)));
            await WB.library.open(WB.state.folder.dir);
        }"""
    )
    ui.flush()
    old = ui.state("b.session.lanes[2].peaks.find((p) => p.band_id === 1)")
    assert old["tilt_deg"] == 7.5 and "start_tilt_deg" not in old and "end_tilt_deg" not in old


def expected_level(box, image):
    """For total protein: the mean of the pixels inside a drawn box (pixel edges at .5), as the page takes it."""
    y0, x0, y1, x1 = (math.floor(v + 1) for v in box)  # whole pixels, halves up (Math.round)
    return float(image[min(y0, y1):max(y0, y1), min(x0, x1):max(x0, x1)].astype(np.float64).mean())


def background_lines(ui):
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
    assert background_lines(ui) == [["linear", True, [pytest.approx(level, rel=1e-9)] * 2]] * 8
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
    assert background_lines(ui)[2][:2] == ["linear", False] and "set by hand" in ui.t("bg-area-level").inner_text()
    ui.state("(WB.app.select(b.id, 0), 0)")
    ui.flush()
    ui.click("bg-all")
    ui.flush()
    assert all(line[1] for line in background_lines(ui)) and len({tuple(line[2]) for line in background_lines(ui)}) == 1
    # lanes found again take it too
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.tab("quantify")
    assert all(line[:2] == ["linear", True] for line in background_lines(ui))

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
    assert ui.state("b.bgArea") is None and background_lines(ui)[0][:2] == ["linear", False]
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


def test_lane_position_and_tilt_are_adjusted_in_the_quantify_tab(quantified):
    ui = quantified
    page = ui.page
    card = page.locator("[data-t=card]").first
    ui.state("(WB.app.select(b.id, 2), 0)")
    ui.flush()
    # the current lane has its handles here as on the Lanes tab
    for name in ("handle-lane-tilt", "handle-lane-top", "handle-lane-bottom", "handle-lane-width"):
        assert card.locator(f"[data-t={name}]").count() == 1
    lane = ui.state("b.session.lanes[2]")
    profile = ui.state("Array.from(WB.app.curves(b, b.session.lanes[2]).profile)")
    shown = page.locator("svg.plot").nth(2).locator("[data-t=profile]").get_attribute("d")
    assert float(ui.t("lane-x").input_value()) == pytest.approx(lane["x_center"], abs=0.06) and ui.t("quantify-tilt").input_value() == "0"

    # tilt with the knob above the lane: the lane is measured along its new direction
    knob = ui.rect(card.locator("[data-t=handle-lane-tilt]"))
    start = [knob["x"] + knob["width"] / 2, knob["y"] + knob["height"] / 2]
    ui.drag(start, [start[0] + 25, start[1]])
    tilt = ui.state("b.session.lanes[2].tilt_deg")
    assert tilt < -2 and float(ui.t("quantify-tilt").input_value()) == pytest.approx(tilt, abs=0.06)
    tilted = ui.state("Array.from(WB.app.curves(b, b.session.lanes[2]).profile)")
    assert not np.allclose(tilted, profile) and page.locator("svg.plot").nth(2).locator("[data-t=profile]").get_attribute("d") != shown
    assert page.locator("svg.plot").count() == 8 and ui.state("b.session.lanes[2].peaks.length") == 3
    # and by number
    ui.set("quantify-tilt", 0)
    assert ui.state("b.session.lanes[2].tilt_deg") == 0
    assert np.allclose(ui.state("Array.from(WB.app.curves(b, b.session.lanes[2]).profile)"), profile)

    # move: by dragging the lane on the blot, and by number
    y = (lane["y0"] + lane["y1"]) / 2
    ui.drag_on_card(0, (y, lane["x_center"]), (y, lane["x_center"] + 12))
    assert ui.state("[b.session.lanes[2].x_center, b.session.lanes[2].y0]") == pytest.approx([lane["x_center"] + 12, lane["y0"]], abs=2)
    moved = ui.state("WB.app.results(b).rows[2]")
    ui.set("lane-x", round(lane["x_center"], 1))
    assert ui.state("b.session.lanes[2].x_center") == pytest.approx(lane["x_center"], abs=0.06)
    back = ui.state("WB.app.results(b).rows[2]")
    assert back != moved and float(page.locator("[data-t=results] tr").nth(3).locator("td").first.inner_text()) == pytest.approx(back[0], rel=1e-4)
    # a lane moved past its neighbour keeps being the current one, under its new number
    ui.set("lane-x", lane["x_center"] + 100)
    assert ui.state("s.lane") == 3 and ui.t("current-lane").input_value() == "4"
    assert ui.state("b.session.lanes.map((l) => l.x_center)") == sorted(ui.state("b.session.lanes.map((l) => l.x_center)"))


def test_straightening_keeps_the_crop(ui, tmp_path):
    # a band that runs slightly uphill, and a bright dot to recognise a place by
    yy, xx = np.mgrid[:300, :500].astype(float)
    img = 1000 * np.exp(-0.5 * ((yy - (150 + 0.08 * (xx - 250))) / 3) ** 2) + 3000 * np.exp(-0.5 * (((yy - 100) / 2) ** 2 + ((xx - 300) / 2) ** 2))
    path = tmp_path / "tilted.tif"
    tifffile.imwrite(path, img.astype(np.uint16))
    ui.add_files(path)
    ui.state("(WB.app.setCrop(b, [60, 150, 220, 420]), b.session.lanes = [{ x_center: 100, y0: 9.5, y1: 139.5, width: 30, tilt_deg: 0, baseline: WB.model.baseline(), peaks: [] }], WB.app.changed('lanes'))")
    ui.flush()
    brightest = """(() => { const { w, data } = b.work.wb; let best = 0; for (let i = 0; i < data.length; i++) if (data[i] > data[best]) best = i; return [Math.floor(best / w), best % w]; })()"""
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == [270, 160] and ui.state(brightest) == [40, 150]

    ui.click("tool-level")
    ui.flush()
    ui.drag_on_card(0, (90 - 0.08 * 100, 35), (90 + 0.08 * 100, 235))  # along the band, in the cropped image
    ui.click("level-apply")
    ui.flush()
    angle = ui.state("b.session.transform.rotation_deg")
    assert angle == pytest.approx(np.degrees(np.arctan(0.08)), abs=0.4)
    # still cropped, to the same size, around the same place
    crop = ui.state("b.session.transform.crop")
    assert crop is not None and [crop[3] - crop[1], crop[2] - crop[0]] == [270, 160] == ui.state("[b.work.wb.w, b.work.wb.h]")
    spot = ui.state(brightest)
    assert spot == pytest.approx([40, 150], abs=5)  # 12 px from the middle of the crop, turned by 4.6 degrees
    # the band is level now, inside the crop
    ridge = ui.state(
        """(() => { const { w, h, data } = b.work.wb; const out = [];
            for (let x = 20; x < 130; x += 10) { let best = 0; for (let y = 60; y < h; y++) if (data[y * w + x] > data[best * w + x]) best = y; out.push(best); }
            return out; })()"""
    )
    assert max(ridge) - min(ridge) <= 2
    # lanes stay where they were in the cropped image
    assert ui.state("[b.session.lanes[0].x_center, b.session.lanes[0].y0]") == [100, 9.5]
    assert "cropped" in ui.page.locator("[data-t=dim]").inner_text()

    # reset the crop: the whole straightened image, the dot where the turn puts it
    ui.click("crop-reset")
    ui.flush()
    assert ui.state("b.session.transform.crop") is None
    whole = ui.state(brightest)
    assert [whole[0] - crop[0], whole[1] - crop[1]] == spot
    # setting the angle by number still resets the crop
    ui.state("(WB.app.setCrop(b, [60, 150, 220, 420]), 0)")
    ui.set("angle", 2)
    assert ui.state("b.session.transform.crop") is None

    # straightening back at the edge: the crop is moved inside the image rather than cut
    ui.state("(WB.app.setRotation(b, 10), WB.app.setCrop(b, [0, 0, 100, 120]), WB.app.setRotation(b, 0, true), 0)")
    ui.flush()
    crop = ui.state("b.session.transform.crop")
    assert ui.state("[b.work.wb.w, b.work.wb.h]") == [120, 100] and crop[0] >= 0 and crop[1] >= 0 and crop[2] <= 300 and crop[3] <= 500
    # the two directions of the point mapping are each other's inverse, and agree with the rotated picture
    back = ui.state("WB.processing.fromRotated(500, 300, 7.5, WB.processing.toRotated(500, 300, 7.5, [100, 300]))")
    assert back == pytest.approx([100, 300], abs=1e-9)
    assert ui.state("(() => { const s = WB.processing.rotatedSize(500, 300, 7.5), r = WB.processing.rotate({ w: 500, h: 300, data: new Float32Array(150000) }, 7.5); return [s.w === r.w, s.h === r.h]; })()") == [True, True]
