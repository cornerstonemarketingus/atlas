const RISKS = new Set(["read", "write", "consequential"]);

export class ToolRegistry {
  #tools = new Map();

  register(descriptor, execute) {
    if (!descriptor || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(descriptor.name ?? "")) throw new Error("Invalid tool name.");
    if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(descriptor.capability ?? "")) throw new Error("Invalid tool capability.");
    if (!RISKS.has(descriptor.risk)) throw new Error("Invalid tool risk.");
    if (typeof execute !== "function" || this.#tools.has(descriptor.name)) throw new Error("Tool executor is missing or already registered.");
    const timeoutMs = Math.min(Math.max(Number(descriptor.timeoutMs ?? 30_000), 100), 300_000);
    const outputBytes = Math.min(Math.max(Number(descriptor.outputBytes ?? 64 * 1024), 256), 1024 * 1024);
    this.#tools.set(descriptor.name, { descriptor: Object.freeze({ ...descriptor, timeoutMs, outputBytes }), execute });
    return this;
  }

  describe() { return [...this.#tools.values()].map(({ descriptor }) => descriptor); }

  async invoke(name, input, { policy, signal, context = {} } = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error("Unknown tool.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object.");
    if (typeof tool.descriptor.validate === "function") tool.descriptor.validate(input);
    const decision = policy?.(tool.descriptor.capability) ?? "deny";
    if (decision === "deny") throw new Error(`Policy denies ${tool.descriptor.capability}.`);
    if (decision === "ask" || (tool.descriptor.risk === "consequential" && decision !== "allow")) {
      return { status: "approval_required", capability: tool.descriptor.capability, summary: tool.descriptor.summary ?? name };
    }
    const timeout = AbortSignal.timeout(tool.descriptor.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const value = await tool.execute(input, { ...context, signal: combined });
    const encoded = JSON.stringify(value ?? null);
    if (Buffer.byteLength(encoded, "utf8") > tool.descriptor.outputBytes) throw new Error("Tool output exceeded its declared bound.");
    return { status: "completed", value: JSON.parse(encoded) };
  }
}
