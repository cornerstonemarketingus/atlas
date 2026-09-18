/**
 * Browser tools over a provider-neutral session.
 *
 * The session is injected: today it is the Windows companion driving Edge
 * through Playwright, and a hosted browser can implement the same shape
 * without any tool here changing. A session must provide:
 *
 *   navigate({url}) · snapshot() · click({ref}) · type({ref,text,submit})
 *   upload({ref,path}) · download({ref,toPath}) · extract({fields})
 *
 * Accessibility-first by design: the model works from a snapshot of named
 * elements and clicks them by reference. Coordinates are not exposed, because
 * a pixel is not a thing an operator can meaningfully approve.
 */
export class BrowserToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserToolError";
    this.code = code;
  }
}

/**
 * A page is untrusted, and so is a URL the model produces. `file:` would read
 * the disk through the browser and `javascript:` would execute in whatever
 * page is open, so only http(s) is allowed through.
 */
export function assertNavigableUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new BrowserToolError("INVALID_URL", "That is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserToolError("UNSUPPORTED_SCHEME", `Atlas only opens http and https URLs, not '${url.protocol}'.`);
  }
  return url.toString();
}

export function registerBrowserTools(registry, { session, uploadRoot = null }) {
  const need = () => {
    if (!session) throw new BrowserToolError("NO_BROWSER", "No browser session is available on this machine.");
    return session;
  };

  registry.register({
    name: "browser.navigate",
    description: "Open an http or https URL in the operator's browser.",
    capability: "browser.control",
    risk: "moderate",
    timeoutMs: 60_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
    },
    async execute({ input, signal }) {
      const url = assertNavigableUrl(input.url);
      const result = await need().navigate({ url, signal });
      return `Opened ${result?.url ?? url}${result?.title ? ` — ${result.title}` : ""}.`;
    },
  });

  registry.register({
    name: "browser.snapshot",
    description: "Take an accessibility snapshot of the current page: its interactive elements and their references.",
    capability: "browser.read",
    risk: "low",
    timeoutMs: 30_000,
    maxOutputCharacters: 40_000,
    requiresApproval: false,
    inputSchema: { type: "object", required: [], properties: {} },
    async execute({ signal }) {
      const snapshot = await need().snapshot({ signal });
      return typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
    },
  });

  registry.register({
    name: "browser.click",
    description: "Click an element by its reference from the latest accessibility snapshot.",
    capability: "browser.control",
    risk: "moderate",
    timeoutMs: 30_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["ref"],
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 300, default: "" },
      },
    },
    async execute({ input, signal }) {
      const result = await need().click({ ref: input.ref, signal });
      return result?.summary ?? `Clicked ${input.description || input.ref}.`;
    },
  });

  registry.register({
    name: "browser.type",
    description: "Type text into a field by its reference. Set submit only when the form should be sent.",
    capability: "browser.control",
    risk: "moderate",
    timeoutMs: 30_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["ref", "text"],
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 200 },
        text: { type: "string", maxLength: 20_000 },
        submit: { type: "boolean", default: false },
      },
    },
    async execute({ input, signal }) {
      if (input.submit) {
        // Submitting is a send, and a send is approval-bound. Typing is not,
        // so the model must ask for the submitting tool explicitly.
        throw new BrowserToolError("APPROVAL_REQUIRED", "Use browser.submit to send a form; it requires the operator's approval.");
      }
      const result = await need().type({ ref: input.ref, text: input.text, submit: false, signal });
      return result?.summary ?? `Typed ${input.text.length} characters into ${input.ref}.`;
    },
  });

  registry.register({
    name: "browser.submit",
    description: "Submit a form or activate a control that sends, buys, applies, or posts. Requires approval.",
    capability: "browser.submit",
    risk: "critical",
    timeoutMs: 60_000,
    maxOutputCharacters: 8_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["ref", "intent"],
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 200 },
        // The operator reads this in the approval prompt, so it is required.
        intent: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    async execute({ input, signal }) {
      const result = await need().click({ ref: input.ref, submit: true, signal });
      return result?.summary ?? `Submitted: ${input.intent}.`;
    },
  });

  registry.register({
    name: "browser.upload",
    description: "Attach a file from the workspace to a file input on the page. Requires approval.",
    capability: "browser.upload",
    risk: "critical",
    timeoutMs: 120_000,
    maxOutputCharacters: 4_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["ref", "path"],
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 200 },
        path: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    async execute({ input, signal }) {
      if (uploadRoot) {
        const { resolve, sep } = await import("node:path");
        const base = resolve(uploadRoot);
        const target = resolve(base, input.path);
        if (target !== base && !target.startsWith(base + sep)) {
          throw new BrowserToolError("PATH_OUTSIDE_WORKSPACE", "An upload must come from the configured workspace.");
        }
      }
      const result = await need().upload({ ref: input.ref, path: input.path, signal });
      return result?.summary ?? `Attached ${input.path} to ${input.ref}.`;
    },
  });

  registry.register({
    name: "browser.download",
    description: "Download the file behind a link or button into the workspace.",
    capability: "browser.control",
    risk: "moderate",
    timeoutMs: 180_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["ref"],
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 200 },
        toPath: { type: "string", maxLength: 1024, default: "" },
      },
    },
    async execute({ input, signal }) {
      const result = await need().download({ ref: input.ref, toPath: input.toPath || null, signal });
      return result?.summary ?? `Downloaded to ${result?.path ?? "the workspace"}.`;
    },
  });

  registry.register({
    name: "browser.extract",
    description: "Extract named fields from the current page as structured JSON.",
    capability: "browser.read",
    risk: "low",
    timeoutMs: 60_000,
    maxOutputCharacters: 30_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["fields"],
      properties: {
        fields: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 80 },
              description: { type: "string", maxLength: 300, default: "" },
            },
          },
        },
      },
    },
    async execute({ input, signal }) {
      const extracted = await need().extract({ fields: input.fields, signal });
      // Page content is data, never instructions; it is returned as JSON so
      // it reads as a value rather than as prose the model might obey.
      return JSON.stringify(extracted ?? {});
    },
  });

  return registry;
}
