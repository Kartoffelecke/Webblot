"""The work folder: blots and figures as directories a person can read."""

import base64
import functools
import http.server
import io
import json
import struct
import threading
import zipfile

import numpy as np
import pytest
import tifffile
from conftest import ALL_SECTIONS_OPEN, INDEX_URL, ROOT, Ui


def started(page, url=INDEX_URL, expect_error=False):
    """A page of the application, once it has opened what is in the work folder."""
    page.add_init_script(ALL_SECTIONS_OPEN)
    page.goto(url)
    page.wait_for_function("window.WB && WB.library && WB.library.ready")
    page.evaluate("WB.library.ready")
    page.set_viewport_size({"width": 1500, "height": 950})
    ui = Ui(page)
    ui.flush()
    # what the page could not read is said in a message: make it the reason of a failure
    if ui.t("toast-error").count() and not expect_error:
        pytest.fail(f"After loading: {ui.t('toast-error').inner_text()}")
    return ui


def file_bytes(ui, path):
    return base64.b64decode(ui.page.evaluate(
        """(path) => WB.tree.store.read(path.split("/")).then((bytes) => { let s = "";
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return btoa(s); })""", path))


def png_size(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return list(struct.unpack(">II", data[16:24]))


def tree_shown(ui):
    """The panel at the left: [[folder, [blots], [figures]]]."""
    return ui.page.evaluate(
        """[...document.querySelectorAll("[data-t=tree-folder]")].map((li) => [li.dataset.name,
            [...li.querySelectorAll("[data-t=tree-blot]")].map((b) => b.textContent), [...li.querySelectorAll("[data-t=tree-figure]")].map((b) => b.textContent)])""")


def test_a_blot_is_a_directory_that_can_be_read_without_the_page(ui, blot_files, blot):
    assert ui.files() == {} and ui.t("save-status").inner_text() == ""
    assert "Kept in this browser" in ui.t("tree-store").inner_text()
    ui.add_files(*blot_files)
    ui.select_blot(0)
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.state("(WB.app.setCrop(b, [20, 30, 400, 620]), b.session.figure.label_rows = [{ title: 'Drug', collapse: false, values: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }], WB.app.changed('figure'))")
    ui.saved()

    # nothing was pressed for it; the folder goes by the name of its first blot
    files = ui.files()
    assert set(files) == {
        "target/folder.json",
        *(f"target/{blot_dir}/{name}" for blot_dir in ("target", "control") for name in ("blot.json", "raw.tif", "view.png", "lanes.png", "areas.csv", "profiles.csv")),
        "target/Figure/figure.json", "target/Figure/figure.svg", "target/Figure/figure.png",
    }
    assert ui.t("save-status").inner_text() == "Saved" and tree_shown(ui) == [["target", ["target", "control"], ["Figure"]]]

    # the raw image: one format whatever was read, and exactly the pixels
    raw = tifffile.imread(io.BytesIO(file_bytes(ui, "target/target/raw.tif")))
    assert raw.dtype == np.uint16 and np.array_equal(raw, blot["wb"])
    # everything about the blot, as text
    doc = json.loads(ui.read("target/target/blot.json"))
    assert doc["app"] == "web_blot" and doc["kind"] == "blot" and doc["name"] == "target"
    assert doc["transform"]["crop"] == [20, 30, 400, 620] and len(doc["lanes"]) == 8 and len(doc["lanes"][0]["peaks"]) == 3
    assert doc["lane_labels"][0]["title"] == "Drug" and doc["brightfield"] is None
    assert ui.read("target/target/blot.json").startswith('{\n "app": "web_blot"')  # laid out for reading
    # what the page shows, for looking at without it
    assert png_size(file_bytes(ui, "target/target/view.png")) == [590, 380] == png_size(file_bytes(ui, "target/target/lanes.png"))
    assert file_bytes(ui, "target/target/view.png") != file_bytes(ui, "target/target/lanes.png")
    table = ui.state("WB.app.results(b)")
    lines = ui.read("target/target/areas.csv").splitlines()
    assert lines[0] == "Lane,Peak 1,Peak 2,Peak 3" and len(lines) == 9
    assert [float(v) for v in lines[1].split(",")[1:]] == pytest.approx(table["rows"][0], rel=1e-5)
    profiles = ui.read("target/target/profiles.csv").splitlines()
    assert profiles[0] == "lane,position_px,intensity,background" and len(profiles) == 1 + 8 * 420 and profiles[1].startswith("1,0,")
    # the figure: how it is made, and as it renders
    figure = json.loads(ui.read("target/Figure/figure.json"))
    assert figure["kind"] == "figure" and [p["blot"] for p in figure["panels"]] == ["target", "control"] and figure["panels"][0]["lane_labels"] is True
    assert figure["style"]["line_width_mm"] == 0.2
    assert ui.read("target/Figure/figure.svg") == ui.state("WB.figurepanel.build().svg") and ">Drug<" in ui.read("target/Figure/figure.svg")
    assert png_size(file_bytes(ui, "target/Figure/figure.png"))[0] > 500

    # they follow what is changed
    ui.state("(b.session.lanes[0].peaks.pop(), WB.app.setCrop(b, [10, 0, 370, 500]), WB.app.changed('quant'))")
    ui.saved()
    assert png_size(file_bytes(ui, "target/target/view.png")) == [500, 360]
    assert ui.read("target/target/areas.csv").splitlines()[1].endswith(",")  # lane 1 has no third peak now
    # the image is not written again for a change of settings
    written = ui.page.evaluate("(() => { let n = 0; const write = WB.tree.store.write; WB.tree.store.write = (path, data) => { if (path[2] === 'raw.tif') n++; return write(path, data); }; window.rawWrites = () => n; })()")
    ui.state("(b.session.transform.gamma = 0.6, WB.app.changed('display'))")
    ui.saved()
    assert ui.page.evaluate("window.rawWrites()") == 0 and json.loads(ui.read("target/target/blot.json"))["transform"]["gamma"] == 0.6

    # after a reload it is all there again
    before, results = ui.document(), ui.state("WB.app.results(b)")
    again = started(ui.page)
    assert again.document() == before and again.state("WB.app.results(b)") == results
    assert again.state("[s.folder.dir, s.blots.map((b) => b.name), s.figures.map((f) => f.name)]") == ["target", ["target", "control"], ["Figure"]]
    files = again.files()
    again.saved()
    assert again.files() == files  # opening it wrote nothing


def test_names_are_the_directories(ui, blot_files):
    ui.add_files(*blot_files)
    ui.saved()
    ui.state("(s.blots[1].name = 'Loading: GAPDH / total?', WB.app.changed('blots'))")
    ui.set("project-name", "2026-09 LC3")
    ui.saved()
    files = ui.files()
    assert "2026-09 LC3/Loading_ GAPDH _ total_/blot.json" in files and not any(path.startswith("target/") for path in files)
    assert json.loads(ui.read("2026-09 LC3/Loading_ GAPDH _ total_/blot.json"))["name"] == "Loading: GAPDH / total?"
    assert tree_shown(ui)[0][0] == "2026-09 LC3"
    # two blots of one name get directories of their own
    ui.state("(s.blots[1].name = 'target', WB.app.changed('blots'))")
    ui.saved()
    assert {path.split("/")[1] for path in ui.files() if path.endswith("blot.json")} == {"target", "target 2"}
    assert json.loads(ui.read("2026-09 LC3/folder.json"))["order"] == ["target", "target 2"]

    # a removed blot's directory goes; Undo brings it back, image and all
    ui.click("blot-remove", 1)
    ui.saved()
    assert {path.split("/")[1] for path in ui.files() if path.endswith("blot.json")} == {"target"}
    ui.click("toast-action")
    ui.saved()
    assert "2026-09 LC3/target 2/raw.tif" in ui.files() and "2026-09 LC3/target 2/view.png" in ui.files()
    again = started(ui.page)
    assert again.state("s.blots.map((b) => b.name)") == ["target", "target"]


def test_a_brightfield_is_kept_with_its_blot(ui, blot_files, blot, tmp_path):
    marker = tmp_path / "marker.tif"
    tifffile.imwrite(marker, blot["bf"])
    ui.add_files(marker, blot_files[0])
    ui.state("WB.app.mergeAsBrightfield(s.blots[0].id, s.blots[1].id)")
    ui.saved()
    assert set(ui.files()) >= {"target/target/raw.tif", "target/target/brightfield.tif"} and not any("marker/" in path for path in ui.files())
    assert np.array_equal(tifffile.imread(io.BytesIO(file_bytes(ui, "target/target/brightfield.tif"))), blot["bf"])
    doc = json.loads(ui.read("target/target/blot.json"))
    assert doc["brightfield"]["was"]["name"] == "marker"
    again = started(ui.page)
    assert again.state("[s.blots.length, b.bfOrigin.name, b.work.bf.w]") == [1, "marker", 640]
    # split off again: a blot of its own, with a directory of its own
    again.tab("prepare")
    again.click("bf-split")
    again.saved()
    assert "target/marker/raw.tif" in again.files() and "target/target/brightfield.tif" not in again.files()
    assert json.loads(again.read("target/target/blot.json"))["brightfield"] is None


def test_a_folder_has_several_figures(ui, blot_files):
    ui.add_files(*blot_files)
    ui.tab("figure")
    ui.select_blot(0)
    ui.t("figure-crop").check()
    ui.state("(b.session.figure.crop = [59.5, 19.5, 119.5, 619.5], WB.app.changed('figure'))")
    ui.set("font-size", 10)
    assert ui.t("figure-delete").is_disabled()
    whole = "WB.figurepanel.build().gels.map((g) => g.box[2] - g.box[0])"
    assert ui.state(whole) == [60, 420]

    # another figure: every blot whole, its own style
    ui.click("figure-new")
    ui.flush()
    assert ui.state("[s.figures.map((f) => f.name), s.style.font_size]") == [["Figure", "Figure 2"], 8] and ui.state(whole) == [420, 420]
    ui.set("figure-name", "Loading only")
    ui.t("panel-include", 0).uncheck()
    ui.t("panel-labels", 1).check()
    ui.flush()
    assert ui.state(whole) == [420]
    # the area box on the blot is that of the figure being edited
    assert ui.page.locator("[data-t=figure-area]").count() == 0
    ui.saved()
    assert {path for path in ui.files() if "figure." in path} == {f"target/{d}/figure.{e}" for d in ("Figure", "Loading only") for e in ("json", "svg", "png")}
    first, second = json.loads(ui.read("target/Figure/figure.json")), json.loads(ui.read("target/Loading only/figure.json"))
    assert [(p["blot"], p["shown"], p["area"], p["area_on"]) for p in first["panels"]] == [("target", True, [59.5, 19.5, 119.5, 619.5], True), ("control", True, None, False)]
    assert first["style"]["font_size"] == 10 and second["style"]["font_size"] == 8
    assert [(p["blot"], p["lane_labels"]) for p in second["panels"]] == [("control", True)]
    assert json.loads(ui.read("target/folder.json"))["figure"] == "Loading only"

    # back to the first: its area, its blots, its style
    ui.choose("figure-select", ui.state("s.figures[0].id"))
    assert ui.state(whole) == [60, 420] and ui.state("s.style.font_size") == 10 and ui.page.locator("[data-t=figure-area]").count() == 1
    assert ui.state("s.blots.map((b) => [b.include, b.labels])") == [[True, True], [True, False]]
    # cropping a blot keeps the areas of all figures on the same pixels
    ui.state("(WB.app.setCrop(b, [10, 10, 410, 630]), 0)")
    ui.click("figure-duplicate")
    ui.flush()
    assert ui.state("[s.figures.map((f) => f.name), b.session.figure.crop]") == [["Figure", "Loading only", "Figure copy"], [49.5, 9.5, 109.5, 609.5]]

    # after a reload: the figures, and the one that was being edited
    ui.saved()
    before = ui.document()
    again = started(ui.page)
    assert again.state("[s.figures.map((f) => f.name), s.figures.find((f) => f.id === s.figure).name]") == [["Figure", "Figure copy", "Loading only"], "Figure copy"]
    assert again.document() == before
    again.tab("figure")
    again.choose("figure-select", again.state("s.figures.find((f) => f.name === 'Loading only').id"))
    assert again.state(whole) == [420] and again.state("s.blots.map((b) => b.include)") == [False, True]
    # a figure is deleted after a question; its directory goes
    again.click("figure-delete")
    assert "Loading only" in again.confirm()
    again.saved()
    assert again.state("s.figures.map((f) => f.name)") == ["Figure", "Figure copy"] and not any("Loading only" in path for path in again.files())
    # the panel at the left leads to a figure
    again.tab("prepare")
    again.page.locator("[data-t=tree-figure]", has_text="Figure copy").click()
    again.flush()
    assert again.state("[s.tab, s.figures.find((f) => f.id === s.figure).name]") == ["figure", "Figure copy"]


def test_folders_in_the_panel_at_the_left(ui, blot_files):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.saved()
    ui.click("tree-new")
    ui.page.wait_for_function("WB.state.folder.dir === 'New folder'")
    ui.flush()
    assert ui.state("s.blots.length") == 0 and ui.t("welcome").is_visible()
    assert [f[0] for f in tree_shown(ui)] == ["New folder", "target"]
    ui.set("project-name", "Loading controls")
    ui.add_files(blot_files[1])
    ui.saved()
    assert tree_shown(ui) == [["Loading controls", ["control"], ["Figure"]], ["target", ["target"], ["Figure"]]]

    # a click opens a folder; one on a blot opens its folder and selects it
    ui.page.locator("[data-t=tree-folder][data-name=target] [data-t=tree-open]").click()
    ui.page.wait_for_function("WB.state.folder.dir === 'target' && WB.state.blots.length === 1")
    ui.flush()
    assert ui.state("b.session.lanes.length") == 8 and ui.t("project-name").input_value() == "target"
    ui.page.locator("[data-t=tree-blot]", has_text="control").click()
    ui.page.wait_for_function("WB.state.folder.dir === 'Loading controls' && WB.state.blots[0].name === 'control'")
    # the panel can be put away and made wider
    width = ui.rect(ui.page.locator("#tree"))["width"]
    bar = ui.rect(ui.t("tree-bar"))
    ui.drag([bar["x"] + 3, bar["y"] + 200], [bar["x"] + 63, bar["y"] + 200])
    assert ui.rect(ui.page.locator("#tree"))["width"] == pytest.approx(width + 60, abs=3)
    ui.click("tree-toggle")
    assert not ui.page.locator("#tree").is_visible()
    ui.click("tree-toggle")
    assert ui.page.locator("#tree").is_visible()

    # a folder is deleted after a question
    ui.page.locator("[data-t=tree-folder][data-name=target] [data-t=tree-open]").hover()
    ui.page.locator("[data-t=tree-folder][data-name=target] [data-t=tree-delete]").click()
    assert "target" in ui.t("confirm-text").inner_text() and ui.t("confirm-ok").inner_text() == "Delete folder"
    ui.click("confirm-cancel")
    assert "target/target/blot.json" in ui.files()
    ui.page.locator("[data-t=tree-folder][data-name=target] [data-t=tree-open]").hover()
    ui.page.locator("[data-t=tree-folder][data-name=target] [data-t=tree-delete]").click()
    ui.click("confirm-ok")
    ui.page.wait_for_function("document.querySelectorAll('[data-t=tree-folder]').length === 1")
    assert not any(path.startswith("target/") for path in ui.files()) and ui.state("s.folder.dir") == "Loading controls"
    # the open one too: the page is empty then
    ui.page.locator("[data-t=tree-folder] [data-t=tree-open]").hover()
    ui.page.locator("[data-t=tree-folder] [data-t=tree-delete]").click()
    ui.click("confirm-ok")
    ui.page.wait_for_function("document.querySelectorAll('[data-t=tree-folder]').length === 0")
    assert ui.files() == {} and ui.state("s.blots.length") == 0
    again = started(ui.page)
    assert again.state("s.blots.length") == 0 and again.files() == {}


def test_folders_move_as_zip_files(ui, blot_files, browser, tmp_path):
    ui.add_files(*blot_files)
    ui.tab("lanes")
    ui.select_blot(0)
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.saved()
    before, results, files = ui.document(), ui.state("WB.app.results(b)"), ui.files()
    one = ui.download("save-project")
    assert one.suggested_filename == "target.zip"
    ui.click("tree-new")
    ui.page.wait_for_function("WB.state.folder.dir === 'New folder'")
    ui.click("add-sample")
    ui.saved()
    everything = ui.download("tree-download-all")
    assert everything.suggested_filename == "web_blot.zip"
    paths = [tmp_path / "one.zip", tmp_path / "all.zip"]
    one.save_as(paths[0])
    everything.save_as(paths[1])
    # ordinary zip files of what is on disk
    with zipfile.ZipFile(paths[0]) as archive:
        assert archive.testzip() is None and {name: archive.getinfo(name).file_size for name in archive.namelist()} == files
    with zipfile.ZipFile(paths[1]) as archive:
        assert {name.split("/")[0] for name in archive.namelist()} == {"target", "New folder"}

    # another browser
    context = browser.new_context()
    other = started(context.new_page())
    assert other.files() == {}
    other.t("tree-import-file").set_input_files(str(paths[1]))
    other.page.wait_for_function("document.querySelectorAll('[data-t=tree-folder]').length === 2")
    assert other.files().keys() == ui.files().keys()
    other.page.locator("[data-t=tree-folder][data-name=target] [data-t=tree-open]").click()
    other.page.wait_for_function("WB.state.folder.dir === 'target' && WB.state.blots.length === 2")
    other.flush()
    assert other.document() == before and other.state("WB.app.results(b)") == results
    # the same folder again comes beside it, nothing is replaced
    other.t("tree-import-file").set_input_files(str(paths[0]))
    other.page.wait_for_function("WB.state.folder.dir === 'target 2'")
    assert [f[0] for f in tree_shown(other)] == ["New folder", "target", "target 2"]
    # a zip somebody made of the content of a folder gets a folder around it
    bare = tmp_path / "from finder.zip"
    with zipfile.ZipFile(paths[0]) as archive, zipfile.ZipFile(bare, "w") as out:
        for name in archive.namelist():
            out.writestr(name.split("/", 1)[1], archive.read(name))
    other.t("tree-import-file").set_input_files(str(bare))
    other.page.wait_for_function("WB.state.folder.dir === 'from finder'")
    other.flush()
    assert other.document() == before
    # something else is said to be something else
    other.t("tree-import-file").set_input_files({"name": "x.zip", "mimeType": "application/zip", "buffer": b"nothing"})
    assert "not a zip" in other.t("toast-error").inner_text()
    context.close()


def test_a_folder_changed_outside_the_page_is_read_again(ui, blot_files):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.saved()
    # somebody edits blot.json by hand, and puts a folder beside it
    ui.page.evaluate(
        """async () => { const path = ["target", "target", "blot.json"]; const doc = JSON.parse(await WB.tree.readText(path));
            doc.lane_labels = [{ title: "by hand", collapse: false, values: ["1", "2", "3", "4", "5", "6", "7", "8"] }]; doc.lanes.pop();
            await WB.tree.store.write(path, JSON.stringify(doc)); await WB.tree.store.mkdir(["made in Finder"]); }"""
    )
    ui.page.evaluate("WB.library.refresh()")
    ui.flush()
    assert ui.state("[b.session.lanes.length, b.session.figure.label_rows[0].title]") == [7, "by hand"]
    assert "read again" in ui.t("toast").inner_text() and [f[0] for f in tree_shown(ui)] == ["made in Finder", "target"]
    # the page does not write over it
    ui.saved()
    assert json.loads(ui.read("target/target/blot.json"))["lane_labels"][0]["title"] == "by hand"
    # a directory that is not a blot is left alone and not shown as one; a broken one is reported
    ui.page.evaluate(
        """async () => { await WB.tree.store.write(["target", "notes", "readme.txt"], "mine");
            await WB.tree.store.write(["target", "broken", "blot.json"], "{ not json"); }"""
    )
    again = started(ui.page, expect_error=True)
    assert again.state("s.blots.length") == 1 and "broken" in again.t("toast-error").inner_text()
    again.saved()
    assert again.read("target/notes/readme.txt") == "mine" and again.read("target/broken/blot.json") == "{ not json"


def old_project(ui):
    """The open folder as a project file of the kind before folders."""
    return ui.page.evaluate("JSON.stringify(WB.project.serialize())")


def test_project_files_of_before_become_folders(ui, blot_files, browser, tmp_path):
    ui.add_files(*blot_files)
    ui.select_blot(0)
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.tab("figure")
    ui.t("figure-crop").check()
    ui.state("(b.session.figure.crop = [59.5, 19.5, 119.5, 619.5], s.style.gap_mm = 5, s.normalize = true, WB.app.changed('figure'))")
    ui.flush()
    before, results, figure = ui.document(), ui.state("WB.app.results(b)"), ui.state("WB.figurepanel.build().svg")
    current = json.loads(old_project(ui))
    # as version 4 wrote it: each image in its blot, the line width in points, no switch for the area
    old = {k: v for k, v in current.items() if k not in ("images", "name")}
    old["version"] = 4
    old["style"] = {k: v for k, v in current["style"].items() if k not in ("line_width_mm", "decrowd")} | {"line_width": 0.2 * 72 / 25.4}
    old["blots"] = [{**b, "wb": current["images"][b["wb"]], "session": {**b["session"], "figure": {k: v for k, v in b["session"]["figure"].items() if k != "crop_on"}}} for b in current["blots"]]
    project = tmp_path / "LC3 time course.webblot.json"
    project.write_text(json.dumps(old))
    library = tmp_path / "old.webblot.zip"
    with zipfile.ZipFile(library, "w") as archive:
        archive.writestr("library.json", json.dumps({"app": "web_blot", "kind": "library", "version": 1, "projects": [{"id": "a", "name": "From the library", "file": "projects/x.webblot.json"}]}))
        archive.writestr("projects/x.webblot.json", json.dumps(current))

    context = browser.new_context()
    other = started(context.new_page())
    other.t("open-project").set_input_files(str(project))
    other.page.wait_for_function("WB.state.folder.dir === 'LC3 time course' && WB.state.blots.length === 2")
    other.saved()
    # the same numbers and the same figure; its one figure is a figure directory
    # (the line width went through points and back, which costs a last digit)
    converted, original = json.loads(other.document()), json.loads(before)
    assert converted["style"].pop("line_width_mm") == pytest.approx(original["style"].pop("line_width_mm")) and converted == original
    assert other.state("WB.app.results(b)") == results and other.state("WB.figurepanel.build().svg") == figure
    assert {"LC3 time course/target/blot.json", "LC3 time course/control/raw.tif", "LC3 time course/Figure/figure.svg"} <= set(other.files())
    panel = json.loads(other.read("LC3 time course/Figure/figure.json"))["panels"][0]
    assert panel["area"] == [59.5, 19.5, 119.5, 619.5] and panel["area_on"] is True
    assert json.loads(other.read("LC3 time course/folder.json"))["normalize"] is True
    other.t("tree-import-file").set_input_files(str(library))
    other.page.wait_for_function("WB.state.folder.dir === 'From the library'")
    other.flush()
    assert other.document() == before and [f[0] for f in tree_shown(other)] == ["From the library", "LC3 time course"]
    figure = other.state("WB.figurepanel.build().svg")
    # what is not a project is said to be none, and nothing changes
    bad = tmp_path / "bad.webblot.json"
    bad.write_text("{}")
    other.t("open-project").set_input_files(str(bad))
    assert "not a web_blot project" in other.t("toast-error").inner_text() and other.state("s.folder.dir") == "From the library"
    context.close()


def test_projects_in_the_old_browser_storage_are_offered_for_moving_in(ui):
    ui.click("add-sample")
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.flush()
    results = ui.state("WB.app.results(b)")
    # two projects as the page kept them before folders
    ui.page.evaluate(
        """async () => { const d = WB.project.serialize(); const images = Object.fromEntries(Object.entries(d.images).map(([k, v]) => [k, WB.imageio.packedToBinary(v)]));
            delete d.images;
            await WB.store.put({ id: "a", name: "Autophagy", created: 1, modified: 2, blots: ["Sample 1"] }, d, images);
            await WB.store.put({ id: "b", name: "Loading", created: 1, modified: 3, blots: ["Sample 1"] }, d, images);
            await WB.library.removeFolder(WB.state.folder.dir); }"""
    )
    again = started(ui.page)
    assert "2 projects from before" in again.t("tree-old").inner_text() and again.files() == {}
    again.click("tree-move-old")
    again.t("tree-old").wait_for(state="detached")
    again.flush()
    assert [f[0] for f in tree_shown(again)] == ["Autophagy", "Loading"] and again.state("WB.app.results(b)") == results
    # the old copies stay until they are removed, and are not offered again
    assert len(again.page.evaluate("WB.store.list()")) == 2
    later = started(again.page)
    assert later.t("tree-old").count() == 0 and later.t("tree-remove-old").is_visible()
    later.click("tree-remove-old")
    later.click("confirm-ok")
    later.page.wait_for_function("document.querySelector('[data-t=tree-remove-old]') === null")
    assert later.page.evaluate("WB.store.list()") == [] and [f[0] for f in tree_shown(later)] == ["Autophagy", "Loading"]


def test_the_page_works_where_the_browser_stores_nothing(browser, blot_files):
    context = browser.new_context()
    context.add_init_script("Object.defineProperty(window, 'indexedDB', { get() { throw new Error('storage is blocked'); } })")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    ui = started(page)
    assert ui.t("save-status").inner_text() == "Not stored" and "Not stored" in ui.t("tree-store").inner_text()
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.saved()
    assert ui.state("b.session.lanes.length") == 8 and ui.t("save-status").inner_text() == "Not stored" and not errors
    context.close()


@pytest.fixture(scope="module")
def served():
    """The page from a web address, where the browser has folders of its own to stand in for one on disk."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *args: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/index.html"
    server.shutdown()


# The folder dialog cannot be driven by a test, so it is stood in for by a
# directory of the browser's own file system: the same kind of handle as a
# folder on disk gives, with the same functions.
PICKER = """window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });"""


def test_working_in_a_folder_on_disk(browser, browser_name, served, blot_files, blot):
    if browser_name != "chromium":
        pytest.skip("only Chrome and Edge let a page work in a folder on disk")
    context = browser.new_context()
    context.add_init_script(PICKER)
    ui = started(context.new_page(), served)
    ui.add_files(blot_files[0])
    ui.saved()
    assert "Kept in this browser" in ui.t("tree-store").inner_text() and ui.t("save-status").inner_text() == "Saved"
    kept = ui.files()

    # choose a folder: what the browser kept can come along
    ui.click("tree-choose")
    assert "Copy the 1 folder" in ui.confirm()
    ui.page.wait_for_function("document.querySelector('[data-t=tree-store]').textContent.includes('On disk: picked') && WB.state.blots.length === 1")
    ui.flush()
    assert ui.page.evaluate("WB.tree.store.kind") == "disk" and ui.files() == kept
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.add_files(blot_files[1])
    ui.saved()
    assert ui.t("save-status").inner_text() == "Saved to disk"
    # the files are in that folder, read here with the browser's own functions, not the page's
    listing = ui.page.evaluate(
        """async () => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked"); const out = [];
            const walk = async (dir, path) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") await walk(h, path + name + "/"); else out.push(path + name); } };
            await walk(root, ""); return out.sort(); }"""
    )
    assert listing == sorted(ui.files()) and "target/control/raw.tif" in listing and "target/target/lanes.png" in listing
    assert np.array_equal(tifffile.imread(io.BytesIO(file_bytes(ui, "target/target/raw.tif"))), blot["wb"])
    assert len(json.loads(ui.read("target/target/blot.json"))["lanes"]) == 8
    # renaming renames the directory there
    ui.state("(s.blots[1].name = 'Loading', WB.app.changed('blots'))")
    ui.saved()
    assert "target/Loading/raw.tif" in ui.files() and not any("/control/" in path for path in ui.files())

    # (That the folder is remembered after a reload is not tested here: the stand-in
    # directory cannot be asked for its permission, which a chosen folder is.)
    # back to the browser's own: its folder is still there, as it was when the other was chosen
    ui.click("tree-browser")
    ui.page.wait_for_function("document.querySelector('[data-t=tree-store]').textContent.includes('Kept in this browser') && WB.state.blots.length === 1")
    assert ui.page.evaluate("WB.tree.store.kind") == "browser" and ui.files() == kept
    context.close()
