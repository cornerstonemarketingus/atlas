from __future__ import annotations

import argparse
from dataclasses import asdict
from pathlib import Path
from typing import Tuple

import torch

from .model import ModelConfig, TinyTransformer, build_vocab


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a tiny local-only language model")
    parser.add_argument("--corpus", type=Path, required=True, help="Path to training text")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("models/local_llm.pt"),
        help="Checkpoint output path",
    )
    parser.add_argument("--steps", type=int, default=1200)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--eval-iters", type=int, default=25)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--block-size", type=int, default=128)
    parser.add_argument("--n-embed", type=int, default=128)
    parser.add_argument("--n-head", type=int, default=4)
    parser.add_argument("--n-layer", type=int, default=4)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        help="auto, cpu, cuda, or any torch device string",
    )
    return parser.parse_args()


def choose_device(requested: str) -> torch.device:
    if requested == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        return torch.device("cpu")
    return torch.device(requested)


def read_corpus(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if len(text) < 100:
        raise ValueError("Corpus is too small. Provide at least 100 characters.")
    return text


def make_batch(
    data: torch.Tensor,
    batch_size: int,
    block_size: int,
    device: torch.device,
) -> Tuple[torch.Tensor, torch.Tensor]:
    max_start = len(data) - block_size - 1
    if max_start <= 0:
        raise ValueError("Corpus is shorter than block size. Reduce --block-size.")

    starts = torch.randint(max_start, (batch_size,))
    x = torch.stack([data[i : i + block_size] for i in starts])
    y = torch.stack([data[i + 1 : i + block_size + 1] for i in starts])
    return x.to(device), y.to(device)


@torch.no_grad()
def estimate_loss(
    model: TinyTransformer,
    train_data: torch.Tensor,
    val_data: torch.Tensor,
    batch_size: int,
    block_size: int,
    eval_iters: int,
    device: torch.device,
) -> dict[str, float]:
    out: dict[str, float] = {}
    model.eval()
    for split_name, split_data in {"train": train_data, "val": val_data}.items():
        losses = torch.zeros(eval_iters)
        for k in range(eval_iters):
            xb, yb = make_batch(
                data=split_data,
                batch_size=batch_size,
                block_size=block_size,
                device=device,
            )
            _, loss = model(xb, yb)
            if loss is None:
                raise RuntimeError("Loss is unexpectedly None")
            losses[k] = loss.item()
        out[split_name] = losses.mean().item()
    model.train()
    return out


def train() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)

    text = read_corpus(args.corpus)
    stoi, itos = build_vocab(text)
    encoded = torch.tensor([stoi[ch] for ch in text], dtype=torch.long)

    min_tokens_per_split = args.block_size + 2
    min_total_tokens = 2 * min_tokens_per_split
    if len(encoded) < min_total_tokens:
        raise ValueError(
            "Corpus too small for current block size. "
            f"Need at least {min_total_tokens} characters/tokens for --block-size {args.block_size}."
        )

    split_idx = int(0.9 * len(encoded))
    if len(encoded) - split_idx < min_tokens_per_split:
        split_idx = len(encoded) - min_tokens_per_split
    if split_idx < min_tokens_per_split:
        split_idx = min_tokens_per_split

    train_data = encoded[:split_idx]
    val_data = encoded[split_idx:]

    device = choose_device(args.device)

    config = ModelConfig(
        vocab_size=len(stoi),
        block_size=args.block_size,
        n_embed=args.n_embed,
        n_head=args.n_head,
        n_layer=args.n_layer,
        dropout=args.dropout,
    )

    model = TinyTransformer(config=config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    print(f"Training on {device} with vocab size {config.vocab_size}...")
    for step in range(args.steps):
        xb, yb = make_batch(
            data=train_data,
            batch_size=args.batch_size,
            block_size=args.block_size,
            device=device,
        )
        _, loss = model(xb, yb)
        if loss is None:
            raise RuntimeError("Loss is unexpectedly None")

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()

        if step % args.eval_interval == 0 or step == args.steps - 1:
            losses = estimate_loss(
                model=model,
                train_data=train_data,
                val_data=val_data,
                batch_size=args.batch_size,
                block_size=args.block_size,
                eval_iters=args.eval_iters,
                device=device,
            )
            print(
                f"step {step:04d} | train loss {losses['train']:.4f} | val loss {losses['val']:.4f}"
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model_state": model.state_dict(),
            "config": asdict(config),
            "stoi": stoi,
            "itos": itos,
        },
        args.output,
    )
    print(f"Saved checkpoint to {args.output}")


def main() -> None:
    train()


if __name__ == "__main__":
    main()
