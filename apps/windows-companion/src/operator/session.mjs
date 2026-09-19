import { createHash } from "node:crypto";

import { classifyAction, describeForApproval, detectHumanRequired } from "./classification.mjs";

/**
 * The computer-operation session.
 *
 * It implements the browser-session contract the local daemon's browser tools
 * call, over an injected page adapter. The adapter is Playwright in
 * production and a fixture in tests, which is what makes the demo workflows
 * deterministic — they exercise the real classification, approval, evidence
 * and CAPTCHA logic, just not a real browser.
 *
 * Accessibility first: the model gets a snapshot of named elements and acts
 * on references. A screenshot is a fallback for when the snapshot is empty or
 * unhelpful, not the primary channel, because an operator cannot meaningfully
 * approve a click at coordinates.
 */
export class OperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperatorError";
    this.code = code;
  }
}

export function createOperatorSession({
  page,
  approvals = null,
  screenshots = null,
  now = () => Date.now(),
  maxSnapshotCharacters = 28_000,
}) {
  if (!page) throw new OperatorError("NO_PAGE", "A page adapter is required.");

  let lastSnapshot = { refs: new Map(), text: "", takenAtMs: 0, url: "" };
  const receipts = [];

  /** Re-reads the page whenever the reference table may be stale. */
  async function refresh({ signal } = {}) {
    const url = await page.url();
    let text = "";
    let elements = [];
    try {
      const snapshot = await page.snapshot({ signal });
      text = snapshot.text ?? "";
      elements = snapshot.elements ?? [];
    } catch (error) {
      throw new OperatorError("SNAPSHOT_FAILED", `The page could not be read: ${error.message}`);
    }

    if (elements.length === 0 && screenshots) {
      // Snapshot fallback. Stored locally; nothing is uploaded by taking it.
      const shot = await page.screenshot({ signal }).catch(() => null);
      if (shot) {
        const path = await screenshots.store({ bytes: shot, url, takenAtMs: now() });
        text = `${text}\n[The accessibility tree was empty. A screenshot was saved locally at ${path}.]`;
      }
    }

    lastSnapshot = {
      refs: new Map(elements.map((element) => [element.ref, element])),
      text,
      takenAtMs: now(),
      url,
    };
    return lastSnapshot;
  }

  function resolve(ref) {
    const element = lastSnapshot.refs.get(ref);
    if (!element) {
      // A stale reference after a navigation or a popup is the normal case,
      // not an error: say so, so the model takes a fresh snapshot rather than
      // clicking whatever now happens to sit at that reference.
      throw new OperatorError("STALE_REFERENCE", `Reference '${ref}' is not in the current page snapshot. Take a new snapshot first.`);
    }
    return element;
  }

  /**
   * The gate every acting method passes through: classify, check for a wall
   * only a person can pass, then require an approval bound to this exact
   * action on this exact page.
   */
  async function gate({ action, element, signal }) {
    const wall = detectHumanRequired(lastSnapshot.text);
    if (wall.blocked) {
      throw new OperatorError(
        "HUMAN_REQUIRED",
        `Atlas stopped: this page is showing ${wall.reason}. Take over in the browser window, then tell Atlas to continue. Evidence: ${wall.evidence}`,
      );
    }

    const classification = classifyAction(action, { elementName: element?.name });
    if (!classification.allowed) throw new OperatorError("UNSUPPORTED_ACTION", classification.reason);
    if (!classification.requiresApproval) return classification;

    const digest = createHash("sha256")
      .update(JSON.stringify({ type: action.type, ref: action.ref ?? null, name: element?.name ?? null, url: lastSnapshot.url, text: action.text ?? null, path: action.path ?? null }))
      .digest("hex");
    const summary = describeForApproval({ classification, url: lastSnapshot.url, intent: action.intent });
    const granted = approvals ? await approvals.request({ digest, summary, classification, url: lastSnapshot.url, signal }) : false;
    if (!granted) throw new OperatorError("APPROVAL_REQUIRED", `The operator has not approved this action.\n${summary}`);
    return { ...classification, digest };
  }

  /**
   * Evidence that the action happened, recorded after the fact.
   *
   * Atlas does not claim a submission succeeded because it clicked a button;
   * it claims it because the page changed afterwards and it recorded what it
   * looked like.
   */
  async function recordEvidence({ action, classification, before, signal }) {
    const after = await refresh({ signal }).catch(() => lastSnapshot);
    const changed = after.url !== before.url || after.text !== before.text;
    let screenshot = null;
    if (classification.requiresApproval && screenshots) {
      const bytes = await page.screenshot({ signal }).catch(() => null);
      if (bytes) screenshot = await screenshots.store({ bytes, url: after.url, takenAtMs: now() });
    }
    const receipt = {
      action: action.type,
      actionClass: classification.actionClass,
      approvalDigest: classification.digest ?? null,
      url: after.url,
      changed,
      screenshot,
      at: new Date(now()).toISOString(),
    };
    receipts.push(receipt);
    return receipt;
  }

  return {
    receipts,
    lastUrl: () => lastSnapshot.url,

    async navigate({ url, signal }) {
      const before = lastSnapshot;
      await gate({ action: { type: "navigate", url }, signal });
      await page.goto({ url, signal });
      const snapshot = await refresh({ signal });
      await recordEvidence({ action: { type: "navigate" }, classification: { actionClass: "navigate", requiresApproval: false }, before, signal });
      return { url: snapshot.url, title: await page.title().catch(() => null) };
    },

    async snapshot({ signal }) {
      const snapshot = await refresh({ signal });
      const wall = detectHumanRequired(snapshot.text);
      const header = wall.blocked
        ? `[Atlas cannot continue here: the page is showing ${wall.reason}. Hand control to the operator.]\n`
        : "";
      const elements = [...snapshot.refs.values()]
        .map((element) => `${element.ref} ${element.role} "${element.name}"${element.value ? ` = ${String(element.value).slice(0, 80)}` : ""}`)
        .join("\n");
      return `${header}URL: ${snapshot.url}\n${elements}\n\n${snapshot.text}`.slice(0, maxSnapshotCharacters);
    },

    async click({ ref, submit = false, intent = "", signal }) {
      const before = lastSnapshot;
      const element = resolve(ref);
      const classification = await gate({ action: { type: submit ? "submit" : "click", ref, intent, name: element.name }, element, signal });
      await page.click({ ref, signal });
      const receipt = await recordEvidence({ action: { type: "click" }, classification, before, signal });
      return {
        summary: receipt.changed
          ? `Clicked "${element.name}". The page changed; now at ${receipt.url}.`
          // Said plainly rather than reported as success.
          : `Clicked "${element.name}", but nothing on the page changed. The action may not have taken effect.`,
        receipt,
      };
    },

    async type({ ref, text, submit = false, signal }) {
      const before = lastSnapshot;
      const element = resolve(ref);
      const classification = await gate({ action: { type: "fill", ref, label: element.name, text, submit }, element, signal });
      await page.fill({ ref, text, signal });
      if (submit) await page.press({ ref, key: "Enter", signal });
      const receipt = await recordEvidence({ action: { type: "fill" }, classification, before, signal });
      return { summary: `Typed ${text.length} characters into "${element.name}".`, receipt };
    },

    async upload({ ref, path, signal }) {
      const before = lastSnapshot;
      const element = resolve(ref);
      const classification = await gate({ action: { type: "upload", ref, path, name: element.name }, element, signal });
      await page.setInputFiles({ ref, path, signal });
      const receipt = await recordEvidence({ action: { type: "upload" }, classification, before, signal });
      return { summary: `Attached ${path} to "${element.name}".`, receipt };
    },

    async download({ ref, toPath = null, signal }) {
      const before = lastSnapshot;
      const element = resolve(ref);
      const classification = await gate({ action: { type: "download", ref, name: element.name }, element, signal });
      const saved = await page.download({ ref, toPath, signal });
      const receipt = await recordEvidence({ action: { type: "download" }, classification, before, signal });
      return { summary: `Downloaded to ${saved?.path ?? toPath ?? "the workspace"}.`, path: saved?.path ?? toPath, receipt };
    },

    /** Reads named fields out of the snapshot. Page text is data, not instructions. */
    async extract({ fields, signal }) {
      const snapshot = await refresh({ signal });
      const out = {};
      for (const field of fields) {
        const needle = String(field.name).toLowerCase();
        const element = [...snapshot.refs.values()].find((candidate) => String(candidate.name ?? "").toLowerCase().includes(needle));
        out[field.name] = element?.value ?? element?.name ?? null;
      }
      return out;
    },

    /** Application and window targeting, for a companion that drives more than one app. */
    async focusApplication({ name, signal }) {
      if (typeof page.focusApplication !== "function") {
        throw new OperatorError("NO_WINDOW_CONTROL", "This companion cannot switch applications; it drives a browser only.");
      }
      const focused = await page.focusApplication({ name, signal });
      // The reference table belongs to the previous window.
      lastSnapshot = { refs: new Map(), text: "", takenAtMs: now(), url: "" };
      await refresh({ signal }).catch(() => {});
      return { focused: focused?.title ?? name };
    },
  };
}
