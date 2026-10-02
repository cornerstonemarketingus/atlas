"""Builds the workflow_dispatch payload that aims the coder agent at this repository.

A script rather than inline shell because the objective is multi-line prose:
interpolating that into JSON by hand is exactly the kind of quoting that breaks
on the first apostrophe or newline someone adds to it.

The objective template carries {item}, {section} and {line} placeholders, filled
here from todo_selection.select_item, so the agent is handed one assignment
rather than the whole backlog. See todo_selection.py for why the choice is made
here instead of in the model's prompt.
"""

import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from todo_selection import select_item  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
OBJECTIVE_FILE = HERE / "self-improve-objective.md"
TODO_FILE = HERE.parents[1] / "TODO.md"

# The owner chose autopilot: self-improvement merges its own change once every
# CI check on the pull request passes. "none" (merge without checks) is refused
# for self-modification: a change that breaks CI must never land on main, and
# the regression guard in create-coder-pull-request.mjs still holds a change
# its own verification measured as broken. Set the repository variable
# ATLAS_SELF_IMPROVE_MERGE_POLICY=manual to go back to human review.
SELF_IMPROVE_POLICIES = {"manual", "ci-gated"}
DEFAULT_SELF_IMPROVE_POLICY = "ci-gated"


def merge_policy() -> str:
    value = os.environ.get("SELF_IMPROVE_MERGE_POLICY", "").strip() or DEFAULT_SELF_IMPROVE_POLICY
    if value not in SELF_IMPROVE_POLICIES:
        raise ValueError(f"SELF_IMPROVE_MERGE_POLICY must be one of {sorted(SELF_IMPROVE_POLICIES)}, not {value!r}.")
    return value


def build_objective():
    """The committed objective with this run's assignment substituted in.

    Returns (objective, note) — note is a line for the run log naming what was
    assigned, so a run's choice is visible without opening the payload.
    """
    template = OBJECTIVE_FILE.read_text(encoding="utf-8").strip()
    if not template:
        raise ValueError("The objective file is empty.")

    if "{item}" not in template:
        # An objective that names no item needs no selection; honour it as
        # written rather than silently ignoring half the template.
        return template, "Objective: the committed objective, which selects no TODO.md item."

    item = select_item(TODO_FILE.read_text(encoding="utf-8"))
    if item is None:
        raise ValueError(
            f"No unchecked work item remains in {TODO_FILE.name}. "
            "Nothing to assign: add an item or stop the loop."
        )

    # Explicit replacement rather than str.format: the template is prose that
    # people edit, and one literal brace in it would otherwise turn a routine
    # wording change into a failed dispatch.
    objective = template
    for placeholder, value in (("{item}", item.text), ("{section}", item.section), ("{line}", str(item.line))):
        objective = objective.replace(placeholder, value)
    return objective, f"Assigned: {item.text} (TODO.md:{item.line}, under '{item.section}')"


def main() -> int:
    try:
        policy = merge_policy()
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    override = os.environ.get("OBJECTIVE_OVERRIDE", "").strip()
    if override:
        objective = override
        note = "Objective: the dispatch override, not the committed objective."
    else:
        try:
            objective, note = build_objective()
        except (OSError, ValueError, KeyError) as error:
            print(f"Could not build the objective: {error}", file=sys.stderr)
            return 1

    # stderr, because stdout is the payload the caller pipes into curl.
    print(note, file=sys.stderr)

    payload = {
        "ref": "main",
        "inputs": {
            # Unique per attempt, so re-running is a distinct task rather than
            # colliding with the run it is retrying.
            "task_id": f"{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}",
            "repository": os.environ["REPOSITORY"],
            "branch": "main",
            "mode": "coder",
            "objective": objective,
            # From a repository variable, never a dispatch input: the agent
            # being dispatched cannot choose how its own change is merged.
            "merge_policy": policy,
        },
    }
    json.dump(payload, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
