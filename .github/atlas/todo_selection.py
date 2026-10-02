"""Choosing the one TODO.md item a self-improvement run works on.

This used to be the model's job: the objective said "read TODO.md and pick an
item". That failed for two separate reasons, and moving the choice here fixes
both.

The first is cost. TODO.md is roughly eight thousand tokens. Groq's free tier
allows eight thousand tokens per minute, counting prompt and reply together, so
the moment the agent read the file its next request was refused outright with
HTTP 413 — before it had done any work at all. The agent does not need the
whole backlog to implement one item; it needs the item. Selecting here keeps
the file out of the prompt entirely.

The second is trust. Two sections of TODO.md are not work:

  - "Explicitly deferred decisions" are choices the repository has postponed
    on purpose until some precondition is met. An agent that "completes" one
    is making a decision nobody delegated to it.
  - "Definition of done for any checked item" is the acceptance checklist
    applied to every other item, not a task of its own.

Both read as small, concrete, unchecked items, which is exactly why prose
telling the model to avoid them is the wrong control: it is advice, checked by
nobody, on the far side of a network call. Here it is code with tests.

Run the checks with:

    python3 .github/atlas/check-todo-selection.py
"""

import re

# Headings whose unchecked items are not work, matched case-folded on a prefix
# so a parenthetical ("Remaining limitations (reviewed 2026-09-26)") or a change
# in heading level cannot silently re-enable one.
#
# "Remaining limitations" is the subtle one, and it is excluded as a whole
# rather than subsection by subsection. It is an ownership breakdown, not an
# open backlog: its children are "Owner (settings only; no code)" — repository
# settings no agent can change — plus "Copilot" and "Claude" items already
# assigned to other workers and in progress on their own branches, plus
# "Queued", which says in its own heading that each item is larger product work
# with its own GitHub issue. Picking from any of them means doing nothing,
# duplicating someone's half-finished branch, or starting a subsystem.
#
# Excluding the parent covers all four, and keeps covering them if the
# subsections are renamed — which generic names like "Owner" and "Claude"
# invite.
NOT_WORK_PREFIXES = (
    "explicitly deferred decisions",
    "definition of done for any checked item",
    "remaining limitations",
)


def is_not_work(heading):
    """True when this heading, by itself, marks its items as not work."""
    text = heading.casefold().strip()
    return any(text.startswith(prefix) for prefix in NOT_WORK_PREFIXES)

# Ordered on purpose: its items gate the phases below it, so an unchecked item
# here outranks anything later in the file.
PRIORITY_SECTION = "immediate next assignments"

HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
# A list item, bulleted or numbered. Only column zero: every unchecked item in
# this file is top-level, and a nested one is a detail of its parent rather
# than an independently assignable task.
ITEM = re.compile(r"^(?:-|\d+\.)\s+\[( |x|X)\]\s+(.*)$")
# A wrapped line belongs to the item above it: indented, and not itself a list
# item. The second half matters — a nested "- [x] ..." under item 7 is a
# sub-item of it, not a continuation of its sentence, and folding the two
# together would hand the agent an assignment with someone else's completed
# work spliced onto the end of it.
CONTINUATION = re.compile(r"^\s+\S")
NESTED_ITEM = re.compile(r"^\s+(?:-|\*|\d+\.)\s")


class TodoItem:
    """One checklist item, with the section it was found under."""

    def __init__(self, section, text, line):
        self.section = section
        self.text = text
        self.line = line

    def __repr__(self):
        return f"TodoItem(section={self.section!r}, text={self.text!r}, line={self.line})"

    def __eq__(self, other):
        return (
            isinstance(other, TodoItem)
            and (self.section, self.text, self.line) == (other.section, other.text, other.line)
        )


def parse_items(markdown):
    """Every unchecked top-level item, in document order, excluding non-work sections.

    Wrapped lines are folded into the item they continue, so an item that spans
    three lines arrives as one sentence rather than three fragments.
    """
    # Headings by level, so an item under "### Owner" still knows it sits
    # inside "## Remaining limitations". Excluding only the nearest heading
    # would let every subsection of an excluded section back in.
    ancestors = {}
    section = ""
    excluded = False
    items = []
    current = None

    def flush():
        nonlocal current
        if current is not None:
            current.text = " ".join(current.text.split())
            items.append(current)
            current = None

    for number, line in enumerate(markdown.splitlines(), start=1):
        heading = HEADING.match(line)
        if heading:
            flush()
            level = len(heading.group(1))
            section = heading.group(2)
            ancestors = {depth: text for depth, text in ancestors.items() if depth < level}
            ancestors[level] = section
            excluded = any(is_not_work(text) for text in ancestors.values())
            continue

        item = ITEM.match(line)
        if item:
            flush()
            if item.group(1) == " " and not excluded:
                current = TodoItem(section=section, text=item.group(2), line=number)
            continue

        if NESTED_ITEM.match(line):
            flush()
            continue

        if current is not None and CONTINUATION.match(line):
            current.text += " " + line.strip()
            continue

        # A blank line, prose, or anything else ends the item.
        flush()

    flush()
    return items


def select_item(markdown):
    """The single item to assign next, or None when the backlog is finished.

    An unchecked item under "Immediate next assignments" always wins: that list
    is ordered deliberately and its items gate the phases below it. Otherwise
    the first unchecked item in the file, which keeps successive runs moving
    down the document rather than re-picking at random.
    """
    items = parse_items(markdown)
    if not items:
        return None
    for item in items:
        if item.section.casefold() == PRIORITY_SECTION:
            return item
    return items[0]
