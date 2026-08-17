from __future__ import annotations

from .agent import Agent
from .config import AgentConfig
from .tools.local_llm_tool import LocalLLMTool
from .tools.time_tool import TimeTool


def main() -> None:
    config = AgentConfig.from_env()
    agent = Agent(name=config.name)
    agent.register_tool(TimeTool())
    agent.register_tool(LocalLLMTool())

    print(f"{agent.name} agent ready. Type 'help' to begin.")
    while True:
        try:
            user_input = input(config.prompt_prefix)
        except EOFError:
            print()
            break

        result = agent.handle(user_input)
        if result == "exit":
            break
        print(result)


if __name__ == "__main__":
    main()
