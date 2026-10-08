"""Screenshots of the main views with the real LC3 blot, for checking by eye."""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(sys.argv[1])
blot = sorted((Path(__file__).resolve().parents[2] / "napari-blot" / "data").glob("*.tif"))[0]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto((Path(__file__).resolve().parent.parent / "index.html").as_uri())
    page.locator("[data-t=add-files]").set_input_files([str(blot), str(blot), str(blot)])
    page.wait_for_function("WB.state.blots.length === 3")
    page.evaluate(
        """() => {
            const s = WB.state, app = WB.app;
            const names = ["p62", "LC3", "Total protein"];
            const areas = [[120, 200, 190, 930], [450, 200, 570, 930], [600, 200, 700, 930]];
            const bands = [[[155, "p62"]], [[480, "LC3-I"], [525, "LC3-II"]], [[650, "Total"]]];
            s.blots.forEach((b, i) => {
                b.name = names[i];
                b.roi = [100, 205, 600, 925];
                b.session.lanes = WB.lanes.detect(app.signal(b), { nLanes: 7, roi: b.roi.map((v) => v + 0.5) });
                b.session.transform.invert_lut = true;
                b.session.figure.crop = areas[i];
                b.session.figure.band_markers = bands[i].map(([y, text]) => ({ y, text }));
            });
            const first = s.blots[0];
            first.session.figure.label_rows = [
                { title: "", collapse: true, values: ["mock", "mock", "mock", "Baf", "Baf", "Baf", "Baf"] },
                { title: "Time (h)", collapse: false, values: ["0", "2", "4", "0", "2", "4", "8"] },
            ];
            first.session.figure.mw_markers = [{ y: 160, text: "62" }];
            s.blots[1].session.figure.mw_markers = [{ y: 500, text: "15" }];
            s.style.mw_unit = " kDa";
            for (const lane of s.blots[1].session.lanes) {
                const c = app.curves(s.blots[1], lane);
                lane.peaks = WB.quant.detectPeaks(c.profile, c.baseline);
                WB.quant.numberPeaks(lane);
            }
            app.select(s.blots[1].id, 2);
            s.cardWidth = 360;
            app.changed("blots", "panel");
            app.flush();
        }"""
    )
    page.click("[data-t=tab-lanes]")
    page.screenshot(path=str(out / "web1_lanes.png"))
    page.click("[data-t=tab-quantify]")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "web2_quantify.png"))
    page.click("[data-t=tab-figure]")
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "web3_figure.png"))
    with page.expect_download() as d:
        page.click("[data-t=export-png]")
    d.value.save_as(out / "web_figure.png")
    print("errors:", errors)
    browser.close()
