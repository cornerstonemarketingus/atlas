import { DESKTOP_ACTION_TYPES, validateDesktopAction } from "../desktop/actions.mjs";
import { validateAction } from "../policy.mjs";

/**
 * One planner for the whole computer. Each step the model sees the browser
 * (when open) and the desktop (when available) and proposes one action on
 * either surface. Routing and validation here are deterministic: desktop
 * actions go to the DesktopSession's rules, browser actions to the browser
 * policy, and anything else is refused.
 */

export const BROWSER_ACTION_TYPES = Object.freeze(["navigate", "click", "fill", "select", "check", "press", "extract", "wait", "done"]);

export function isDesktopAction(action) {
  return DESKTOP_ACTION_TYPES.includes(action?.type);
}

/** Validates a proposed action for whichever surface it names. */
export function validateUnifiedAction(action, { desktopAvailable }) {
  if (isDesktopAction(action)) {
    if (!desktopAvailable) throw new Error("Desktop control is not available on this computer; use the browser or finish with a blocker.");
    return validateDesktopAction(action);
  }
  const checked = validateAction(action);
  if (!BROWSER_ACTION_TYPES.includes(checked.type)) throw new Error(`Unsupported action: ${String(checked.type).slice(0, 40)}`);
  return checked;
}

/** Compact, bounded text of a UI Automation tree for the prompt. */
export function summarizeTree(nodes, { maxLines = 120 } = {}) {
  const lines = [];
  const walk = (node, depth) => {
    if (!node || lines.length >= maxLines) return;
    const bounds = node.bounds ? ` @(${node.bounds.x},${node.bounds.y} ${node.bounds.width}x${node.bounds.height})` : "";
    if (node.name || node.role) lines.push(`${"  ".repeat(Math.min(depth, 8))}${node.role ?? "?"} "${String(node.name ?? "").slice(0, 80)}"${bounds}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const node of nodes ?? []) walk(node, 0);
  return lines.join("\n");
}

const BROWSER_ACTIONS = `{"type":"navigate","url":"https://..."}
{"type":"click","name":"exact accessible name"}
{"type":"fill","label":"field label","value":"text"}
{"type":"select","label":"field label","value":"option"}
{"type":"check","label":"checkbox label"}
{"type":"press","key":"Enter"}
{"type":"extract","text":"concise finding"}
{"type":"wait"}`;

const DESKTOP_ACTIONS = `{"type":"desktop_observe"}                      refresh the window list and focused window tree
{"type":"desktop_screenshot"}                   capture the screen as evidence
{"type":"focus_window","title":"part of a window title"}
{"type":"launch_app","app":"notepad"}
{"type":"desktop_click","x":100,"y":200,"button":"left"}   coordinates from the tree bounds
{"type":"desktop_type","text":"text to type into the focused window"}
{"type":"desktop_key","keys":"ctrl+s"}
{"type":"desktop_scroll","dy":3}
{"type":"clipboard_write","text":"..."}
{"type":"clipboard_read"}`;

/**
 * @param {object} input
 * @param {{objective: string, policy?: object}} input.task
 * @param {string} input.profile formatted local profile facts
 * @param {{url: string, snapshot: string}|null} input.browser
 * @param {{windows: Array, focused: object|null, tree: Array}|null} input.desktop
 * @param {Array} input.history recent actions with outcomes
 */
export function buildUnifiedPrompt({ task, profile = "", browser = null, desktop = null, desktopAvailable = false, history = [] }) {
  const sections = [
    "You operate this computer for one bounded task on behalf of its owner. Return JSON only: exactly one next action.",
    `Task: ${task.objective}`,
    profile,
    `Server policy: ${JSON.stringify(task.policy ?? {})}`,
    `Recent actions and outcomes: ${JSON.stringify(history.slice(-8))}`,
  ];
  if (browser) sections.push(`BROWSER — current URL: ${browser.url}\nAccessibility snapshot:\n${browser.snapshot.slice(0, 20_000)}`);
  else sections.push("BROWSER — not open. A navigate action opens it.");
  if (desktopAvailable && desktop) {
    const windows = desktop.windows.map((w) => `- ${w.title}`).join("\n").slice(0, 3000);
    sections.push(`DESKTOP — focused window: ${desktop.focused?.title ?? "(none)"}\nOpen windows:\n${windows || "(none)"}\nFocused window elements:\n${summarizeTree(desktop.tree).slice(0, 8000) || "(no accessibility tree available)"}`);
  } else if (!desktopAvailable) {
    sections.push("DESKTOP — not available on this computer. Use browser actions only.");
  }
  sections.push(`Browser actions:\n${BROWSER_ACTIONS}`);
  if (desktopAvailable) sections.push(`Desktop actions (for apps outside the browser):\n${DESKTOP_ACTIONS}`);
  sections.push(`Finish with {"type":"done","text":"concise result, or the exact blocker and what the owner must do"}.
Prefer the browser for websites and the desktop for installed applications. Never bypass access controls, anti-bot checks, CAPTCHAs or site policies. Never invent identity, qualifications or facts. Consequential steps pause for the owner's approval automatically — do not try to avoid that. If a required fact is missing, finish with a clear blocker.`);
  return sections.filter(Boolean).join("\n\n");
}
