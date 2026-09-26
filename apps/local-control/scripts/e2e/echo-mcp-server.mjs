// A minimal MCP server over stdio (one "echo" tool) for the end-to-end journey.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo" } } });
  else if (msg.method === "tools/list") out({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (msg.method === "tools/call") out({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] } });
});
