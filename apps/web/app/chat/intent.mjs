/**
 * What does the person want from this message: an answer, work on their
 * project, or work on their computer?
 *
 * This only ever *suggests*. Chat used to dispatch a coding task whenever a
 * message contained a word like "test", "review" or "debug" — so "can you
 * explain how to write a good test?" opened a coder run against the selected
 * repository, and "hi can u debug yourself?" burned a full run's turn budget.
 * Now a question is always answered, and a clear request for work is offered
 * as a task the person confirms with one click.
 */

const LEAD_IN = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|atlas)[,!.:\s]+)*(?:please\s+|pls\s+|kindly\s+)?/iu;
const POLITE_REQUEST = /^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?/iu;
const QUESTION_START = /^(?:what|why|how|when|where|who|which|whose|is|are|was|were|do|does|did|should|shall|explain|tell me|describe|compare|define)\b/iu;

const PROJECT_VERBS = {
  coder: /^(?:build|fix|implement|add|change|update|refactor|create|write|remove|delete|rename|upgrade|migrate|make|improve|clean\s+up|set\s+up|wire|connect)\b/iu,
  debug: /^(?:debug|test|diagnose|troubleshoot|repair)\b/iu,
  inspect: /^(?:review|inspect|audit|analy[sz]e|map|scan|check)\b/iu,
};
const PROJECT_REFERENCE = /\b(?:my|the|this|our)\s+(?:project|repo(?:sitory)?|code(?:base)?|app(?:lication)?|site|website|api|backend|frontend|tests?|build|branch|component|page|feature|bug|login|endpoint|schema|pull request)\b|\b(?:pull request|PR|readme|\.(?:ts|tsx|js|mjs|py|go|rs|css|md)\b)/iu;

const COMPUTER_VERBS = /^(?:go\s+to|open|visit|browse|navigate(?:\s+to)?|search\s+(?:for|on|the web)|look\s+up|fill\s+(?:out|in)|apply\s+(?:to|for)|log\s*in(?:to)?|sign\s+(?:in|up)(?:\s+(?:to|for))?|download|book|order|find\s+(?:me\s+)?(?:a|an|the)?\s*\w+\s+(?:on|at)\b|click|take\s+a\s+screenshot|screenshot)\b/iu;
const COMPUTER_REFERENCE = /\b(?:on|in|using|with|of)\s+(?:my\s+|the\s+)?(?:computer|pc|desktop|laptop|screen|browser|chrome|edge|firefox)\b|\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(?:com|org|net|io|dev|ai|app|co)\b/iu;

function stripLeadIn(text) {
  return text.replace(LEAD_IN, "").trim();
}

/**
 * @param {string} message
 * @param {{ hasProject?: boolean }} [context]
 * @returns {{ kind: "chat" } | { kind: "project_task", mode: "coder"|"debug"|"inspect", reason: string } | { kind: "computer_task", reason: string }}
 */
export function classifyIntent(message, { hasProject = false } = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return { kind: "chat" };
  const body = stripLeadIn(text);
  const polite = POLITE_REQUEST.test(body);
  const request = polite ? body.replace(POLITE_REQUEST, "") : body;
  const words = request.split(/\s+/u).filter(Boolean);
  // Greetings, one-word pings and short fragments are conversation.
  if (words.length < 3) return { kind: "chat" };
  // A question that is not a polite request for work is answered, never dispatched.
  if (!polite && (QUESTION_START.test(body) || (text.endsWith("?") && !COMPUTER_VERBS.test(request) && !Object.values(PROJECT_VERBS).some((verb) => verb.test(request))))) {
    return { kind: "chat" };
  }

  if (COMPUTER_VERBS.test(request) && (COMPUTER_REFERENCE.test(text) || /^(?:go\s+to|visit|browse|navigate|log\s*in|sign\s+(?:in|up)|fill|apply|book|order|take\s+a\s+screenshot|screenshot)/iu.test(request))) {
    return { kind: "computer_task", reason: "This sounds like work in a browser or on your computer." };
  }
  for (const [mode, verb] of Object.entries(PROJECT_VERBS)) {
    if (!verb.test(request)) continue;
    // Without a connected project there is nothing to work on; answer instead.
    if (!hasProject) return { kind: "chat" };
    // A polite question must still point at the project to count as a request for work.
    if (polite && !PROJECT_REFERENCE.test(text)) return { kind: "chat" };
    const reason = mode === "inspect" ? "This asks Atlas to look through your project and report back."
      : mode === "debug" ? "This asks Atlas to run your project's checks and find what is failing."
        : "This asks Atlas to change your project and return a pull request.";
    return { kind: "project_task", mode, reason };
  }
  return { kind: "chat" };
}
