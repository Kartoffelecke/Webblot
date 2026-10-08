"""The JavaScript core must give the same numbers as napari-blot's Python core."""

import base64

import numpy as np
import pytest
import tifffile
from conftest import call
from scipy import ndimage as ndi
from scipy.signal import find_peaks

from napari_blot import lanes, processing, quant
from napari_blot.model import Baseline, Lane, Peak, Transform


def js_lane(lane):
    return {
        "x_center": lane.x_center,
        "y0": lane.y0,
        "y1": lane.y1,
        "width": lane.width,
        "tilt_deg": lane.tilt_deg,
        "baseline": js_baseline(lane.baseline),
        "peaks": [],
    }


def js_baseline(b):
    return {
        "method": b.method,
        "radius": b.radius,
        "linear_ends": list(b.linear_ends) if b.linear_ends else None,
        "anchors": [list(a) for a in b.anchors],
    }


def test_python_rounding(app):
    values = [0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001, 7.0, -2.5]
    assert app.evaluate("(v) => v.map(WB.num.round)", values) == [round(v) for v in values]


def test_format_g(app):
    values = [0, 1, 123456.7, 1234567.8, 0.000012345, 0.00012345, 130520.4, 1.5e-7, 99999.95, 2.5]
    assert app.evaluate("(v) => v.map((x) => WB.num.formatG(x))", values) == [f"{v:.6g}" for v in values]


def test_filters_match_scipy(app):
    rng = np.random.default_rng(0)
    a = rng.normal(size=300).cumsum()
    for sigma, mode in ((1.0, "nearest"), (1.5, "nearest"), (6.7, "reflect"), (40.0, "reflect")):
        got = app.evaluate("([a, s, m]) => Array.from(WB.num.gaussian1d(a, s, m))", [a.tolist(), sigma, mode])
        assert np.allclose(got, ndi.gaussian_filter1d(a, sigma, mode=mode), atol=1e-9)
    for size in (3, 26, 81, 304, 601):
        got = app.evaluate("([a, s]) => Array.from(WB.num.greyOpening(a, s))", [a.tolist(), size])
        assert np.allclose(got, ndi.grey_opening(a, size=size, mode="nearest"))
        got = app.evaluate("([a, s]) => Array.from(WB.num.uniformFilter(a, s))", [a.tolist(), size])
        assert np.allclose(got, ndi.uniform_filter1d(a, size=size, mode="nearest"), atol=1e-9)


def test_find_peaks_matches_scipy(app):
    rng = np.random.default_rng(1)
    for trial in range(6):
        a = ndi.gaussian_filter1d(rng.normal(size=400), 3).round(3 if trial % 2 else 12)
        span = float(np.ptp(a))
        for options in (
            {"prominence": 0.05 * span},
            {"prominence": 0.1 * span, "width": 3},
            {"prominence": 0.08 * span, "distance": 17.3},
            {"distance": 40},
        ):
            idx, props = find_peaks(a, **options)
            got = app.evaluate("([a, o]) => WB.num.findPeaks(a, o)", [a.tolist(), options])
            assert got["peaks"] == idx.tolist(), (trial, options)
            if "prominence" in options:
                assert np.allclose(got["prominences"], props["prominences"])


def test_percentile_and_median(app, blot):
    img = blot["img"]
    lo, hi = call(app, "(img) => WB.processing.autoContrast(img)", img)
    assert (lo, hi) == pytest.approx(processing.auto_contrast(img), rel=1e-6)
    assert call(app, "(img) => WB.num.median(img.data)", img) == pytest.approx(float(np.median(img)))


@pytest.mark.parametrize("byteorder", ["<", ">"])
def test_tiff_decoding_is_pixel_identical(app, blot, tmp_path, byteorder):
    path = tmp_path / "blot.tif"
    tifffile.imwrite(path, blot["wb"], byteorder=byteorder)
    encoded = base64.b64encode(path.read_bytes()).decode()
    got = app.evaluate(
        """(b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const img = WB.imageio.decodeTiff(bytes.buffer);
            return [img.w, img.h, Array.from(img.data)];
        }""",
        encoded,
    )
    assert got[:2] == [640, 420]
    assert np.array_equal(np.array(got[2]).reshape(420, 640), blot["wb"])


def test_real_chemidoc_tiff_decodes_identically(app, real_blot):
    expected = tifffile.imread(real_blot)
    encoded = base64.b64encode(real_blot.read_bytes()).decode()
    got = app.evaluate(
        """(b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const img = WB.imageio.decodeTiff(bytes.buffer);
            return [img.w, img.h, Array.from(img.data)];
        }""",
        encoded,
    )
    assert np.array_equal(np.array(got[2]).reshape(got[1], got[0]), expected)


def test_rgb_tiff_is_averaged(app, tmp_path):
    rgb = np.random.default_rng(0).integers(0, 255, (20, 30, 3), dtype=np.uint8)
    path = tmp_path / "rgb.tif"
    tifffile.imwrite(path, rgb, photometric="rgb")
    encoded = base64.b64encode(path.read_bytes()).decode()
    got = app.evaluate(
        "(b64) => Array.from(WB.imageio.decodeTiff(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer).data)",
        encoded,
    )
    assert np.allclose(np.array(got).reshape(20, 30), rgb.astype(np.float32).mean(axis=-1), atol=1e-4)


def test_project_image_packing_roundtrip(app, blot):
    img = blot["img"]
    back = call(app, "(img) => { const p = WB.imageio.pack(img); return [p.dtype, Array.from(WB.imageio.unpack(p).data)]; }", img)
    assert back[0] == "uint16" and np.array_equal(np.array(back[1], dtype=np.float32), img.ravel())
    frac = img[:20, :20] + 0.25
    back = call(app, "(img) => { const p = WB.imageio.pack(img); return [p.dtype, Array.from(WB.imageio.unpack(p).data)]; }", frac)
    assert back[0] == "float32" and np.array_equal(np.array(back[1], dtype=np.float32), frac.ravel())


@pytest.mark.parametrize("angle", [0, 90, 180, 270, -90, 7.5, -3.2, 33.0, 181.7])
def test_rotation(app, blot, angle):
    img = blot["img"][:150, :220]
    expected = processing.rotate(img, angle)
    w, h, data = call(app, "(img, a) => { const r = WB.processing.rotate(img, a); return [r.w, r.h, Array.from(r.data)]; }", img, args=angle)
    assert (h, w) == expected.shape
    assert np.allclose(np.array(data).reshape(h, w), expected, rtol=1e-4, atol=0.05)


def test_apply_transform_and_crop_rounding(app, blot):
    img = blot["img"][:150, :220]
    for crop in ((10, 20, 100, 200), (10.5, 20.5, 99.5, 180.5), (-5, -5, 500, 500), (50, 60, 51, 200)):
        t = Transform(rotation_deg=4.0, crop=crop)
        expected = processing.apply_transform(img, t)
        w, h, data = call(
            app,
            "(img, t) => { const r = WB.processing.applyTransform(img, t); return [r.w, r.h, Array.from(r.data)]; }",
            img,
            args={"rotation_deg": 4.0, "crop": list(crop)},
        )
        assert (h, w) == expected.shape
        assert np.allclose(np.array(data).reshape(h, w), expected, rtol=1e-4, atol=0.05)


def test_leveling_angle(app):
    cases = [((150, 50), (190, 450)), ((190, 450), (150, 50)), ((0, 100), (400, 107)), ((0, 0), (0, 10)), ((10, 10), (60, 50))]
    for start, end in cases:
        got = app.evaluate("([a, b]) => WB.processing.levelingAngle(a, b)", [list(start), list(end)])
        assert got == pytest.approx(processing.leveling_angle(start, end), abs=1e-9)


def test_signal_image(app, blot):
    img = blot["img"][:50, :60]
    got = call(app, "(img) => Array.from(WB.processing.signalImage(img, true).data)", img)
    assert np.allclose(got, processing.signal_image(img, True).ravel())


@pytest.mark.parametrize("tilt", [0.0, 5.0, -8.5])
def test_lane_profile(app, blot, tilt):
    img = blot["img"]
    lane = Lane(x_center=float(blot["centers"][3]) + 0.3, y0=20.5, y1=400.2, width=41.6, tilt_deg=tilt)
    expected = lanes.extract_profile(img, lane)
    got = call(app, "(img, lane) => Array.from(WB.lanes.extractProfile(img, lane))", img, args=js_lane(lane))
    assert len(got) == len(expected)
    assert np.allclose(got, expected, rtol=2e-5)
    poly = app.evaluate("(lane) => WB.lanes.polygon(lane)", js_lane(lane))
    assert np.allclose(poly, lanes.lane_polygon(lane))


def lane_centers(found):
    return [ln.x_center for ln in found]


def js_detect(app, img, **options):
    return call(app, "(img, o) => WB.lanes.detect(img, o)", img, args=options)


def test_lane_detection(app, blot):
    img = blot["img"]
    cases = [
        ({}, {}),
        ({"n_lanes": 8}, {"nLanes": 8}),
        ({"n_lanes": 5}, {"nLanes": 5}),
        ({"n_lanes": 8, "roi": (30.2, 40.7, 390.0, 610.0), "width_frac": 0.6}, {"nLanes": 8, "roi": [30.2, 40.7, 390.0, 610.0], "widthFrac": 0.6}),
        ({"n_lanes": 7, "method": "even", "roi": (10, 100, 90, 660)}, {"nLanes": 7, "method": "even", "roi": [10, 100, 90, 660]}),
    ]
    for py, js in cases:
        expected = lanes.detect_lanes(img, **py)
        got = js_detect(app, img, **js)
        assert [g["x_center"] for g in got] == pytest.approx(lane_centers(expected), abs=1e-6), py
        assert [(g["y0"], g["y1"]) for g in got] == [(ln.y0, ln.y1) for ln in expected]
        assert [g["width"] for g in got] == pytest.approx([ln.width for ln in expected])


def test_lane_detection_on_uneven_blots(app, blot):
    # two lanes blanked out: peak finding sees six, the grid fit must give eight
    img = blot["img"].copy()
    c = blot["centers"]
    for cx in (c[2], c[5]):
        img[:, int(cx - 35) : int(cx + 35)] = np.median(img)
    assert [g["x_center"] for g in js_detect(app, img, nLanes=8)] == pytest.approx(
        lane_centers(lanes.detect_lanes(img, n_lanes=8)), abs=1e-6
    )
    # strong signal only on the left, a smear and a blob
    rng = np.random.default_rng(1)
    img = rng.normal(0, 0.02, (300, 700))
    for i, amp in enumerate([1.0, 0.9, 1.0, 0.8, 0.05, 0.03, 0.04]):
        cx = int((i + 0.5) * 100)
        img[100:115, cx - 30 : cx + 30] += amp
    img[180:200, 20:330] += 0.6
    img[40:60, 60:90] += 1.5
    img = img.astype(np.float32)
    got = [g["x_center"] for g in js_detect(app, img, nLanes=7)]
    assert got == pytest.approx(lane_centers(lanes.detect_lanes(img, n_lanes=7)), abs=1e-6)
    assert got[-1] - got[0] >= 0.85 * 600


def test_lane_detection_on_the_real_blot(app, real_blot):
    img = tifffile.imread(real_blot).astype(np.float32)
    for roi in ((100, 205, 600, 925), (80, 190, 700, 960), (120, 205, 200, 925)):
        expected = lane_centers(lanes.detect_lanes(img, n_lanes=7, roi=roi))
        got = [g["x_center"] for g in js_detect(app, img, nLanes=7, roi=list(roi))]
        assert got == pytest.approx(expected, abs=1e-6), roi


def test_smile(app):
    py = [Lane(x, 0, 100, 10) for x in (10, 50, 70, 130)]
    lanes.apply_smile(py, 6.0)
    got = app.evaluate("(l) => { WB.lanes.applySmile(l, 6); return l.map((x) => x.tilt_deg); }", [js_lane(Lane(x, 0, 100, 10)) for x in (10, 50, 70, 130)])
    assert got == pytest.approx([ln.tilt_deg for ln in py])


def profiles(blot_img, centers):
    out = []
    for cx in centers:
        out.append(lanes.extract_profile(blot_img, Lane(float(cx), -0.5, blot_img.shape[0] - 0.5, 40)))
    return out


BASELINES = [
    Baseline("none"),
    Baseline("rolling", radius=40),
    Baseline("rolling", radius=12.6),
    Baseline("rolling", radius=400),
    Baseline("linear"),
    Baseline("linear", linear_ends=(3000.0, 9000.0)),
    Baseline("manual", anchors=[(300.0, 9000.0), (0.0, 4000.0), (120.0, 5000.0)]),
]


@pytest.mark.parametrize("baseline", BASELINES, ids=lambda b: f"{b.method}-{b.radius}-{b.linear_ends}")
def test_baselines(app, blot, baseline):
    rng = np.random.default_rng(3)
    x = np.arange(500.0)
    flat = 100 + rng.normal(0, 0.5, 500)
    cut = flat + 400 * np.exp(-0.5 * ((x - 498) / 6) ** 2) + 300 * np.exp(-0.5 * ((x - 15) / 5) ** 2)
    curves = profiles(blot["img"], blot["centers"][:3]) + [cut, flat + 0.3 * x, flat[:30]]
    for profile in curves:
        expected = quant.compute_baseline(np.asarray(profile, float), baseline)
        got = app.evaluate(
            "([p, b]) => Array.from(WB.quant.computeBaseline(Float64Array.from(p), b))",
            [np.asarray(profile, float).tolist(), js_baseline(baseline)],
        )
        assert np.allclose(got, expected, rtol=1e-9, atol=1e-7)


def test_baseline_to_anchors_and_linear_ends(app, blot):
    profile = profiles(blot["img"], blot["centers"][:1])[0].astype(float)
    base = quant.compute_baseline(profile, Baseline("rolling"))
    got = app.evaluate("(c) => WB.quant.baselineToAnchors(c)", base.tolist())
    assert [tuple(a) for a in got] == pytest.approx(quant.baseline_to_anchors(base))
    assert app.evaluate("(p) => WB.quant.linearEnds(p)", profile.tolist()) == pytest.approx(quant.linear_ends(profile))


def js_peaks(peaks):
    return [(p["start"], p["end"], p["apex"]) for p in peaks]


def test_peak_detection_and_areas(app, blot):
    img = blot["img"]
    found = lanes.detect_lanes(img, n_lanes=8)
    all_profiles, all_bases, all_peaks = [], [], []
    for lane in found:
        profile = lanes.extract_profile(img, lane).astype(float)
        base = quant.compute_baseline(profile, lane.baseline)
        for prominence in (0.05, 0.2, 0.005):
            expected = quant.detect_peaks(profile, base, prominence=prominence)
            got = app.evaluate(
                "([p, b, prom]) => WB.quant.detectPeaks(p, b, { prominence: prom })",
                [profile.tolist(), base.tolist(), prominence],
            )
            assert js_peaks(got) == [(p.start, p.end, p.apex) for p in expected]
        lane.peaks = quant.detect_peaks(profile, base)
        quant.number_peaks(lane)
        areas = app.evaluate(
            "([p, b, peaks]) => peaks.map((k) => WB.quant.peakArea(p, b, k))",
            [profile.tolist(), base.tolist(), [{"start": p.start, "end": p.end} for p in lane.peaks]],
        )
        assert areas == pytest.approx([quant.peak_area(profile, base, p) for p in lane.peaks], rel=1e-9)
        all_profiles.append(profile)
        all_bases.append(base)

    found[0].peaks[1].quantify = False
    del found[1].peaks[0]
    found[2].peaks[0].band_id = 7
    bands, rows = quant.results_table(found, all_profiles, all_bases)
    payload = [
        [
            {**js_lane(lane), "peaks": [{"start": p.start, "end": p.end, "apex": p.apex, "band_id": p.band_id, "quantify": p.quantify} for p in lane.peaks]}
            for lane in found
        ],
        [p.tolist() for p in all_profiles],
        [b.tolist() for b in all_bases],
    ]
    got = app.evaluate("([l, p, b]) => WB.quant.resultsTable(l, p, b)", payload)
    assert got["bands"] == bands
    for got_row, row in zip(got["rows"], rows):
        assert [v is None for v in got_row] == [v is None for v in row]
        assert [v for v in got_row if v is not None] == pytest.approx([v for v in row if v is not None], rel=1e-9)
    csv = app.evaluate("([l, p, b]) => { const t = WB.quant.resultsTable(l, p, b); return WB.quant.tableToCsv(t.bands, t.rows); }", payload)
    assert csv == quant.table_to_csv(bands, rows)


def test_whole_pipeline_from_the_image(app, blot):
    """From pixels to areas entirely in JavaScript, against entirely in Python."""
    img = blot["img"]
    found = lanes.detect_lanes(img, n_lanes=8)
    expected = []
    for lane in found:
        profile = lanes.extract_profile(img, lane)
        base = quant.compute_baseline(profile, lane.baseline)
        expected.append([quant.peak_area(profile, base, p) for p in quant.detect_peaks(profile, base)])
    got = call(
        app,
        """(img) => WB.lanes.detect(img, { nLanes: 8 }).map((lane) => {
            const profile = WB.lanes.extractProfile(img, lane);
            const base = WB.quant.computeBaseline(profile, lane.baseline);
            return WB.quant.detectPeaks(profile, base).map((p) => WB.quant.peakArea(profile, base, p));
        })""",
        img,
    )
    assert [len(g) for g in got] == [3] * 8
    assert np.allclose(got, expected, rtol=1e-3)


def test_peak_at(app):
    x = np.arange(400.0)
    wide = 100 * np.exp(-0.5 * ((x - 120) / 15) ** 2)
    pair = 80 * np.exp(-0.5 * ((x - 280) / 8) ** 2) + 60 * np.exp(-0.5 * ((x - 310) / 8) ** 2)
    base = 0.1 * x + 20
    profile = wide + pair + base
    cases = [
        (126, {}, {}),
        (280, {}, {}),
        (310, {}, {}),
        (120, {"limits": (110, 400)}, {"limits": [110, 400]}),
        (120.5, {"search": 3.5}, {"search": 3.5}),
        (200, {}, {}),
        (5, {"limits": (0, 6.5)}, {"limits": [0, 6.5]}),
    ]
    for position, py, js in cases:
        expected = quant.peak_at(profile, base, position, **py)
        got = app.evaluate("([p, b, x, o]) => WB.quant.peakAt(p, b, x, o)", [profile.tolist(), base.tolist(), position, js])
        if expected is None:
            assert got is None
        else:
            assert (got["start"], got["end"], got["apex"]) == (expected.start, expected.end, expected.apex)
    assert app.evaluate("([p, b]) => WB.quant.peakAt(p.map((v) => v - 1), p, 200)", [base.tolist(), base.tolist()]) is None


def test_peak_numbering(app):
    def lane(peaks):
        return {**js_lane(Lane(10, 0, 100, 8)), "peaks": peaks}

    peaks = [{"start": 60, "end": 70, "apex": 65, "band_id": 0, "quantify": True}, {"start": 10, "end": 20, "apex": 15, "band_id": 0, "quantify": True}]
    got = app.evaluate("(l) => { WB.quant.numberPeaks(l); return [l.peaks.map((p) => [p.apex, p.band_id]), WB.quant.isNumberedInOrder(l)]; }", lane(peaks))
    assert got == [[[15, 1], [65, 2]], True]
    assert app.evaluate("(l) => WB.quant.isNumberedInOrder(l)", lane([{**peaks[0], "band_id": 7}])) is False
