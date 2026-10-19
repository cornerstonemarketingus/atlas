/** One bounded request at a time; failures stay visible until a fresh response. */
export function pollActivity({ url, onActivity, onUnavailable, fetcher = fetch, intervalMs = 4000, timeoutMs = 20000, repeat = true }) {
  let stopped = false, timer, controller;
  async function load() {
    let received = false;
    controller = new AbortController();
    const signal = controller.signal;
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await Promise.race([
        (async () => {
          const response = await fetcher(url, { cache: "no-store", signal });
          if (!response.ok) throw new Error("Activity unavailable");
          return response.json();
        })(),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Activity request aborted")), { once: true })),
      ]);
      if (!stopped) { received = true; onActivity(value); onUnavailable(false); }
    } catch {
      if (!stopped) onUnavailable(true);
    } finally {
      clearTimeout(deadline);
      if (!stopped && (repeat || !received)) timer = setTimeout(load, intervalMs);
    }
  }
  void load();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
}

export function activityTaskStatus(activity, fallback) {
  if (activity?.status !== "completed") return fallback;
  if (activity.conclusion === "success") return "succeeded";
  if (activity.conclusion === "cancelled") return "cancelled";
  if (activity.conclusion === "timed_out") return "timed_out";
  return "failed";
}
