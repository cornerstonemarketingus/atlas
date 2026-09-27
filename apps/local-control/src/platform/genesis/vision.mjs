import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { CATALOG } from "../../agent/models/catalog.mjs";
import { assertSafeEndpoint, isLoopback } from "../self-improve/runtime.mjs";

/**
 * A visual review of the screenshots the inspector saved, by a vision-capable
 * model, for what DOM checks cannot see: overflow and overlap, unreadable
 * text, broken spacing, missing content, an obviously unfinished default UI,
 * mobile layout problems, error pages.
 *
 * - Optional by design: without a vision model the review is skipped and the
 *   evidence says so; the DOM/console/workflow checks still decide.
 * - Bounded: at most MAX_IMAGES screenshots per review (phone widths first,
 *   where layouts break), at most MAX_BYTES of image data, one request.
 * - Only visual problems the model marks as errors can block (and trigger a
 *   repair), and only on the first review of a project; after that they are
 *   passed to the polish step as suggestions. A model's taste never keeps a
 *   working app from being ready.
 * - The model sees images and a fixed checklist, and must answer in JSON; an
 *   answer that does not parse is recorded and ignored.
 *
 * The endpoint is OpenAI-compatible (Ollama, llama.cpp, vLLM accept
 * `image_url` data URLs); it defaults to the local model server, and the
 * model is ATLAS_GENESIS_VISION_MODEL or an installed vision model from the
 * catalog (for example qwen2.5vl:7b).
 */

export const MAX_IMAGES = 6;
const MAX_BYTES = 6 * 1024 * 1024;
const VISION_TAGS = CATALOG.filter((entry) => entry.vision).map((entry) => entry.tag);

const CHECKLIST = [
  "content overflowing the screen or cut off",
  "elements overlapping each other",
  "text too small, too faint or clipped to read",
  "inconsistent or broken spacing and alignment",
  "missing or empty content where something should be",
  "an obviously unfinished or default-looking interface (placeholder text, unstyled elements)",
  "a phone layout that is cramped, broken or needs horizontal scrolling",
  "an error page or error message shown to the user",
];

export function visionPrompt(files) {
  return [
    "You are reviewing screenshots of a small web application before it is shown to its owner.",
    `Screenshots, in order: ${files.map((file, index) => `${index + 1}. ${basename(file)}`).join("; ")} (the number after the dash is the screen width in pixels).`,
    `Check only for: ${CHECKLIST.join("; ")}.`,
    "Do not comment on taste, colours or wording unless it makes something unreadable or broken.",
    'Answer with JSON only: {"issues":[{"screenshot":<number>,"problem":"<one sentence>","severity":"error"|"warning"}]}. Use "error" only for something a user would call broken. If everything looks fine, answer {"issues":[]}.',
  ].join("\n");
}

/** Picks the screenshots to send: phone widths first, then desktop, capped by count and bytes. */
export function selectScreenshots(files) {
  const ordered = [...files].sort((a, b) => Number(/-375\.png$/u.test(b)) - Number(/-375\.png$/u.test(a)));
  const chosen = [];
  let bytes = 0;
  for (const file of ordered) {
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    if (chosen.length >= MAX_IMAGES || bytes + size > MAX_BYTES) break;
    chosen.push(file);
    bytes += size;
  }
  return chosen;
}

export function parseVisionAnswer(text) {
  const match = /\{[\s\S]*\}/u.exec(String(text ?? ""));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.issues)) return null;
    return parsed.issues
      .filter((issue) => issue && typeof issue.problem === "string" && issue.problem.trim())
      .slice(0, 12)
      .map((issue) => ({ screenshot: Number(issue.screenshot) || null, problem: issue.problem.trim().slice(0, 300), severity: issue.severity === "error" ? "error" : "warning" }));
  } catch {
    return null;
  }
}

export function createVisionReviewer({ environment = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = environment.ATLAS_GENESIS_VISION_BASE_URL || environment.ATLAS_GENESIS_BASE_URL || "http://127.0.0.1:11434/v1";
  assertSafeEndpoint(baseUrl);
  const apiKey = environment.ATLAS_GENESIS_API_KEY_ENV ? environment[environment.ATLAS_GENESIS_API_KEY_ENV] ?? "" : "";
  const reviewed = new Map();

  async function model() {
    if (environment.ATLAS_GENESIS_VISION_MODEL) return environment.ATLAS_GENESIS_VISION_MODEL;
    if (!isLoopback(baseUrl)) return null;
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/models`, { signal: AbortSignal.timeout(2_000) });
      const ids = ((await response.json()).data ?? []).map((entry) => entry.id);
      return ids.find((id) => VISION_TAGS.includes(id) || /(^|[/:-])(vl|vision|llava)/iu.test(id)) ?? null;
    } catch {
      return null;
    }
  }

  return async function review(project, screenshots) {
    const tag = await model();
    if (!tag) return { reviewed: false, reason: "No vision model is available; the interface was checked through the page structure and workflows only.", findings: [] };
    const files = selectScreenshots(screenshots ?? []);
    if (!files.length) return { reviewed: false, reason: "No screenshots were captured.", findings: [] };
    const content = [{ type: "text", text: visionPrompt(files) }, ...files.map((file) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(file).toString("base64")}` } }))];
    let answer;
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: tag, temperature: 0, max_tokens: 800, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) return { reviewed: false, model: tag, reason: `The vision model answered ${response.status}.`, findings: [] };
      answer = (await response.json()).choices?.[0]?.message?.content;
    } catch (error) {
      return { reviewed: false, model: tag, reason: `The vision model could not be reached (${error instanceof Error ? error.message : "error"}).`, findings: [] };
    }
    const issues = parseVisionAnswer(Array.isArray(answer) ? answer.map((part) => part.text ?? "").join("") : answer);
    if (!issues) return { reviewed: false, model: tag, reason: "The vision model's answer was not the requested JSON; it was ignored.", findings: [] };
    const first = !reviewed.has(project.id);
    reviewed.set(project.id, (reviewed.get(project.id) ?? 0) + 1);
    const findings = issues.map((issue) => ({
      check: "visual",
      page: issue.screenshot && files[issue.screenshot - 1] ? basename(files[issue.screenshot - 1]) : "screenshots",
      expected: "a clean, readable layout",
      observed: issue.problem,
      // Visual errors can block once; afterwards they are suggestions for polish.
      severity: issue.severity === "error" && first ? "error" : "warning",
    }));
    return { reviewed: true, model: tag, screenshots: files.map((file) => basename(file)), findings };
  };
}
