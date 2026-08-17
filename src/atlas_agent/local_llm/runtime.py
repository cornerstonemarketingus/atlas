from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, Optional

import torch

from .model import ModelConfig, TinyTransformer, decode_tokens, encode_text


class LocalLLMRuntime:
    def __init__(self, model_path: str | Path, device: Optional[str] = None) -> None:
        self.model_path = Path(model_path)
        self.device = self._select_device(device)
        self.model: TinyTransformer
        self.stoi: Dict[str, int]
        self.itos: Dict[int, str]
        self.config: ModelConfig
        self._load()

    def _select_device(self, requested: Optional[str]) -> torch.device:
        if requested is None or requested == "auto":
            if torch.cuda.is_available():
                return torch.device("cuda")
            return torch.device("cpu")
        return torch.device(requested)

    def _load(self) -> None:
        if not self.model_path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {self.model_path}")

        checkpoint: Dict[str, Any] = torch.load(self.model_path, map_location=self.device)
        raw_config = checkpoint["config"]
        self.config = ModelConfig(**raw_config)
        self.stoi = checkpoint["stoi"]
        self.itos = {int(k): v for k, v in checkpoint["itos"].items()}

        self.model = TinyTransformer(self.config)
        self.model.load_state_dict(checkpoint["model_state"])
        self.model.to(self.device)
        self.model.eval()

    def metadata(self) -> Dict[str, Any]:
        return {
            "model_path": str(self.model_path),
            "device": str(self.device),
            "config": asdict(self.config),
            "vocab_size": len(self.stoi),
        }

    def generate(
        self,
        prompt: str,
        max_new_tokens: int = 120,
        temperature: float = 0.9,
        top_k: int = 40,
    ) -> str:
        prompt_ids = encode_text(prompt, self.stoi).unsqueeze(0).to(self.device)
        output_ids = self.model.generate(
            idx=prompt_ids,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_k=top_k,
        )

        output_text = decode_tokens(output_ids[0].cpu(), self.itos)
        return output_text
