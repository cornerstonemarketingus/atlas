from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class Tool(Protocol):
    """Protocol for agent tools."""

    name: str
    description: str

    def run(self, payload: str) -> str:
        ...


@dataclass(slots=True)
class SimpleTool:
    """Base class for concrete tools with metadata."""

    name: str
    description: str

    def run(self, payload: str) -> str:  # pragma: no cover
        raise NotImplementedError
