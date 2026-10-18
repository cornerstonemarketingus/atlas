# Dogfood log

`log.jsonl` is the append-only record of Atlas-on-Atlas tasks (PROGRAM 2.2).
Each line is hash-chained to the one before, so an edited, removed or reordered
line fails `atlas-eval dogfood check`. Do not edit it by hand; append with the
CLI. It starts empty: entries are real outcomes, never estimates, and token
counts come from the run's own receipt. See `docs/EVALS.md`.
