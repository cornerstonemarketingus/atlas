/** Bound the complete response; a timed out mutation is never automatically retried. */
export async function missionRequest(path, body, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(path, { method: body ? "POST" : "GET", cache: "no-store", signal: controller.signal,
          headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? "Mission request failed.");
        return result;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(new Error(body ? "Mission response timed out. Work may have started. Reopen the saved mission to reconcile before continuing." : "Mission loading timed out. Try reopening the mission."));
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
