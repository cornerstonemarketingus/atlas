"""Checks over the TODO.md item selector, run in CI and runnable locally.

    python3 .github/atlas/check-todo-selection.py

These assert the two properties that make autonomous self-improvement safe to
leave running: the agent is never handed a deferred decision or an acceptance
checklist entry as though it were work, and it is handed exactly one item.
The real TODO.md is used as a fixture at the end, because a parser that passes
on hand-written samples and misreads the actual file is worth nothing.
"""

import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from todo_selection import is_not_work, parse_items, select_item  # noqa: E402

def _load(name, filename):
    """Import a hyphenated sibling script, which a plain import cannot name."""
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).resolve().with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_dispatch = _load("build_dispatch", "build-dispatch.py")

TODO = pathlib.Path(__file__).resolve().parents[2] / "TODO.md"


class ParseItems(unittest.TestCase):
    def test_reads_unchecked_items_and_skips_completed_ones(self):
        items = parse_items("## Work\n\n- [ ] first\n- [x] done\n- [ ] second\n")
        self.assertEqual([item.text for item in items], ["first", "second"])
        self.assertEqual([item.section for item in items], ["Work", "Work"])
        self.assertEqual([item.line for item in items], [3, 5])

    def test_accepts_numbered_items_and_an_uppercase_mark(self):
        items = parse_items("## Work\n\n1. [ ] first\n2. [X] done\n")
        self.assertEqual([item.text for item in items], ["first"])

    def test_folds_a_wrapped_item_into_one_sentence(self):
        items = parse_items("## Work\n\n- [ ] a long item that\n      wraps over lines\n")
        self.assertEqual(items[0].text, "a long item that wraps over lines")

    def test_a_nested_item_is_not_folded_into_its_parent(self):
        # Item 7 of "Immediate next assignments" has a completed sub-item.
        # Folding the two would assign the parent with finished work appended.
        items = parse_items("## Work\n\n1. [ ] parent item\n   - [x] finished sub-item\n")
        self.assertEqual([item.text for item in items], ["parent item"])

    def test_a_nested_unchecked_item_is_not_assignable_on_its_own(self):
        items = parse_items("## Work\n\n1. [x] parent\n   - [ ] detail\n")
        self.assertEqual(items, [])

    def test_prose_between_items_does_not_join_them(self):
        items = parse_items("## Work\n\n- [ ] first\n\nSome prose.\n\n- [ ] second\n")
        self.assertEqual([item.text for item in items], ["first", "second"])

    def test_deferred_decisions_are_never_work(self):
        markdown = (
            "## Explicitly deferred decisions\n\n"
            "- [ ] Select the web framework only when the web milestone begins.\n"
        )
        self.assertEqual(parse_items(markdown), [])

    def test_the_definition_of_done_is_a_checklist_not_a_task(self):
        markdown = "## Definition of done for any checked item\n\n- [ ] Scope is documented.\n"
        self.assertEqual(parse_items(markdown), [])

    def test_a_non_work_section_ends_at_the_next_heading(self):
        markdown = (
            "## Explicitly deferred decisions\n\n- [ ] deferred\n\n"
            "## Phase 1\n\n- [ ] real work\n"
        )
        self.assertEqual([item.text for item in parse_items(markdown)], ["real work"])

    def test_heading_level_does_not_re_enable_a_non_work_section(self):
        self.assertEqual(parse_items("### Explicitly deferred decisions\n\n- [ ] deferred\n"), [])

    def test_a_parenthetical_in_the_heading_does_not_re_enable_it(self):
        # The real heading is "Remaining limitations (reviewed 2026-09-26)",
        # and that date is edited whenever the section is reviewed.
        markdown = "## Remaining limitations (reviewed 2026-09-26)\n\n- [ ] something\n"
        self.assertEqual(parse_items(markdown), [])

    def test_every_subsection_of_a_non_work_section_is_excluded(self):
        # "Remaining limitations" splits into subsections by owner. None of them
        # is work this agent can take: settings it cannot change, or items
        # already in progress on someone else's branch.
        markdown = (
            "## Remaining limitations (reviewed 2026-09-26)\n\n"
            "### Owner (settings only; no code)\n\n- [ ] set GROQ_API_KEY\n\n"
            "### Copilot (hosted web app)\n\n- [ ] rate limiting\n\n"
            "### Claude (local daemon and agent runtime)\n\n- [ ] daemon work\n\n"
            "### Queued (larger product work, one GitHub issue each)\n\n- [ ] tenant model\n"
        )
        self.assertEqual(parse_items(markdown), [])

    def test_renaming_a_subsection_does_not_re_enable_it(self):
        # Generic names like "Owner" and "Claude" invite renaming; the rule
        # lives on the parent so a rename cannot let items back in.
        markdown = (
            "## Remaining limitations\n\n"
            "### Somebody Else Entirely\n\n- [ ] not ours\n"
        )
        self.assertEqual(parse_items(markdown), [])

    def test_work_after_a_non_work_section_is_still_reachable(self):
        # The exclusion must end at the next heading of the same level, or
        # everything below it in the file would be lost.
        markdown = (
            "## Remaining limitations\n\n### Owner\n\n- [ ] settings\n\n"
            "## Phase 9 — local CLI product\n\n- [ ] real work\n"
        )
        self.assertEqual([item.text for item in parse_items(markdown)], ["real work"])

    def test_a_deeper_heading_inside_real_work_stays_selectable(self):
        markdown = "## Phase 1\n\n### Language intelligence\n\n- [ ] real work\n"
        self.assertEqual([item.section for item in parse_items(markdown)], ["Language intelligence"])

    def test_an_item_before_any_heading_still_parses(self):
        self.assertEqual([item.section for item in parse_items("- [ ] orphan\n")], [""])


class SelectItem(unittest.TestCase):
    def test_prefers_the_immediate_assignments_even_when_they_come_last(self):
        markdown = (
            "## Phase 1\n\n- [ ] phase work\n\n"
            "## Immediate next assignments\n\n1. [x] done\n2. [ ] the next assignment\n"
        )
        self.assertEqual(select_item(markdown).text, "the next assignment")

    def test_falls_through_to_document_order_once_the_assignments_are_finished(self):
        markdown = (
            "## Phase 1\n\n- [ ] phase work\n\n"
            "## Immediate next assignments\n\n1. [x] done\n"
        )
        self.assertEqual(select_item(markdown).text, "phase work")

    def test_returns_nothing_when_the_backlog_is_finished(self):
        self.assertIsNone(select_item("## Phase 1\n\n- [x] done\n"))

    def test_an_empty_file_selects_nothing(self):
        self.assertIsNone(select_item(""))

    def test_never_selects_from_a_non_work_section_even_when_it_is_all_that_is_left(self):
        markdown = (
            "## Phase 1\n\n- [x] done\n\n"
            "## Explicitly deferred decisions\n\n- [ ] Select cloud infrastructure.\n\n"
            "## Definition of done for any checked item\n\n- [ ] Scope is documented.\n"
        )
        self.assertIsNone(select_item(markdown))


class TheRealBacklog(unittest.TestCase):
    """The parser has to be right about this file, not just about samples."""

    def setUp(self):
        self.markdown = TODO.read_text(encoding="utf-8")

    def test_selects_exactly_one_item_and_it_is_real_work(self):
        item = select_item(self.markdown)
        self.assertIsNotNone(item, "TODO.md still has unchecked work")
        self.assertFalse(is_not_work(item.section), item)
        self.assertTrue(item.text.strip())

    def test_no_selectable_item_comes_from_a_non_work_section(self):
        owner_only = {"owner (settings only; no code)", "copilot (hosted web app)"}
        for item in parse_items(self.markdown):
            self.assertFalse(is_not_work(item.section), item)
            # These are real subsection names in TODO.md; they are excluded by
            # their parent, so seeing one here means ancestry tracking broke.
            self.assertNotIn(item.section.casefold(), owner_only, item)

    def test_every_selectable_item_is_a_single_folded_line(self):
        for item in parse_items(self.markdown):
            self.assertNotIn("\n", item.text, item)
            self.assertNotIn("  ", item.text, item)


class BuildObjective(unittest.TestCase):
    """The objective actually dispatched, assembled from the real files."""

    def test_names_the_selected_item_and_leaves_no_placeholder_behind(self):
        objective, note = build_dispatch.build_objective()
        item = select_item(TODO.read_text(encoding="utf-8"))
        self.assertIn(item.text, objective)
        self.assertIn(item.section, objective)
        self.assertIn(str(item.line), objective)
        for placeholder in ("{item}", "{section}", "{line}"):
            self.assertNotIn(placeholder, objective)
        self.assertIn(item.text, note)

    def test_stays_small_enough_for_the_model_budget(self):
        # The whole reason selection moved out of the prompt: TODO.md is about
        # eight thousand tokens and the free-tier ceiling is eight thousand per
        # minute, prompt and reply together. A run whose objective alone
        # approached that could never do any work.
        objective, _ = build_dispatch.build_objective()
        self.assertLess(len(objective), 4_000, "the objective is approaching the token budget again")
        self.assertNotIn("Phase 0", objective, "the objective is carrying the backlog again")


if __name__ == "__main__":
    unittest.main(verbosity=2)
