import { createInterface } from "node:readline";

/**
 * Serves an AtlasMcpServer over newline-delimited JSON-RPC on stdio. The
 * principal is fixed by whoever launched the process (the launcher is the
 * authentication boundary for stdio); messages cannot change it.
 */
export function serveStdio({ server, principal, input = process.stdin, output = process.stdout, maxMessageBytes = 1024 * 1024 }) {
  const write = (message) => { if (message !== undefined) output.write(`${JSON.stringify(message)}\n`); };
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > maxMessageBytes) { write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } }); return; }
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    // Handled in arrival order so responses are deterministic.
    chain = chain.then(() => server.handle(message, principal)).then(write, () => write({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Internal error" } }));
  });
  return { close: () => rl.close(), closed: new Promise((resolve) => rl.once("close", resolve)) };
}
