import { TASK_REQUEST_KEY } from "../api/tasks/task-request-contract.mjs";

export function requestExplanation(request) {
  if (request.state === "task-saved") {
    const status = request.task?.dispatchState;
    if (status === "dispatched") return "The executor accepted this task. Open its activity to check execution.";
    if (status === "rejected") return "The task was saved, but the executor refused its dispatch.";
    return "The task is saved. Its execution is not yet confirmed.";
  }
  if (request.state === "refused") return "Atlas returned a refusal for this request. Checking it does not start another task.";
  if (request.state === "acknowledged") return "The request was acknowledged, but its task history is unavailable. Check before starting another request.";
  if (request.state === "ambiguous") return "Several task records match this request. Its execution is unconfirmed and needs investigation.";
  return "The request is saved, but its outcome is unconfirmed. It may still be processing. Checking it does not retry execution.";
}

/** @param {{ requestKey?: string, cursor?: string | null, fetcher?: typeof fetch, signal?: AbortSignal }} [options] */
export async function readTaskRequests({ requestKey, cursor, fetcher = fetch, signal } = {}) {
  if (requestKey !== undefined && !TASK_REQUEST_KEY.test(requestKey)) throw new Error("Invalid request identity");
  const url = requestKey === undefined
    ? `/api/tasks/requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    : `/api/tasks/requests/${encodeURIComponent(requestKey)}`;
  const response = await fetcher(url, { method: "GET", cache: "no-store", signal });
  if (!response.ok) throw new Error("Saved requests are unavailable. Try again later.");
  return response.json();
}

/** @param {{requestKey: string, fetcher?: typeof fetch, signal?: AbortSignal}} options */
export async function reconcileTaskRequest({ requestKey, fetcher = fetch, signal }) {
  if (!TASK_REQUEST_KEY.test(requestKey)) throw new Error("Invalid request identity");
  const response = await fetcher(`/api/tasks/requests/${encodeURIComponent(requestKey)}/reconcile`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store",
    signal: signal ?? AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Execution evidence is unavailable. Refresh saved requests before checking again. No task was started.");
  return response.json();
}
