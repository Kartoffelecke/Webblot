"""Projects stored in the browser, and the library file that holds them all."""

import io
import json
import time
import zipfile

import pytest
from conftest import ALL_SECTIONS_OPEN, INDEX_URL, Ui

IMAGE_COUNT = """() => new Promise((resolve) => {
    const request = indexedDB.open("web_blot");
    request.onsuccess = () => {
        const count = request.result.transaction("images").objectStore("images").count();
        count.onsuccess = () => resolve(count.result);
    };
})"""


def save(ui):
    ui.flush()
    ui.page.evaluate("WB.library.saveNow()")


def started(page):
    """A page of the application, once it has opened what the browser stores."""
    page.add_init_script(ALL_SECTIONS_OPEN)
    page.goto(INDEX_URL)
    page.wait_for_function("window.WB && WB.library && WB.library.ready")
    page.evaluate("WB.library.ready")
    page.set_viewport_size({"width": 1500, "height": 950})
    ui = Ui(page)
    ui.flush()
    return ui


def stored(ui):
    return ui.page.evaluate("WB.store.list()")


def document(ui):
    return ui.state("JSON.stringify(WB.project.serialize())")


def library_names(ui):
    return ui.page.locator("[data-t=library-name]").evaluate_all("(fields) => fields.map((f) => f.value)")


def open_library(ui):
    """Press Projects… and wait for the list as it is now."""
    ui.t("projects").click()
    ui.page.wait_for_function("document.querySelector('[data-t=library]') && document.querySelector('[data-t=library]').open")


def message(ui, text):
    ui.page.wait_for_function("(text) => { const m = document.querySelector('[data-t=library-message]'); return m && m.textContent === text; }", arg=text)
    return True


def library_row(ui, name):
    return ui.page.locator("[data-t=library-row]").nth(library_names(ui).index(name))


def test_a_project_is_saved_as_it_changes_and_is_there_after_a_reload(ui, blot_files):
    assert stored(ui) == [] and ui.t("save-status").inner_text() == ""
    ui.add_files(*blot_files)
    ui.select_blot(0)
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.t("normalize").check()
    ui.state("(b.session.transform.gamma = 0.7, s.blots[1].session.transform.rotation_deg = 90, WB.app.rework(s.blots[1]), WB.app.changed('display'))")
    ui.flush()

    # nothing was pressed: the project is written a moment after the last change
    deadline = time.time() + 5
    while not stored(ui) and time.time() < deadline:
        time.sleep(0.05)
    assert [(p["name"], p["blots"]) for p in stored(ui)] == [("target", ["target", "control"])]
    ui.page.wait_for_function("document.querySelector('[data-t=save-status]').textContent === 'Saved'")

    ui.set("project-name", "LC3 time course")
    save(ui)
    before, results = document(ui), ui.state("WB.app.results(b)")
    assert stored(ui)[0]["name"] == "LC3 time course"

    again = started(ui.page)
    assert document(again) == before
    assert again.state("[s.project.name, s.normalize, s.blots.length, b.session.lanes.length]") == ["LC3 time course", True, 2, 8]
    assert again.state("WB.app.results(b)") == results
    assert again.state("[s.blots[1].work.wb.w, s.blots[1].work.wb.h]") == [420, 640]
    assert again.t("project-name").input_value() == "LC3 time course" and again.t("save-status").inner_text() == "Saved"
    assert again.page.locator("[data-t=card]").count() == 2
    # opening it did not write it again
    modified = stored(again)[0]["modified"]
    save(again)
    assert stored(again)[0]["modified"] == modified


def test_images_are_stored_once(ui, blot_files):
    ui.add_files(*blot_files)
    save(ui)
    assert ui.page.evaluate(IMAGE_COUNT) == 2
    first = stored(ui)[0]["modified"]

    # settings change the document, not the images; an area of a blot is the same image
    ui.state("(WB.app.newFromCrop(s.blots[0], [50, 60, 150, 600]), 0)")
    save(ui)
    assert stored(ui)[0]["modified"] > first and stored(ui)[0]["blots"] == ["target", "target 2", "control"]
    assert ui.page.evaluate(IMAGE_COUNT) == 2
    saved = json.loads(document(ui))
    assert len(saved["images"]) == 2 and saved["blots"][0]["wb"] == saved["blots"][1]["wb"] != saved["blots"][2]["wb"]

    # after a reload the two blots still are one image
    again = started(ui.page)
    assert again.state("s.blots[0].raw.wb === s.blots[1].raw.wb && s.blots[1].work.wb.h") == 100

    # an image no blot has any more is removed
    again.state("(WB.app.removeBlot(s.blots[2].id), 0)")
    save(again)
    assert again.page.evaluate(IMAGE_COUNT) == 1


def test_several_projects(ui, blot_files):
    assert ui.t("projects").is_enabled()
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    save(ui)
    open_library(ui)
    assert ui.t("library").is_visible() and library_names(ui) == ["target"]
    assert ui.t("library-current").is_visible() and ui.t("library-open").count() == 0

    # a new project; the one that was open stays
    ui.click("library-new")
    assert not ui.t("library").is_visible() and ui.state("s.blots.length") == 0
    ui.add_files(blot_files[1])
    save(ui)
    open_library(ui)
    assert library_names(ui) == ["control", "target"]

    # switch back
    ui.click("library-open")
    ui.page.wait_for_function("WB.state.blots.length === 1 && WB.state.blots[0].name === 'target'")
    ui.flush()
    assert not ui.t("library").is_visible() and ui.state("b.session.lanes.length") == 8
    assert ui.page.locator("[data-t=card]").count() == 1

    # rename the open project and another one
    open_library(ui)
    assert library_names(ui) == ["target", "control"] or library_names(ui) == ["control", "target"]
    rows = ui.page.locator("[data-t=library-row]")
    current = rows.filter(has=ui.page.locator("[data-t=library-current]")).locator("[data-t=library-name]")
    current.fill("Autophagy")
    current.dispatch_event("change")
    ui.page.wait_for_function("WB.state.project.name === 'Autophagy'")
    other = rows.filter(has=ui.page.locator("[data-t=library-open]")).locator("[data-t=library-name]")
    other.fill("Loading")
    other.dispatch_event("change")
    ui.page.wait_for_function("[...document.querySelectorAll('[data-t=library-name]')].some((f) => f.value === 'Loading')")
    assert sorted(p["name"] for p in stored(ui)) == ["Autophagy", "Loading"]
    ui.flush()
    assert ui.t("project-name").input_value() == "Autophagy"

    # duplicate, then delete the copy
    rows.filter(has=ui.page.locator("[data-t=library-open]")).locator("[data-t=library-duplicate]").click()
    ui.page.wait_for_function("document.querySelectorAll('[data-t=library-row]').length === 3")
    assert sorted(library_names(ui)) == ["Autophagy", "Loading", "Loading copy"]
    library_row(ui, "Loading copy").locator("[data-t=library-delete]").click()
    assert "Loading copy" in ui.t("confirm-text").inner_text()
    ui.click("confirm-cancel")  # nothing happens without a yes
    assert len(stored(ui)) == 3
    library_row(ui, "Loading copy").locator("[data-t=library-delete]").click()
    assert ui.t("confirm-ok").inner_text() == "Delete project"
    ui.click("confirm-ok")
    ui.page.wait_for_function("document.querySelectorAll('[data-t=library-row]').length === 2")
    assert sorted(library_names(ui)) == ["Autophagy", "Loading"]
    # the copy was a project of its own: the original still opens
    rows.filter(has=ui.page.locator("[data-t=library-open]")).locator("[data-t=library-open]").click()
    ui.page.wait_for_function("WB.state.blots.length === 1 && WB.state.blots[0].name === 'control'")

    # deleting the open project leaves an empty page
    open_library(ui)
    rows.filter(has=ui.page.locator("[data-t=library-current]")).locator("[data-t=library-delete]").click()
    ui.click("confirm-ok")
    ui.page.wait_for_function("document.querySelectorAll('[data-t=library-row]').length === 1")
    assert ui.state("s.blots.length") == 0 and [p["name"] for p in stored(ui)] == ["Autophagy"]
    ui.click("library-close")
    again = started(ui.page)
    assert again.state("s.blots.length") == 0  # the deleted project does not come back


def test_project_files_open_as_new_projects_and_older_files_still_open(ui, blot_files, tmp_path):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    save(ui)
    results = ui.state("WB.app.results(b)")
    current = json.loads(document(ui))
    assert current["version"] == ui.state("WB.model.PROJECT_VERSION")

    # the same project as version 4 wrote it: each image inside its blot, the line width in points
    old = {k: v for k, v in current.items() if k not in ("images", "name")}
    old["version"] = 4
    old["style"] = {k: v for k, v in current["style"].items() if k not in ("line_width_mm", "decrowd")} | {"line_width": 0.5}
    old["blots"] = [{**b, "wb": current["images"][b["wb"]]} for b in current["blots"]]
    path = tmp_path / "older.webblot.json"
    path.write_text(json.dumps(old))
    ui.state("(b.name = 'changed since', WB.app.changed('blots'))")
    ui.flush()

    ui.t("open-project").set_input_files(str(path))
    ui.page.wait_for_function("WB.state.blots.length === 1 && WB.state.blots[0].name === 'target'")
    save(ui)
    assert ui.state("WB.app.results(b)") == results
    assert ui.state("[s.style.line_width_mm, s.style.decrowd, 'line_width' in s.style]") == [pytest.approx(0.5 * 25.4 / 72), False, False]
    # what was open was stored first, and is still there beside the opened file
    assert sorted(p["name"] for p in stored(ui)) == ["changed since", "target"]

    # a file that is not a project leaves everything alone
    bad = tmp_path / "bad.webblot.json"
    bad.write_text("{}")
    ui.t("open-project").set_input_files(str(bad))
    assert "not a web_blot project" in ui.t("toast-error").inner_text()
    assert ui.state("s.blots[0].name") == "target" and len(stored(ui)) == 2
    # an error stays until it is closed
    ui.page.wait_for_timeout(300)
    ui.click("toast-close")
    assert ui.t("toast-error").count() == 0


def test_library_file_moves_all_projects_to_another_browser(ui, blot_files, browser, tmp_path):
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.set("lane-count", 8)
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.set("project-name", "Größe / LC3")
    save(ui)
    first_document, results = document(ui), ui.state("WB.app.results(b)")
    open_library(ui)
    ui.click("library-new")
    ui.add_files(blot_files[1])
    save(ui)
    open_library(ui)
    download = ui.download("library-export-all")
    assert download.suggested_filename.startswith("web_blot_library_") and download.suggested_filename.endswith(".webblot.zip")
    assert message(ui, "Exported 2 projects.")
    path = tmp_path / download.suggested_filename
    download.save_as(path)

    # an ordinary zip file of ordinary project files, and a list of them
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        listing = json.loads(archive.read("library.json"))
        assert listing["app"] == "web_blot" and listing["kind"] == "library"
        assert sorted(p["name"] for p in listing["projects"]) == ["Größe / LC3", "control"]
        assert sorted(archive.namelist()) == sorted(["library.json"] + [p["file"] for p in listing["projects"]])
        files = {p["name"]: archive.read(p["file"]) for p in listing["projects"]}
        assert json.loads(files["Größe / LC3"]) == json.loads(first_document)

    # another browser: nothing there, then everything
    context = browser.new_context()
    other = started(context.new_page())
    errors = []
    other.page.on("pageerror", lambda exc: errors.append(str(exc)))
    assert stored(other) == []
    open_library(other)
    other.t("library-import-file").set_input_files(str(path))
    other.page.wait_for_function("document.querySelectorAll('[data-t=library-row]').length === 2")
    assert message(other, "2 projects added.")
    assert [(p["id"], p["name"], p["modified"]) for p in stored(other)] == [(p["id"], p["name"], p["modified"]) for p in stored(ui)]
    library_row(other, "Größe / LC3").locator("[data-t=library-open]").click()
    other.page.wait_for_function("WB.state.blots.length === 1")
    other.flush()
    assert document(other) == first_document and other.state("WB.app.results(b)") == results

    # importing again adds nothing; a project that has changed here is kept, and the file's is added beside it
    open_library(other)
    other.t("library-import-file").set_input_files(str(path))
    assert message(other, "0 projects added, 2 already here.")
    other.click("library-close")
    other.state("(b.name = 'edited here', WB.app.changed('blots'))")
    save(other)
    open_library(other)
    other.t("library-import-file").set_input_files(str(path))
    other.page.wait_for_function("document.querySelectorAll('[data-t=library-row]').length === 3")
    assert message(other, "1 project added, 1 already here.")
    assert sorted(library_names(other)) == ["Größe / LC3", "Größe / LC3 (imported)", "control"]
    assert sorted(p["blots"][0] for p in stored(other)) == ["control", "edited here", "target"]

    # a zip somebody made of project files, uncompressed and without the list, also works
    plain = tmp_path / "by_hand.zip"
    with zipfile.ZipFile(plain, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("somewhere/mine.webblot.json", files["control"])
        archive.writestr("notes.txt", "not a project")
    other.t("library-import-file").set_input_files(str(plain))
    other.page.wait_for_function("document.querySelectorAll('[data-t=library-row]').length === 4")
    assert message(other, "1 project added.")
    assert sorted(library_names(other)) == ["Größe / LC3", "Größe / LC3 (imported)", "control", "mine"]

    # something else
    other.t("library-import-file").set_input_files({"name": "x.zip", "mimeType": "application/zip", "buffer": b"nothing"})
    other.page.wait_for_function("document.querySelector('[data-t=library-message]').textContent.includes('not a zip')")
    assert len(stored(other)) == 4 and not errors
    context.close()


def test_zip_files_are_read_back_as_written(ui):
    got = ui.page.evaluate(
        """async () => {
            const big = new Uint8Array(300000).map((_, i) => (i * 7919) % 251);
            const blob = WB.zip.write([{ name: "a/ä.txt", data: "häagen" }, { name: "b.bin", data: big }, { name: "empty", data: "" }]);
            const entries = WB.zip.read(await blob.arrayBuffer());
            const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
            return [entries.map((e) => e.name), new TextDecoder().decode(entries[0].data),
                entries[1].data.length === big.length && entries[1].data.every((v, i) => v === big[i]), entries[2].data.length,
                WB.zip.crc32(new TextEncoder().encode("123456789")), bytes];
        }"""
    )
    assert got[:5] == [["a/ä.txt", "b.bin", "empty"], "häagen", True, 0, 0xCBF43926]
    with zipfile.ZipFile(io.BytesIO(bytes(got[5]))) as archive:
        assert archive.testzip() is None and archive.read("a/ä.txt").decode() == "häagen" and len(archive.read("b.bin")) == 300000


def test_the_page_works_where_the_browser_stores_nothing(browser, blot_files):
    context = browser.new_context()
    context.add_init_script("Object.defineProperty(window, 'indexedDB', { get() { throw new Error('storage is blocked'); } })")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    ui = started(page)
    assert ui.t("save-status").inner_text() == "Not stored" and not ui.t("projects").is_enabled()
    ui.add_files(blot_files[0])
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.flush()
    ui.page.evaluate("WB.library.saveNow()")
    assert ui.state("b.session.lanes.length") == 8 and ui.t("save-status").inner_text() == "Not stored"
    # project files are what is left; opening one asks before it replaces the blots
    saved = ui.download("save-project")
    ui.state("(b.name = 'other', 0)")
    ui.t("open-project").set_input_files(saved.path())
    assert "closes the blots" in ui.confirm()
    page.wait_for_function("WB.state.blots[0].name === 'target'")
    assert not errors
    context.close()


def test_two_tabs_do_not_overwrite_each_other(ui):
    ui.click("add-sample")
    save(ui)
    second = started(ui.page.context.new_page())
    assert second.state("[s.project.id, s.blots.length]") == [ui.state("s.project.id"), 1]

    ui.state("(b.name = 'from the first tab', WB.app.changed('blots'))")
    save(ui)
    second.state("(b.name = 'from the second tab', WB.app.changed('blots'))")
    save(second)
    assert "Changed in another tab" in second.t("save-status").inner_text()
    assert [p["blots"] for p in stored(ui)] == [["from the first tab"]]
    # nothing is written while this is open
    second.state("(b.session.transform.gamma = 2, WB.app.changed('display'))")
    save(second)
    assert [p["blots"] for p in stored(ui)] == [["from the first tab"]]

    # Reload takes what is stored
    second.click("conflict-reload")
    second.page.wait_for_function("WB.state.blots[0].name === 'from the first tab'")
    second.flush()
    assert second.t("save-status").inner_text() == "Saved"
    second.state("(b.name = 'second, after reload', WB.app.changed('blots'))")
    save(second)
    assert [p["blots"] for p in stored(ui)] == [["second, after reload"]]

    # now the first tab is behind; it keeps its state as a copy
    ui.state("(b.name = 'first again', WB.app.changed('blots'))")
    save(ui)
    assert "Changed in another tab" in ui.t("save-status").inner_text()
    ui.click("conflict-copy")
    ui.page.wait_for_function("document.querySelector('[data-t=save-status]').textContent === 'Saved'")
    assert sorted((p["name"], p["blots"][0]) for p in stored(ui)) == [("first again copy", "first again"), ("second, after reload", "second, after reload")]
    assert ui.state("s.project.id") != second.state("s.project.id")
