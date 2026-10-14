"""The core must give the right numbers: those of numpy / scipy, and the recorded reference values."""

import base64

import numpy as np
import pytest
import tifffile
from conftest import call, checked
from scipy import ndimage as ndi
from scipy.signal import find_peaks


def lane(x_center, y0, y1, width, tilt_deg=0.0, baseline=None, peaks=()):
    return {
        "x_center": x_center,
        "y0": y0,
        "y1": y1,
        "width": width,
        "tilt_deg": tilt_deg,
        "baseline": baseline or make_baseline(),
        "peaks": list(peaks),
    }


def make_baseline(method="rolling", radius=40.0, linear_ends=None, anchors=()):
    return {"method": method, "radius": radius, "linear_ends": linear_ends, "anchors": [list(a) for a in anchors]}


def peak(start, end, apex, band_id=0, quantify=True):
    return {"start": start, "end": end, "apex": apex, "band_id": band_id, "quantify": quantify}


def test_rounding_half_to_even(app):
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
    assert (lo, hi) == pytest.approx(np.percentile(img, [0.5, 99.8]).tolist(), rel=1e-6)
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


def scipy_rotate(image, angle_deg):
    """Rotation with the canvas enlarged and the corners filled with the median."""
    angle = float(angle_deg) % 360.0
    if angle == 0:
        return image
    if angle % 90 == 0:
        return np.rot90(image, int(angle // 90))
    return ndi.rotate(image, angle, reshape=True, order=1, mode="constant", cval=float(np.median(image)))


@pytest.mark.parametrize("angle", [0, 90, 180, 270, -90, 7.5, -3.2, 33.0, 181.7])
def test_rotation_matches_scipy(app, blot, angle):
    img = blot["img"][:150, :220]
    expected = scipy_rotate(img, angle)
    w, h, data = call(app, "(img, a) => { const r = WB.processing.rotate(img, a); return [r.w, r.h, Array.from(r.data)]; }", img, args=angle)
    assert (h, w) == expected.shape
    assert np.allclose(np.array(data).reshape(h, w), expected, rtol=1e-4, atol=0.05)


def test_apply_transform_and_crop_rounding(app, blot):
    img = blot["img"][:150, :220]
    rotated = scipy_rotate(img, 4.0)
    # the crop box [y0, x0, y1, x1] is rounded (halves to even) and clipped to
    # the image; a box that leaves less than 2 px is ignored
    cases = [
        ((10, 20, 100, 200), rotated[10:100, 20:200]),
        ((10.5, 20.5, 99.5, 180.5), rotated[10:100, 20:180]),
        ((-5, -5, 500, 500), rotated),
        ((50, 60, 51, 200), rotated),
    ]
    for crop, expected in cases:
        w, h, data = call(
            app,
            "(img, t) => { const r = WB.processing.applyTransform(img, t); return [r.w, r.h, Array.from(r.data)]; }",
            img,
            args={"rotation_deg": 4.0, "crop": list(crop)},
        )
        assert (h, w) == expected.shape, crop
        assert np.allclose(np.array(data).reshape(h, w), expected, rtol=1e-4, atol=0.05)


def test_leveling_angle(app):
    # the line is turned to whichever is nearer, horizontal or vertical
    cases = [((150, 50), (190, 450)), ((190, 450), (150, 50)), ((0, 100), (400, 107)), ((0, 0), (0, 10)), ((10, 10), (60, 50))]
    for start, end in cases:
        got = app.evaluate("([a, b]) => WB.processing.levelingAngle(a, b)", [list(start), list(end)])
        angle = np.degrees(np.arctan2(end[0] - start[0], end[1] - start[1]))
        assert got == pytest.approx(float((angle + 45.0) % 90.0 - 45.0), abs=1e-9)


def test_signal_image(app, blot):
    img = blot["img"][:50, :60]
    got = call(app, "(img) => Array.from(WB.processing.signalImage(img, true).data)", img)
    assert np.allclose(got, (float(img.max()) - img).ravel())


@pytest.mark.parametrize("case, tilt", [(0, 0.0), (1, 5.0), (2, -8.5)])
def test_lane_profile(app, blot, ref, case, tilt):
    img = blot["img"]
    tilted = lane(x_center=float(blot["centers"][3]) + 0.3, y0=20.5, y1=400.2, width=41.6, tilt_deg=tilt)
    expected = ref[f"lane_profile_{case}"]
    got = call(app, "(img, lane) => Array.from(WB.lanes.extractProfile(img, lane))", img, args=tilted)
    assert len(got) == len(expected)
    assert np.allclose(got, expected, rtol=2e-5)
    poly = app.evaluate("(lane) => WB.lanes.polygon(lane)", tilted)
    assert np.allclose(poly, ref["lane_polygon"][case])


def js_detect(app, img, **options):
    return call(app, "(img, o) => WB.lanes.detect(img, o)", img, args=options)


def test_lane_detection(app, blot, ref):
    img = blot["img"]
    cases = [
        {},
        {"nLanes": 8},
        {"nLanes": 5},
        {"nLanes": 8, "roi": [30.2, 40.7, 390.0, 610.0], "widthFrac": 0.6},
        {"nLanes": 7, "method": "even", "roi": [10, 100, 90, 660]},
    ]
    for options, expected in zip(cases, ref["lane_detection"], strict=True):
        got = js_detect(app, img, **options)
        assert [g["x_center"] for g in got] == pytest.approx(expected["centers"], abs=1e-6), options
        assert [[g["y0"], g["y1"]] for g in got] == expected["ends"]
        assert [g["width"] for g in got] == pytest.approx(expected["widths"])


def test_lane_detection_on_uneven_blots(app, blot, ref):
    # two lanes blanked out: peak finding sees six, the grid fit must give eight
    img = blot["img"].copy()
    c = blot["centers"]
    for cx in (c[2], c[5]):
        img[:, int(cx - 35) : int(cx + 35)] = np.median(img)
    assert [g["x_center"] for g in js_detect(app, img, nLanes=8)] == pytest.approx(ref["lane_detection_blanked"], abs=1e-6)
    # strong signal only on the left, a smear and a blob
    rng = np.random.default_rng(1)
    img = rng.normal(0, 0.02, (300, 700))
    for i, amp in enumerate([1.0, 0.9, 1.0, 0.8, 0.05, 0.03, 0.04]):
        cx = int((i + 0.5) * 100)
        img[100:115, cx - 30 : cx + 30] += amp
    img[180:200, 20:330] += 0.6
    img[40:60, 60:90] += 1.5
    img = checked(img.astype(np.float32), ref["fingerprint"]["left_heavy"])
    got = [g["x_center"] for g in js_detect(app, img, nLanes=7)]
    assert got == pytest.approx(ref["lane_detection_left_heavy"], abs=1e-6)
    assert got[-1] - got[0] >= 0.85 * 600


def test_lane_detection_on_the_real_blot(app, real_blot, ref):
    img = tifffile.imread(real_blot).astype(np.float32)
    rois = ((100, 205, 600, 925), (80, 190, 700, 960), (120, 205, 200, 925))
    for roi, expected in zip(rois, ref["lane_detection_real"], strict=True):
        got = [g["x_center"] for g in js_detect(app, img, nLanes=7, roi=list(roi))]
        assert got == pytest.approx(expected, abs=1e-6), roi


def test_smile(app, ref):
    got = app.evaluate("(l) => { WB.lanes.applySmile(l, 6); return l.map((x) => x.tilt_deg); }", [lane(x, 0, 100, 10) for x in (10, 50, 70, 130)])
    assert got == pytest.approx(ref["smile"])


BASELINES = [
    make_baseline("none"),
    make_baseline("rolling", radius=40),
    make_baseline("rolling", radius=12.6),
    make_baseline("rolling", radius=400),
    make_baseline("linear"),
    make_baseline("linear", linear_ends=[3000.0, 9000.0]),
    make_baseline("manual", anchors=[(300.0, 9000.0), (0.0, 4000.0), (120.0, 5000.0)]),
]

# The profiles the baselines are computed for (curve_0 ... curve_5 of the
# reference): three lanes of the synthetic blot, a flat profile with a band cut
# off at each end, a flat profile on a slope, and one of only 30 samples.
N_CURVES = 6


@pytest.mark.parametrize("case", range(len(BASELINES)), ids=lambda i: f"{BASELINES[i]['method']}-{BASELINES[i]['radius']}-{BASELINES[i]['linear_ends']}")
def test_baselines(app, ref, case):
    for curve in range(N_CURVES):
        got = app.evaluate(
            "([p, b]) => Array.from(WB.quant.computeBaseline(Float64Array.from(p), b))",
            [ref[f"curve_{curve}"].tolist(), BASELINES[case]],
        )
        assert np.allclose(got, ref[f"baseline_{case}_{curve}"], rtol=1e-9, atol=1e-7), curve


def test_baseline_to_anchors_and_linear_ends(app, ref):
    profile = ref["curve_0"]
    base = ref["baseline_1_0"]  # its rolling background
    got = app.evaluate("(c) => WB.quant.baselineToAnchors(c)", base.tolist())
    assert [tuple(a) for a in got] == pytest.approx([tuple(a) for a in ref["anchors"]])
    assert app.evaluate("(p) => WB.quant.linearEnds(p)", profile.tolist()) == pytest.approx(ref["linear_ends"])


def js_peaks(peaks):
    return [[p["start"], p["end"], p["apex"]] for p in peaks]


def test_peak_detection_and_areas(app, ref):
    # the profile and background of each of the synthetic blot's eight lanes
    profiles = [ref[f"peak_profile_{n}"].tolist() for n in range(8)]
    bases = [ref[f"peak_baseline_{n}"].tolist() for n in range(8)]
    found = []
    for n, (profile, base) in enumerate(zip(profiles, bases)):
        for case, prominence in enumerate((0.05, 0.2, 0.005)):
            got = app.evaluate("([p, b, prom]) => WB.quant.detectPeaks(p, b, { prominence: prom })", [profile, base, prominence])
            assert js_peaks(got) == ref["detect_peaks"][n][case]
        peaks = [peak(*p, band_id=k + 1) for k, p in enumerate(ref["detect_peaks"][n][0])]
        areas = app.evaluate("([p, b, peaks]) => peaks.map((k) => WB.quant.peakArea(p, b, k))", [profile, base, peaks])
        assert areas == pytest.approx(ref["peak_areas"][n], rel=1e-9)
        found.append({"peaks": peaks})

    found[0]["peaks"][1]["quantify"] = False
    del found[1]["peaks"][0]
    found[2]["peaks"][0]["band_id"] = 7
    expected = ref["results_table"]
    payload = [found, profiles, bases]
    got = app.evaluate("([l, p, b]) => WB.quant.resultsTable(l, p, b)", payload)
    assert got["bands"] == expected["bands"]
    for got_row, row in zip(got["rows"], expected["rows"], strict=True):
        assert [v is None for v in got_row] == [v is None for v in row]
        assert [v for v in got_row if v is not None] == pytest.approx([v for v in row if v is not None], rel=1e-9)
    csv = app.evaluate("([l, p, b]) => { const t = WB.quant.resultsTable(l, p, b); return WB.quant.tableToCsv(t.bands, t.rows); }", payload)
    assert csv == ref["results_csv"]


def test_whole_pipeline_from_the_image(app, blot, ref):
    """From pixels to areas in one go."""
    got = call(
        app,
        """(img) => WB.lanes.detect(img, { nLanes: 8 }).map((lane) => {
            const profile = WB.lanes.extractProfile(img, lane);
            const base = WB.quant.computeBaseline(profile, lane.baseline);
            return WB.quant.detectPeaks(profile, base).map((p) => WB.quant.peakArea(profile, base, p));
        })""",
        blot["img"],
    )
    assert [len(g) for g in got] == [3] * 8
    assert np.allclose(got, ref["pipeline_areas"], rtol=1e-3)


def test_peak_at(app, ref):
    x = np.arange(400.0)
    wide = 100 * np.exp(-0.5 * ((x - 120) / 15) ** 2)
    pair = 80 * np.exp(-0.5 * ((x - 280) / 8) ** 2) + 60 * np.exp(-0.5 * ((x - 310) / 8) ** 2)
    base = 0.1 * x + 20
    profile = wide + pair + base
    cases = [
        (126, {}),
        (280, {}),
        (310, {}),
        (120, {"limits": [110, 400]}),
        (120.5, {"search": 3.5}),
        (200, {}),
        (5, {"limits": [0, 6.5]}),
    ]
    for (position, options), expected in zip(cases, ref["peak_at"], strict=True):
        got = app.evaluate("([p, b, x, o]) => WB.quant.peakAt(p, b, x, o)", [profile.tolist(), base.tolist(), position, options])
        assert [got["start"], got["end"], got["apex"]] == expected, position
    assert app.evaluate("([p, b]) => WB.quant.peakAt(p.map((v) => v - 1), p, 200)", [base.tolist(), base.tolist()]) is None


def test_peak_numbering(app):
    def with_peaks(peaks):
        return lane(10, 0, 100, 8, peaks=peaks)

    peaks = [peak(60, 70, 65), peak(10, 20, 15)]
    got = app.evaluate("(l) => { WB.quant.numberPeaks(l); return [l.peaks.map((p) => [p.apex, p.band_id]), WB.quant.isNumberedInOrder(l)]; }", with_peaks(peaks))
    assert got == [[[15, 1], [65, 2]], True]
    assert app.evaluate("(l) => WB.quant.isNumberedInOrder(l)", with_peaks([{**peaks[0], "band_id": 7}])) is False


VALLEY = make_baseline("valley")


def test_valley_to_valley_background(app):
    x = np.arange(200.0)
    slope = 50 + 0.5 * x
    band = 300 * np.exp(-0.5 * ((x - 80) / 6) ** 2)
    profile = slope + band
    peaks = [peak(60, 100, 80), peak(150, 170, 160)]
    got = np.array(app.evaluate("([p, b, k]) => Array.from(WB.quant.computeBaseline(p, b, k))", [profile.tolist(), VALLEY, peaks]))
    # under a peak: the straight line between the profile at its two borders; elsewhere the profile itself
    line = profile[60] + (profile[100] - profile[60]) * (x[60:101] - 60) / 40
    assert np.allclose(got[60:101], line) and np.allclose(got[:60], profile[:60]) and np.allclose(got[101:150], profile[101:150])
    area = app.evaluate("([p, b, k]) => WB.quant.peakArea(p, WB.quant.computeBaseline(p, b, k), k[0])", [profile.tolist(), VALLEY, peaks])
    assert area == pytest.approx(float(np.sum(profile[60:101] - line)), rel=1e-9)
    # the slope under the band is taken off and the band is left: its amount, less the
    # little that its tails still have at the borders
    amount = 300 * 6 * np.sqrt(2 * np.pi)
    assert 0.98 * amount < area < amount
    # no peak, nothing measured; a stretch without a band has no area
    assert np.allclose(app.evaluate("([p, b]) => Array.from(WB.quant.computeBaseline(p, b))", [profile.tolist(), VALLEY]), profile)
    assert app.evaluate("([p, b, k]) => WB.quant.peakArea(p, WB.quant.computeBaseline(p, b, k), k[1])", [profile.tolist(), VALLEY, peaks]) == pytest.approx(0, abs=1e-6)
    # where the profile dips under the line nothing is enclosed, so nothing is taken off
    dip = profile.copy()
    dip[88:96] -= 200
    base = np.array(app.evaluate("([p, b, k]) => Array.from(WB.quant.computeBaseline(p, b, k))", [dip.tolist(), VALLEY, peaks]))
    assert np.all(base <= dip + 1e-9) and np.allclose(base[88:96], dip[88:96])
    area = app.evaluate("([p, b, k]) => WB.quant.peakArea(p, WB.quant.computeBaseline(p, b, k), k[0])", [dip.tolist(), VALLEY, peaks])
    assert area == pytest.approx(float(np.sum(np.maximum(dip[60:101] - line, 0))), rel=1e-9)
    # peaks are looked for on the rolling ball, which does not need them
    search = app.evaluate("([p, b]) => Array.from(WB.quant.searchBaseline(p, b))", [profile.tolist(), VALLEY])
    rolling = app.evaluate("([p, b]) => Array.from(WB.quant.computeBaseline(p, b))", [profile.tolist(), make_baseline("rolling")])
    assert search == rolling
    found = app.evaluate("([p, b]) => WB.quant.detectPeaks(p, WB.quant.searchBaseline(p, b))", [profile.tolist(), VALLEY])
    assert [p["apex"] for p in found] == [80]


def fiji_lane(rect):
    x, y, width, height = rect
    return lane(x + (width - 1) / 2, y - 0.5, y + height - 0.5, width)


def test_profiles_are_those_of_fiji(app, real_blot, ref):
    """Fiji's gel analyzer and this page take the same profile of a lane: the mean across its width."""
    img = tifffile.imread(real_blot).astype(np.float32)
    for index in (0, 3):
        got = call(app, "(img, lane) => Array.from(WB.lanes.extractProfile(img, lane))", img, args=fiji_lane(ref["fiji"]["rects"][index]))
        assert np.allclose(got, ref[f"fiji_profile_{index}"], rtol=1e-6)


def test_valley_to_valley_areas_are_those_of_fiji(app, real_blot, ref):
    """Fiji counts the pixels a peak encloses on its plot picture, so its areas are ours times the
    scale of that picture, rounded to pixels: the smaller the region on the picture, the rougher."""
    fiji = ref["fiji"]
    img = tifffile.imread(real_blot).astype(np.float32)
    scale = fiji["x_scale"] * fiji["y_scale"]
    ratios, sizes = [], []
    for index, rect in enumerate(fiji["rects"]):
        mine = [p for p in fiji["peaks"] if p[0] == index]
        peaks = [peak(a, b, (a + b) // 2) for _, a, b, _, _ in mine]
        areas = call(
            app,
            """(img, [lane, peaks, b]) => { const profile = WB.lanes.extractProfile(img, lane);
                const base = WB.quant.computeBaseline(profile, b, peaks);
                return peaks.map((p) => WB.quant.peakArea(profile, base, p)); }""",
            img,
            args=[fiji_lane(rect), peaks, VALLEY],
        )
        ratios += [p[4] / (area * scale) for p, area in zip(mine, areas)]
        sizes += [p[3] for p in mine]
    ratios, sizes = np.array(ratios), np.array(sizes)
    assert len(ratios) == 24
    assert np.median(ratios) == pytest.approx(1, abs=0.015)
    assert np.all(np.abs(ratios[sizes > 2000] - 1) < 0.03)
    # regions of a few plot pixels are where Fiji's rounding shows; it always measures them smaller
    assert np.all(ratios[sizes < 200] < 1) and np.all(np.abs(ratios - 1) < 0.3)


def test_images_are_kept_as_16_bit_tiff(app, blot, tmp_path):
    """Whatever an image was read from, it is written as one kind of file that other programs read."""
    encode = "(img) => { const bytes = WB.imageio.encodeTiff(img); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }"
    for image in (blot["img"], blot["img"][:7, :5], np.array([[0, 65535, 70000, -3, 12.5, 13.5, 0.4]], dtype=np.float32)):
        data = base64.b64decode(call(app, encode, image))
        path = tmp_path / "written.tif"
        path.write_bytes(data)
        with tifffile.TiffFile(path) as tif:
            page = tif.pages[0]
            assert page.dtype == np.uint16 and page.shape == image.shape and page.compression == 1 and page.photometric == 1
            read = page.asarray()
        # whole numbers as they are; others rounded, and kept within what 16 bits hold
        assert np.array_equal(read, np.clip(np.floor(image.astype(np.float64) + 0.5), 0, 65535))
        # and the page reads its own files back
        back = app.evaluate(
            "(b64) => { const img = WB.imageio.decodeTiff(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer); return [img.w, img.h, Array.from(img.data)]; }",
            base64.b64encode(data).decode(),
        )
        assert back[:2] == [image.shape[1], image.shape[0]] and np.array_equal(np.array(back[2]).reshape(image.shape), read)
