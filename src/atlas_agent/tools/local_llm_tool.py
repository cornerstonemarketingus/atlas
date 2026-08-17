from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from .base import SimpleTool


class LocalLLMTool(SimpleTool):
    def __init__(self, model_path: Optional[str] = None) -> None:
        super().__init__(
            name="local-llm",
            description="Generate text with your own locally trained model",
        )
        self.model_path = Path(model_path or os.getenv("ATLAS_LOCAL_MODEL_PATH", "models/local_llm.pt"))
        self._runtime = None

    def _load_runtime(self):
        if self._runtime is not None:
            return self._runtime

        try:
            from atlas_agent.local_llm.runtime import LocalLLMRuntime
        except ModuleNotFoundError:
            return None

        self._runtime = LocalLLMRuntime(model_path=self.model_path)
        return self._runtime

    def run(self, payload: str) -> str:
        prompt = payload.strip()
        if not prompt:
            return "Usage: run local-llm <prompt>"

        if not self.model_path.exists():
            return (
                f"Model checkpoint not found at {self.model_path}. "
                "Train one locally with: python -m atlas_agent.local_llm.train --corpus data/corpus.txt"
            )

        runtime = self._load_runtime()
        if runtime is None:
            return (
                "PyTorch is not installed. Install it locally, then retry. "
                "See https://pytorch.org/get-started/locally/ for wheel selection."
            )

        output = runtime.generate(prompt=prompt)
        return output
