/**
 * Turns one tool call into an observation for the world state: an event for
 * the call itself, and the things it touched (files, browser resources,
 * repositories, people), plus a pending approval when the action waits on
 * the owner. Only identifying fields are kept: URL query strings and
 * fragments are dropped (they often carry tokens), and tool output is never
 * stored here.
 */
export function observationFor({ runId, seq, call, input = {}, status, code = null, environment = {} }) {
  const tool = String(call.name);
  const event = { type: "event", key: `${runId}:${seq}`, attrs: { kind: "tool_call", tool, status, code } };
  const entities = [event];
  const relations = [{ from: event, relation: "part_of", to: { type: "run", key: runId } }];
  const touched = (entity) => {
    entities.push(entity);
    relations.push({ from: event, relation: "touched", to: entity });
  };

  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        const clean = `${url.origin}${url.pathname}`;
        touched({ type: "browser_resource", key: clean, attrs: { url: clean, lastTool: tool, lastStatus: status } });
      }
    } catch { /* not a URL: nothing touched */ }
  }
  if (typeof input.path === "string" && input.path.length <= 1024) {
    if (tool.startsWith("repository.") && environment.repository) {
      const repository = { type: "repository", key: environment.repository, attrs: { name: environment.repository } };
      const file = { type: "file", key: `${environment.repository}:${input.path}`, attrs: { path: input.path, repository: environment.repository, lastTool: tool, lastStatus: status } };
      touched(repository);
      touched(file);
      relations.push({ from: file, relation: "part_of", to: repository });
    } else if (tool.startsWith("repository.") || tool.startsWith("filesystem.")) {
      touched({ type: "file", key: input.path, attrs: { path: input.path, lastTool: tool, lastStatus: status } });
    }
  }
  if (typeof input.to === "string" && /^[^\s@]+@[^\s@]+$/u.test(input.to.trim())) {
    touched({ type: "person", key: input.to.trim().toLowerCase(), attrs: { address: input.to.trim().toLowerCase() } });
  }
  if (status === "awaiting_approval") {
    const approval = { type: "approval", key: `${runId}:${seq}`, attrs: { tool, status: "pending" } };
    entities.push(approval);
    relations.push({ from: { type: "run", key: runId }, relation: "waits_on", to: approval });
  }
  return { source: `run:${runId}`, entities, relations };
}

/**
 * Records a tool call made outside a kernel run (for example a chat turn):
 * makes sure the run exists, then applies the call's observation. Never
 * throws; the world state must not break the work it describes.
 */
export function recordToolCall(world, { runId, runAttrs = {}, seq, call, input = {}, status, code = null, environment = {} }) {
  if (!world) return;
  try {
    world.upsert({ type: "run", key: runId, attrs: runAttrs, source: `run:${runId}` });
    world.apply(observationFor({ runId, seq, call, input, status, code, environment }));
  } catch { /* recorded best-effort */ }
}
