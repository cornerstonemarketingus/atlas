from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(slots=True)
class AgentConfig:
    """Runtime configuration loaded from environment variables."""

    name: str = "atlas"
    prompt_prefix: str = "atlas> "

    @classmethod
    def from_env(cls) -> "AgentConfig":
        return cls(
            name=os.getenv("ATLAS_AGENT_NAME", "atlas"),
            prompt_prefix=os.getenv("ATLAS_PROMPT_PREFIX", "atlas> "),
        )
