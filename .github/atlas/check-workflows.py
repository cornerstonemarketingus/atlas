"""Static checks over the workflow files, run in CI and runnable locally.

A workflow GitHub refuses to parse fails with ZERO jobs and no useful message.
That has now cost this repository three silent failures, so the checks live in
a file that can be run by hand before pushing:

    python3 .github/atlas/check-workflows.py

The third check exists because the first two are not enough. A workflow can be
valid YAML with valid shell in every step and still be rejected, because
GitHub scans `run:` blocks for its own ${...} expression syntax before any
YAML-level concern. A literal opening delimiter inside a script — in a regex,
a sed command, or a string being searched for it — opens an expression that
never closes. That is exactly how this file's own predecessor failed.
"""

import pathlib
import subprocess
import sys

import yaml

WORKFLOWS = pathlib.Path(__file__).resolve().parents[1] / "workflows"

# Assembled rather than written literally, because writing the delimiter in
# source is the very thing being detected.
OPEN = "$" + "{{"
CLOSE = "}" + "}"


def check_yaml(path: pathlib.Path) -> tuple[dict | None, list[str]]:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")), []
    except yaml.YAMLError as error:
        return None, [f"{path.name}: not valid YAML\n{error}"]


def substitute_expressions(script: str) -> str:
    """Replace whole Actions expressions with a placeholder, and nothing else.

    Substituting the delimiters independently is what a first version did, and
    it corrupts valid shell: a closing delimiter is two closing braces, which is
    also how a nested parameter expansion ends. `${A:-${B:-}}` became `${A:-${B:-}`
    and every such step was reported as a syntax error it did not have — a
    checker crying wolf about correct code is worse than no checker, because the
    fix is to mangle working shell until the tool stops complaining.

    Spans are matched from an opening delimiter to its first closing one, the
    same way check_expressions reads them.
    """
    parts = []
    cursor = 0
    while (start := script.find(OPEN, cursor)) != -1:
        end = script.find(CLOSE, start + len(OPEN))
        if end == -1:
            # Unclosed. check_expressions reports it with a better message;
            # here the rest is passed through untouched.
            break
        parts.append(script[cursor:start])
        parts.append("${__ACTIONS_EXPR__}")
        cursor = end + len(CLOSE)
    parts.append(script[cursor:])
    return "".join(parts)


def check_shell(path: pathlib.Path, document: dict) -> list[str]:
    failures = []
    for job_name, job in (document.get("jobs") or {}).items():
        for index, step in enumerate(job.get("steps") or []):
            script = step.get("run")
            if not script:
                continue
            shell = str(step.get("shell") or "bash").lower()
            if not (shell.startswith("bash") or shell.startswith("sh")):
                # bash -n reports valid PowerShell as broken. Platform-specific
                # scripts are parsed in their native CI job instead.
                continue
            # Actions substitutes expressions before bash ever sees them, so a
            # placeholder keeps the script's shape without inventing a value.
            probe = substitute_expressions(script)
            result = subprocess.run(["bash", "-n"], input=probe, text=True, capture_output=True)
            if result.returncode != 0:
                label = step.get("name") or f"step {index + 1}"
                failures.append(f"{path.name} :: {job_name} :: {label}\n{result.stderr.strip()}")
    return failures


ADVICE = (
    "GitHub rejects the entire workflow for this — zero jobs, no message, and a run "
    "named after the file path instead of the workflow. If the delimiter is meant as "
    "literal text inside a script, move that script into its own file and call it from "
    "the workflow instead of embedding it."
)


def check_expressions(path: pathlib.Path) -> list[str]:
    """Validate every Actions ${...} expression the file opens.

    Two ways this goes wrong, both fatal to the whole workflow:

    1. The expression is never closed.
    2. The expression closes, but its contents are not valid expression syntax.
       The decisive marker is a double quote: Actions expressions quote strings
       with SINGLE quotes only, so a double quote inside one means the delimiter
       was almost certainly literal text in an embedded script that GitHub is
       now trying to evaluate as code.

    The second case is the one that actually broke this repository, and it is
    invisible to a YAML parser — the file is perfectly well-formed YAML.
    """
    failures = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        cursor = 0
        while (start := line.find(OPEN, cursor)) != -1:
            end = line.find(CLOSE, start + len(OPEN))
            if end == -1:
                failures.append(
                    f"{path.name}:{number}: an Actions expression is opened and never closed. "
                    f"{ADVICE}\n    {line.strip()}"
                )
                break
            body = line[start + len(OPEN):end]
            if '"' in body:
                failures.append(
                    f"{path.name}:{number}: an Actions expression contains a double quote, so it "
                    f"is not valid expression syntax (Actions uses single quotes). {ADVICE}\n"
                    f"    expression: {OPEN}{body}{CLOSE}"
                )
            cursor = end + len(CLOSE)
    return failures


def main() -> int:
    paths = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    if not paths:
        print(f"No workflows found under {WORKFLOWS}.", file=sys.stderr)
        return 1

    failures: list[str] = []
    for path in paths:
        document, problems = check_yaml(path)
        failures.extend(problems)
        if document is None:
            continue
        failures.extend(check_expressions(path))
        if isinstance(document, dict):
            failures.extend(check_shell(path, document))
        if not problems:
            print(f"ok  {path.name}")

    if failures:
        print("\n" + "\n\n".join(failures), file=sys.stderr)
        print(f"\n{len(failures)} problem(s) found.", file=sys.stderr)
        return 1

    print(f"\nAll {len(paths)} workflows parse, and every shell step is valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
