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


def main() -> int:
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
            # Fixed, and intentionally not configurable from the workflow. A
            # self-modifying agent that can merge its own changes can disable
            # its own safety rails and then keep running with them disabled.
            "merge_policy": "manual",
        },
    }
    json.dump(payload, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
