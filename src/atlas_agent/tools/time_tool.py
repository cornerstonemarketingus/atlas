from __future__ import annotations

from datetime import datetime, timezone

from .base import SimpleTool


class TimeTool(SimpleTool):
    def __init__(self) -> None:
        super().__init__(
            name="time",
            description="Return current UTC timestamp in ISO-8601 format",
        )

    def run(self, payload: str) -> str:
        _ = payload
        return datetime.now(timezone.utc).isoformat()
