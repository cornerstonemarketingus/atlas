/** Persist only a bounded receipt, never the project prompt, credentials or model output. */
export function projectReceipts(events = []) {
  const receipts = new Map();
  for (const event of events) {
    if (event.kind !== "project") continue;
    try {
      const value = JSON.parse(event.detail);
      const receipt = safeProjectReceipt(value);
      if (receipt) receipts.set(receipt.operationId, receipt);
    } catch { /* Older or unrelated events are not project receipts. */ }
  }
  return [...receipts.values()];
}

export function safeProjectReceipt(value) {
  if (!value || !/^[a-zA-Z0-9_-]{16,100}$/u.test(value.operationId ?? "")) return null;
  return { operationId: value.operationId, status: "recovering" };
}

/** Keep the current snapshot stable while ordinary history polling refreshes. */
export function latestProjectReceipt(events, previous) {
  const receipts = projectReceipts(events);
  const latest = receipts[receipts.length - 1];
  return latest && latest.operationId !== previous?.operationId ? latest : previous;
}
