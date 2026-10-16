"""The page as it presents itself: first use, steps, sections, themes, messages."""

import re

import pytest
from conftest import INDEX_URL, NO_TOUR, Ui


def first_visit(page):
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.set_viewport_size({"width": 1500, "height": 950})
    page.goto(INDEX_URL)
    page.wait_for_function("window.WB && WB.library && WB.library.ready")
    page.evaluate("WB.library.ready")
    return Ui(page), errors


@pytest.fixture
def fresh(page):
    """The page as somebody finds it who was never here: nothing stored, no setting made
    (but for the tour, which test_a_first_visit_gets_a_tour is about)."""
    page.add_init_script(NO_TOUR)
    ui, errors = first_visit(page)
    yield ui
    assert not errors


def test_a_first_visit_gets_a_tour(page):
    page.emulate_media(reduced_motion="reduce")  # the lit part is where it goes, not on its way there
    ui, errors = first_visit(page)
    tour = ui.t("tour")
    tour.wait_for()
    assert "1 of 7" in ui.t("tour-count").inner_text() and "Welcome" in ui.t("tour-title").inner_text()
    # the page under it cannot be used meanwhile
    assert ui.page.evaluate("document.querySelector('[data-t=tour]').matches(':modal')")
    # each stop lights its part of the page, with the card beside it and on screen
    lit = {2: "add-blots", 6: "help"}
    for n in range(2, 8):
        ui.click("tour-next")
        assert ui.t("tour-count").inner_text() == f"{n} of 7"
        card = ui.rect(ui.t("tour-card"))
        assert card["x"] >= 0 and card["y"] >= 0 and card["x"] + card["width"] <= 1500 and card["y"] + card["height"] <= 950
        if n in lit:
            spot, part = ui.rect(ui.t("tour-spot")), ui.rect(ui.t(lit[n]))
            assert spot["x"] <= part["x"] and part["x"] + part["width"] <= spot["x"] + spot["width"]
            assert spot["y"] <= part["y"] and part["y"] + part["height"] <= spot["y"] + spot["height"]
    # the arrow keys go back and forth; the last stop offers the sample
    ui.page.keyboard.press("ArrowLeft")
    assert ui.t("tour-count").inner_text() == "6 of 7"
    ui.page.keyboard.press("ArrowRight")
    ui.click("tour-sample")
    tour.wait_for(state="detached")
    ui.flush()
    assert ui.state("s.blots.length") == 1
    # once is enough: not again after a reload
    ui.page.reload()
    ui.page.evaluate("WB.library.ready")
    ui.flush()
    assert ui.t("tour").count() == 0
    # the help offers it again, and Esc or Skip closes it
    ui.click("help")
    ui.click("help-tour")
    tour.wait_for()
    assert ui.t("help-dialog").count() == 0 and "1 of 7" in ui.t("tour-count").inner_text()
    ui.page.keyboard.press("Escape")
    tour.wait_for(state="detached")
    ui.click("help")
    ui.click("help-tour")
    ui.click("tour-skip")
    tour.wait_for(state="detached")
    assert not errors


def test_an_empty_page_offers_the_ways_to_begin(fresh):
    ui = fresh
    assert ui.t("welcome").is_visible()
    for choice in ("welcome-add", "welcome-sample", "welcome-open"):
        assert ui.t(choice).is_visible()
    # nothing to set yet: no empty panel beside it
    assert not ui.page.locator("#side").is_visible() and not ui.t("side-bar").is_visible()
    ui.click("welcome-sample")
    ui.flush()
    assert ui.state("s.blots.length") == 1 and ui.t("welcome").count() == 0
    assert ui.page.locator("#side").is_visible() and ui.t("selected-name").inner_text() == "Sample 1"
    # removing the last blot brings it back
    ui.click("blot-remove")
    ui.flush()
    assert ui.t("welcome").is_visible() and not ui.page.locator("#side").is_visible()


def test_the_steps_are_the_navigation_and_show_what_is_done(fresh):
    ui = fresh
    ui.click("welcome-sample")
    ui.flush()

    def steps():
        return ui.page.locator("button.step").evaluate_all("(all) => all.map((b) => [b.dataset.step, b.classList.contains('active'), b.classList.contains('done')])")

    assert steps() == [["prepare", True, False], ["lanes", False, False], ["quantify", False, False], ["figure", False, False]]
    assert ui.page.locator(".side-head .step-title").inner_text().upper() == "STEP 1 · PREPARE"
    # the button at the end of a panel leads on
    assert ui.t("next-step").inner_text().strip() == "Next: Lanes"
    ui.click("next-step")
    ui.flush()
    assert ui.state("s.tab") == "lanes" and steps()[0] == ["prepare", False, True]
    ui.click("detect-lanes")
    ui.flush()
    # keys 1 to 4, unless something is being typed
    ui.page.locator("body").press("3")
    ui.flush()
    assert ui.state("s.tab") == "quantify" and steps()[1] == ["lanes", False, True] and steps()[2] == ["quantify", True, False]
    ui.t("bg-radius").focus()
    ui.page.keyboard.press("1")
    ui.flush()
    assert ui.state("s.tab") == "quantify"
    ui.click("detect-all")
    ui.flush()
    ui.page.locator("body").press("4")
    ui.flush()
    assert steps() == [["prepare", False, True], ["lanes", False, True], ["quantify", False, True], ["figure", True, False]]
    assert ui.t("next-step").count() == 0
    # each step names its usual action
    for step, action in (("lanes", "detect-lanes"), ("quantify", "detect-all"), ("figure", "export-svg")):
        ui.tab(step)
        assert "primary" in ui.t(action).get_attribute("class")


def test_sections_fold_and_stay_as_they_were_left(fresh):
    ui = fresh
    ui.click("welcome-sample")
    ui.flush()
    section = lambda title: ui.page.locator(f'section.group[data-group="{title}"]')
    # what is seldom needed is folded at first
    assert not ui.t("bands-dark").is_visible() and ui.t("angle").is_visible()
    assert section("Signal").locator("[data-t=group-head]").get_attribute("aria-expanded") == "false"
    section("Signal").locator("[data-t=group-head]").click()
    section("Rotate").locator("[data-t=group-head]").click()
    assert ui.t("bands-dark").is_visible() and not ui.t("angle").is_visible()
    # the panel is rebuilt all the time: the sections stay as they are
    ui.t("bands-dark").check()
    ui.flush()
    assert ui.t("bands-dark").is_visible() and not ui.t("angle").is_visible() and ui.state("b.session.transform.bands_dark") is True
    ui.page.evaluate("WB.library.saveNow()")
    ui.page.reload()
    ui.page.evaluate("WB.library.ready")
    ui.flush()
    assert ui.t("bands-dark").is_visible() and not ui.t("angle").is_visible()


def luminance(colour):
    r, g, b = (int(v) / 255 for v in re.findall(r"\d+", colour)[:3])
    lin = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


RESOLVE = """(pairs) => pairs.map(([fg, bg]) => { const probe = document.createElement("span"); document.body.append(probe);
    const read = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const out = [read(fg), read(bg)]; probe.remove(); return out; })"""
PAIRS = [("--text", "--surface"), ("--text", "--bg"), ("--text-2", "--surface"), ("--text-2", "--bg"), ("--text-3", "--surface"), ("--text-3", "--surface-2"),
         ("--accent", "--surface"), ("--accent", "--accent-soft"), ("--accent-text", "--accent"), ("--danger", "--surface"), ("--ok", "--ok-soft")]


def test_light_and_dark(fresh):
    ui = fresh
    page = ui.page
    background = "getComputedStyle(document.body).backgroundColor"
    light = page.evaluate(background)
    assert luminance(light) > 0.8 and page.evaluate("document.documentElement.dataset.theme") is None
    for theme in ("light", "dark"):
        if theme == "dark":
            ui.click("theme")
            assert page.evaluate("document.documentElement.dataset.theme") == "dark" and luminance(page.evaluate(background)) < 0.05
        # text can be read: at least 4.5 to 1 against what it stands on
        for (fg, bg), (a, b) in zip(PAIRS, page.evaluate(RESOLVE, PAIRS)):
            assert contrast(a, b) >= 4.5, (theme, fg, bg, round(contrast(a, b), 2))
    # the choice is kept
    page.reload()
    page.evaluate("WB.library.ready")
    assert page.evaluate("document.documentElement.dataset.theme") == "dark" and luminance(page.evaluate(background)) < 0.05
    ui.click("theme")
    assert page.evaluate(background) == light and page.evaluate("document.documentElement.dataset.theme") is None
    # without a choice the page follows the system
    page.emulate_media(color_scheme="dark")
    assert luminance(page.evaluate(background)) < 0.05
    # the figure is on white either way: it is what will be printed
    ui.click("welcome-sample")
    ui.tab("figure")
    assert page.evaluate("getComputedStyle(document.querySelector('[data-t=preview]')).backgroundColor") == "rgb(255, 255, 255)"


def test_removing_lanes_can_be_undone(ui):
    ui.click("add-sample")
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.tab("lanes")
    ui.state("(WB.app.select(b.id, 2), 0)")
    ui.flush()
    table = ui.state("WB.app.results(b).rows")
    ui.page.locator("body").press("Delete")
    ui.flush()
    assert ui.state("b.session.lanes.length") == 7 and "lane 3" in ui.t("toast").inner_text()
    ui.click("toast-action")
    ui.flush()
    assert ui.state("[b.session.lanes.length, s.lane]") == [8, 2] and ui.state("WB.app.results(b).rows") == table
    ui.click("lane-clear")
    ui.flush()
    assert ui.state("b.session.lanes.length") == 0 and "all 8 lanes" in ui.t("toast").inner_text()
    ui.click("toast-action")
    ui.flush()
    assert ui.state("WB.app.results(b).rows") == table and ui.page.locator("[data-t=lane]").count() == 8
    # without the undo the message goes by itself; an error stays
    ui.click("lane-delete")
    ui.choose("lane-method", "even")
    ui.set("lane-count", 0)
    ui.click("detect-lanes")
    assert "number of lanes" in ui.t("toast-error").inner_text() and ui.state("b.session.lanes.length") == 7


def test_help_lists_what_mouse_and_keys_do(ui):
    ui.click("add-sample")
    ui.flush()
    ui.page.locator("body").press("?")
    dialog = ui.t("help-dialog")
    assert dialog.is_visible() and "Double-click the band" in dialog.inner_text() and dialog.locator("kbd").count() > 5
    # keys do not reach the page behind it
    ui.page.keyboard.press("3")
    assert ui.state("s.tab") == "prepare"
    ui.page.keyboard.press("Escape")
    ui.t("help-dialog").wait_for(state="detached")
    ui.click("help")
    ui.click("help-close")
    ui.t("help-dialog").wait_for(state="detached")


def test_a_question_before_what_cannot_be_undone(ui, blot_files):
    ui.add_files(*blot_files)
    ui.select_blot(0)
    ui.tab("lanes")
    ui.click("detect-lanes")
    ui.tab("quantify")
    ui.click("detect-all")
    ui.tab("prepare")
    peaks = ui.state("b.session.lanes[0].peaks.length")
    ui.choose("copy-from", str(ui.state("s.blots[1].id")))
    # the button says what will happen; Escape and Cancel leave everything alone
    assert ui.t("confirm-ok").inner_text() == "Replace lanes" and "peaks" in ui.t("confirm-text").inner_text()
    ui.page.keyboard.press("Escape")
    ui.flush()
    assert ui.t("confirm").count() == 0 and ui.state("b.session.lanes[0].peaks.length") == peaks
    ui.choose("copy-from", str(ui.state("s.blots[1].id")))
    ui.confirm()
    assert ui.state("b.session.lanes.length") == 0
