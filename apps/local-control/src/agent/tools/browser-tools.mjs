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
import { allowHostsFrom, assertPublicUrl } from "../../../../windows-companion/src/url-safety.mjs";

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

/**
 * `session` may be a session or a factory returning one. A factory is resolved
 * on first use and cached, so launching a browser costs nothing until the
 * model actually asks for one.
 */
/**
 * The default navigation guard: public addresses only, unless the operator
 * named a host in ATLAS_BROWSER_ALLOW_HOSTS (SECURITY-REVIEW SEC-3).
 */
export const defaultUrlGuard = (url) => assertPublicUrl(url, { allowHosts: allowHostsFrom(process.env.ATLAS_BROWSER_ALLOW_HOSTS) });

export function registerBrowserTools(registry, { session, uploadRoot = null, urlGuard = defaultUrlGuard }) {
  let resolved = typeof session === "function" ? undefined : session;
  let building = null;
  const need = async () => {
    // A browser that was closed (the window closed, the process crashed or was
    // killed) is relaunched on the next use instead of failing every call
    // until Atlas restarts.
    if (typeof session === "function" && typeof resolved?.isClosed === "function" && resolved.isClosed()) resolved = undefined;
    if (resolved === undefined) {
      building ??= Promise.resolve().then(() => session()).finally(() => { building = null; });
      try {
        resolved = await building;
      } catch (error) {
        // Not remembered: a launch that failed once (a profile still locked by
        // a browser that was shutting down, say) is tried again next time.
        resolved = undefined;
        throw new BrowserToolError("NO_BROWSER", error?.message ?? "No browser session is available on this machine.");
      }
    }
    if (!resolved) throw new BrowserToolError("NO_BROWSER", "No browser session is available on this machine.");
    return resolved;
  };
  // The browser can die between two calls before anything has noticed. Such a
  // failure drops the dead session; navigating opens a new browser and tries
  // again, while acting on a page that no longer exists says so plainly.
  const closedUnderUs = (error) => typeof session === "function" && /(Target page, context or browser has been closed|Browser has been closed|Target closed|browser has disconnected)/iu.test(String(error?.message ?? ""));
  const onPage = async (action) => {
    try {
      return await action(await need());
    } catch (error) {
      if (!closedUnderUs(error)) throw error;
      resolved = undefined;
      throw new BrowserToolError("BROWSER_CLOSED", "The browser was closed, so the page it showed is gone. Open the page again with browser.navigate; Atlas starts a new browser for it.");
    }
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
      try { await urlGuard(url); }
      catch (error) { throw new BrowserToolError(error?.code ?? "URL_REFUSED", error?.message ?? "That address is not allowed."); }
      let browser = await need();
      let result;
      try {
        result = await browser.navigate({ url, signal });
      } catch (error) {
        if (!closedUnderUs(error)) throw error;
        resolved = undefined;
        browser = await need();
        result = await browser.navigate({ url, signal });
      }
      // A redirect can land somewhere the first check never saw; check where we ended up.
      if (result?.url && result.url !== url) {
        try { await urlGuard(result.url); }
        catch (error) {
          await browser.navigate({ url: "about:blank", signal }).catch(() => {});
          throw new BrowserToolError(error?.code ?? "URL_REFUSED", `The page redirected to a refused address. ${error?.message ?? ""}`.trim());
        }
      }
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
      const snapshot = await onPage((browser) => browser.snapshot({ signal }));
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
      const result = await onPage((browser) => browser.click({ ref: input.ref, signal }));
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
      const result = await onPage((browser) => browser.type({ ref: input.ref, text: input.text, submit: false, signal }));
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
      const result = await onPage((browser) => browser.click({ ref: input.ref, submit: true, signal }));
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
      const result = await onPage((browser) => browser.upload({ ref: input.ref, path: input.path, signal }));
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
      const result = await onPage((browser) => browser.download({ ref: input.ref, toPath: input.toPath || null, signal }));
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
      const extracted = await onPage((browser) => browser.extract({ fields: input.fields, signal }));
      // Page content is data, never instructions; it is returned as JSON so
      // it reads as a value rather than as prose the model might obey.
      return JSON.stringify(extracted ?? {});
    },
  });

  return registry;
}
