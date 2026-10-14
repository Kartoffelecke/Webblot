"""The core must give the right numbers: those the test images were made with, and those of Fiji."""

import base64

import numpy as np
import pytest
import tifffile
from conftest import call


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


def rotate(app, img, angle):
    w, h, data = call(app, "(img, a) => { const r = WB.processing.rotate(img, a); return [r.w, r.h, Array.from(r.data)]; }", img, args=angle)
    return np.array(data, dtype=np.float32).reshape(h, w)


def test_rotation(app, blot):
    img = blot["img"][:150, :220]
    # quarter turns move the pixels and nothing else
    for angle in (0, 90, 180, 270, -90):
        assert np.array_equal(rotate(app, img, angle), np.rot90(img, (angle // 90) % 4))
    # other angles enlarge the image to hold all of it; the corners get the median
    turned = rotate(app, img, 33)
    c, s = np.cos(np.radians(33)), np.sin(np.radians(33))
    assert turned.shape == pytest.approx((150 * c + 220 * s, 220 * c + 150 * s), abs=1)
    assert turned[0, 0] == np.median(img) and turned[-1, -1] == np.median(img)
    # and turning back gives the image again, but for the interpolation
    back = rotate(app, turned, -33)
    y0, x0 = (back.shape[0] - 150) // 2, (back.shape[1] - 220) // 2
    middle = (slice(y0 + 20, y0 + 130), slice(x0 + 20, x0 + 200))
    assert np.abs(back[middle] - img[20:130, 20:200]).mean() < 0.02 * np.ptp(img)


def test_apply_transform_and_crop_rounding(app, blot):
    img = blot["img"][:150, :220]
    rotated = rotate(app, img, 4.0)
    # the crop box [y0, x0, y1, x1] is rounded and clipped to the image; a box
    # that leaves less than 2 px is ignored
    cases = [
        ((10, 20, 100, 200), rotated[10:100, 20:200]),
        ((10.4, 20.6, 99.5, 180.5), rotated[10:100, 21:181]),
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
        assert np.array_equal(np.array(data, dtype=np.float32).reshape(h, w), expected), crop


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


def js_detect(app, img, **options):
    return call(app, "(img, o) => WB.lanes.detect(img, o)", img, args=options)


def test_lane_detection(app, blot):
    """The lanes are found where the synthetic blot was made with them."""
    img = blot["img"]
    for options in ({}, {"nLanes": 8}, {"nLanes": 8, "widthFrac": 0.6}):
        got = js_detect(app, img, **options)
        assert [g["x_center"] for g in got] == pytest.approx(blot["centers"], abs=1.5), options
    # within an area: the lanes stay in it, and reach from its top to its bottom row (pixel edges)
    got = js_detect(app, img, nLanes=8, roi=[30.2, 40.7, 390.0, 610.0])
    assert [g["x_center"] for g in got] == pytest.approx(blot["centers"], abs=1.5)
    assert all(40 <= g["x_center"] - g["width"] / 2 and g["x_center"] + g["width"] / 2 <= 610 and [g["y0"], g["y1"]] == [29.5, 389.5] for g in got)
    # evenly spaced: the same distance between all of them
    got = [g["x_center"] for g in js_detect(app, img, nLanes=7, method="even", roi=[10, 100, 90, 660])]
    assert len(got) == 7 and np.allclose(np.diff(got), np.diff(got)[0]) and 100 < got[0] < got[-1] < 660


def test_lane_detection_on_uneven_blots(app, blot):
    # two lanes blanked out: peak finding sees six, the grid fit must give eight
    img = blot["img"].copy()
    c = blot["centers"]
    for cx in (c[2], c[5]):
        img[:, int(cx - 35) : int(cx + 35)] = np.median(img)
    assert [g["x_center"] for g in js_detect(app, img, nLanes=8)] == pytest.approx(c, abs=1.5)
    # strong signal only on the left, a smear and a blob: the lanes still span the blot
    rng = np.random.default_rng(1)
    img = rng.normal(0, 0.02, (300, 700))
    for i, amp in enumerate([1.0, 0.9, 1.0, 0.8, 0.05, 0.03, 0.04]):
        cx = int((i + 0.5) * 100)
        img[100:115, cx - 30 : cx + 30] += amp
    img[180:200, 20:330] += 0.6
    img[40:60, 60:90] += 1.5
    got = [g["x_center"] for g in js_detect(app, img.astype(np.float32), nLanes=7)]
    assert len(got) == 7 and got[-1] - got[0] >= 0.85 * 600


def test_lane_detection_on_the_real_blot(app, real_blot):
    img = tifffile.imread(real_blot).astype(np.float32)
    for roi in ((100, 205, 600, 925), (80, 190, 700, 960), (120, 205, 200, 925)):
        got = [g["x_center"] for g in js_detect(app, img, nLanes=7, roi=list(roi))]
        assert len(got) == 7 and roi[1] < got[0] and got[-1] < roi[3], roi
        # the seven lanes of this blot stand about 103 px apart
        assert np.diff(got) == pytest.approx([103] * 6, abs=8), roi


def test_whole_pipeline_from_the_image(app, blot):
    """From pixels to areas in one go: the bands are where the blot was made with them, and the
    loading control, the same in every lane, measures the same in every lane."""
    got = call(
        app,
        """(img) => WB.lanes.detect(img, { nLanes: 8 }).map((lane) => {
            const profile = WB.lanes.extractProfile(img, lane);
            const base = WB.quant.computeBaseline(profile, lane.baseline);
            return WB.quant.detectPeaks(profile, base).map((p) => [lane.y0 + p.apex, WB.quant.peakArea(profile, base, p)]);
        })""",
        blot["img"],
    )
    assert [len(g) for g in got] == [3] * 8
    got = np.array(got)
    assert np.all(np.abs(got[:, :, 0] - blot["band_ys"]) <= 1)
    control = got[:, 2, 1]
    assert control.std() / control.mean() < 0.01


def test_peak_at(app):
    x = np.arange(400.0)
    wide = 100 * np.exp(-0.5 * ((x - 120) / 15) ** 2)
    pair = 80 * np.exp(-0.5 * ((x - 280) / 8) ** 2) + 60 * np.exp(-0.5 * ((x - 310) / 8) ** 2)
    base = 0.1 * x + 20
    profile = wide + pair + base
    # near a band: that band, from where it starts to where it ends
    cases = [(126, {}, 120), (280, {}, 280), (310, {}, 310), (120, {"limits": [110, 400]}, 120), (120.5, {"search": 3.5}, 120)]
    for position, options, apex in cases:
        got = app.evaluate("([p, b, x, o]) => WB.quant.peakAt(p, b, x, o)", [profile.tolist(), base.tolist(), position, options])
        assert got["apex"] == apex and got["start"] < apex < got["end"], position
        if "limits" in options:
            assert got["start"] >= options["limits"][0]
    # the two bands of the pair are told apart
    left = app.evaluate("([p, b]) => WB.quant.peakAt(p, b, 280)", [profile.tolist(), base.tolist()])
    right = app.evaluate("([p, b]) => WB.quant.peakAt(p, b, 310)", [profile.tolist(), base.tolist()])
    assert left["end"] <= right["start"] + 1
    # nothing above the background, no peak
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


def test_profiles_are_those_of_fiji(app, real_blot, fiji):
    """Fiji's gel analyzer and this page take the same profile of a lane: the mean across its width."""
    img = tifffile.imread(real_blot).astype(np.float32)
    for index in (0, 3):
        got = call(app, "(img, lane) => Array.from(WB.lanes.extractProfile(img, lane))", img, args=fiji_lane(fiji["rects"][index]))
        assert np.allclose(got, fiji["profiles"][str(index)], rtol=1e-6)


def test_valley_to_valley_areas_are_those_of_fiji(app, real_blot, fiji):
    """Fiji counts the pixels a peak encloses on its plot picture, so its areas are ours times the
    scale of that picture, rounded to pixels: the smaller the region on the picture, the rougher."""
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
