"""Record again the reference values that depend on how peaks are found.

For after a deliberate change to peak detection: the page's own results become
the values that tests/test_core.py and tests/test_ui.py hold it to. Look at
the difference (git diff tests/data/reference.json) before committing it.

    uv run python record_reference.py
"""

import json

import numpy as np
from conftest import DATA, INDEX_URL, image_arg, make_blot
from playwright.sync_api import sync_playwright

path = DATA / "reference.json"
ref = json.loads(path.read_text())
with np.load(DATA / "reference.npz") as curves:
    profiles = [curves[f"peak_profile_{n}"].tolist() for n in range(8)]
    bases = [curves[f"peak_baseline_{n}"].tolist() for n in range(8)]

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(INDEX_URL)
    page.wait_for_function("window.WB && WB.quant")

    # test_peak_detection_and_areas
    found = page.evaluate(
        "([ps, bs]) => ps.map((p, n) => [0.05, 0.2, 0.005].map((prom) => WB.quant.detectPeaks(p, bs[n], { prominence: prom }).map((k) => [k.start, k.end, k.apex])))",
        [profiles, bases],
    )
    ref["detect_peaks"] = found
    lanes = [{"peaks": [dict(start=a, end=b, apex=c, band_id=k + 1, quantify=True) for k, (a, b, c) in enumerate(lane[0])]} for lane in found]
    ref["peak_areas"] = page.evaluate("([ls, ps, bs]) => ls.map((l, n) => l.peaks.map((k) => WB.quant.peakArea(ps[n], bs[n], k)))", [lanes, profiles, bases])
    lanes[0]["peaks"][1]["quantify"] = False
    del lanes[1]["peaks"][0]
    lanes[2]["peaks"][0]["band_id"] = 7
    table = page.evaluate("([l, p, b]) => { const t = WB.quant.resultsTable(l, p, b); return [t, WB.quant.tableToCsv(t.bands, t.rows)]; }", [lanes, profiles, bases])
    ref["results_table"], ref["results_csv"] = table

    # test_whole_pipeline_from_the_image, and the table of the Quantify tab
    blot = make_blot()["wb"]
    ref["pipeline_table"] = page.evaluate(
        """([w, h, data]) => { const img = { w, h, data: Float32Array.from(data) };
            const lanes = WB.lanes.detect(img, { nLanes: 8 });
            const curves = lanes.map((lane) => { const profile = WB.lanes.extractProfile(img, lane);
                const base = WB.quant.computeBaseline(profile, lane.baseline);
                lane.peaks = WB.quant.detectPeaks(profile, base); WB.quant.numberPeaks(lane);
                return [profile, base]; });
            return WB.quant.resultsTable(lanes, curves.map((c) => c[0]), curves.map((c) => c[1])); }""",
        image_arg(blot),
    )
    ref["pipeline_areas"] = ref["pipeline_table"]["rows"]

    # test_peak_at
    x = np.arange(400.0)
    wide = 100 * np.exp(-0.5 * ((x - 120) / 15) ** 2)
    pair = 80 * np.exp(-0.5 * ((x - 280) / 8) ** 2) + 60 * np.exp(-0.5 * ((x - 310) / 8) ** 2)
    base = 0.1 * x + 20
    cases = [(126, {}), (280, {}), (310, {}), (120, {"limits": [110, 400]}), (120.5, {"search": 3.5}), (200, {}), (5, {"limits": [0, 6.5]})]
    ref["peak_at"] = [
        page.evaluate("([p, b, x, o]) => { const k = WB.quant.peakAt(p, b, x, o); return k && [k.start, k.end, k.apex]; }", [(wide + pair + base).tolist(), base.tolist(), position, options])
        for position, options in cases
    ]
    browser.close()

path.write_text(json.dumps(ref, indent=1) + "\n")
print("recorded:", "detect_peaks, peak_areas, results_table, results_csv, pipeline_table, pipeline_areas, peak_at")
