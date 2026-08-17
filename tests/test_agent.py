import unittest
from pathlib import Path
import tempfile

import torch

from atlas_agent.agent import Agent
from atlas_agent.local_llm.model import build_vocab
from atlas_agent.local_llm.train import choose_device
from atlas_agent.tools.local_llm_tool import LocalLLMTool
from atlas_agent.tools.time_tool import TimeTool


class AgentTests(unittest.TestCase):
    def test_help_command(self) -> None:
        agent = Agent(name="atlas")
        output = agent.handle("help")
        self.assertIn("Commands:", output)

    def test_tool_registration_and_run(self) -> None:
        agent = Agent(name="atlas")
        agent.register_tool(TimeTool())

        output = agent.handle("run time")
        self.assertIn("T", output)

    def test_unknown_tool(self) -> None:
        agent = Agent(name="atlas")
        output = agent.handle("run missing")
        self.assertIn("not found", output)

    def test_local_llm_requires_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir) / "missing.pt"
            tool = LocalLLMTool(model_path=str(model_path))

            output = tool.run("hello")
            self.assertIn("Model checkpoint not found", output)

    def test_build_vocab_and_device_selection(self) -> None:
        stoi, itos = build_vocab("abcabc")
        self.assertEqual(len(stoi), 3)
        self.assertEqual(itos[stoi["a"]], "a")

        device = choose_device("cpu")
        self.assertEqual(str(device), "cpu")

        auto_device = choose_device("auto")
        self.assertIn(str(auto_device), {"cpu", "cuda"})


if __name__ == "__main__":
    unittest.main()
