import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { conversationMessages, conversations, runEvents, tasks } from "../../../../db/schema";
import { createInstallationToken, githubAppConfiguration } from "../github-app.mjs";
import { resultBelongsToTask, validateRunnerResult, verifyRunnerIdentity } from "../runner-result.mjs";

export async function POST(request: Request) {
  let identity;
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 16000) throw new Error();
    identity = await verifyRunnerIdentity(authorization.slice(7));
  } catch { return Response.json({ message: "Runner authentication required." }, { status: 401 }); }
  let body;
  try {
    // Bound the stream as well as Content-Length (which is optional/untrusted).
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64000) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = validateRunnerResult(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return Response.json({ message: "Invalid result payload." }, { status: 400 }); }
  try {
    const db = getDb();
    const [task] = await db.select().from(tasks).where(eq(tasks.taskId, body.taskId)).limit(1);
    if (!task?.conversationId || identity.repository !== task.repository) return Response.json({ message: "Dispatch not found." }, { status: 404 });
    const app = githubAppConfiguration();
    const token = app.configured ? await createInstallationToken(app) : process.env.ATLAS_GITHUB_TOKEN;
    if (!token) return Response.json({ message: "Run verification unavailable." }, { status: 503 });
    const response = await fetch(`https://api.github.com/repos/${task.repository}/actions/runs/${identity.run_id}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atlas-control-plane" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return Response.json({ message: "Run verification unavailable." }, { status: 503 });
    if (!resultBelongsToTask(identity, task, await response.json())) return Response.json({ message: "Result does not match dispatch." }, { status: 403 });
    const [conversation] = await db.select().from(conversations).where(and(eq(conversations.id, task.conversationId), eq(conversations.requestedBy, task.requestedBy))).limit(1);
    if (!conversation) return Response.json({ message: "Dispatch not found." }, { status: 404 });
    const id = `result:${task.taskId}:${identity.run_id}:${identity.run_attempt}`;
    const now = new Date().toISOString();
    // One transaction and stable ids make a retried delivery harmless.
    await db.batch([
      db.insert(runEvents).values({ id, conversationId: task.conversationId, taskId: task.taskId, requestedBy: task.requestedBy, kind: "result", label: "Runner results received", detail: body.summary, createdAt: now }).onConflictDoNothing(),
      db.insert(conversationMessages).values({ id, conversationId: task.conversationId, requestedBy: task.requestedBy, role: "assistant", content: body.summary, createdAt: now }).onConflictDoNothing(),
      db.update(tasks).set({ githubRunId: Number(identity.run_id) }).where(and(eq(tasks.taskId, task.taskId), eq(tasks.requestedBy, task.requestedBy))),
      db.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, task.conversationId), eq(conversations.requestedBy, task.requestedBy))),
    ]);
    return Response.json({ received: true });
  } catch { return Response.json({ message: "Result storage temporarily unavailable." }, { status: 503 }); }
}
