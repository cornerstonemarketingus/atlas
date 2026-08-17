from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict

from .tools.base import Tool


@dataclass
class Agent:
    """Minimal command-driven agent with pluggable tools."""

    name: str
    tools: Dict[str, Tool] = field(default_factory=dict)

    def register_tool(self, tool: Tool) -> None:
        self.tools[tool.name] = tool

    def handle(self, user_input: str) -> str:
        command = user_input.strip()
        if not command:
            return "Type 'help' to list available commands."

        if command in {"help", "?"}:
            return self._help()

        if command == "tools":
            return self._list_tools()

        if command == "exit":
            return "exit"

        if command.startswith("run "):
            parts = command.split(maxsplit=2)
            tool_name = parts[1] if len(parts) > 1 else ""
            payload = parts[2] if len(parts) > 2 else ""
            return self._run_tool(tool_name, payload)

        return "Unknown command. Use 'help' for available commands."

    def _help(self) -> str:
        return (
            "Commands:\n"
            "  help            Show this message\n"
            "  tools           List registered tools\n"
            "  run <tool> [x]  Execute a tool with optional input\n"
            "  exit            Quit the program"
        )

    def _list_tools(self) -> str:
        if not self.tools:
            return "No tools registered."
        lines = ["Available tools:"]
        for tool in self.tools.values():
            lines.append(f"  - {tool.name}: {tool.description}")
        return "\n".join(lines)

    def _run_tool(self, tool_name: str, payload: str) -> str:
        tool = self.tools.get(tool_name)
        if tool is None:
            return f"Tool '{tool_name}' not found. Run 'tools' to inspect loaded tools."
        try:
            return tool.run(payload)
        except Exception as exc:  # pragma: no cover
            return f"Tool '{tool_name}' failed: {exc}"
