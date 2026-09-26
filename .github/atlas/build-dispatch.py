"""Builds the workflow_dispatch payload that aims the coder agent at this repository.

A script rather than inline shell because the objective is multi-line prose:
interpolating that into JSON by hand is exactly the kind of quoting that breaks
on the first apostrophe or newline someone adds to it.
"""

import json
import os
import pathlib
import sys

OBJECTIVE_FILE = pathlib.Path(__file__).with_name("self-improve-objective.md")

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


def main() -> int:
    try:
        policy = merge_policy()
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    override = os.environ.get("OBJECTIVE_OVERRIDE", "").strip()
    objective = override or OBJECTIVE_FILE.read_text(encoding="utf-8").strip()
    if not objective:
        print("No objective: the override was blank and the objective file is empty.", file=sys.stderr)
        return 1

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
