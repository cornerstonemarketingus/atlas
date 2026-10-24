import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newId, nowIso } from "../../../packages/atlas-contracts/src/index.mjs";
import { startEgressProxy } from "./egress-proxy.mjs";

/**
 * Atlas browser worker (execution plane).
 *
 * Every session is disposable and isolated: a fresh, non-persistent browser
 * context with no profile, no service workers, no permissions, downloads off
 * unless a limit is granted, and a network confinement enforced at the route
 * layer. Anything the page says is untrusted data: outputs are marked
 * `untrusted: true` and are never interpreted here.
 *
 * Network-destination limit: `context.route("**")` sees every request the
 * page makes (navigations, subresources, fetch/XHR) and aborts any whose
 * origin is not in the session's allow-list or whose scheme is not http(s).
 * WebSockets are confined the same way through `context.routeWebSocket`.
 * Because route interception does not see HTTP redirect hops, each context
 * also sends all traffic (loopback included) through a per-session egress
 * proxy (./egress-proxy.mjs) that enforces the same allow-list on every hop.
 */

export class BrowserWorkerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BrowserWorkerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const DEFAULT_SESSION_LIMITS = Object.freeze({
  maxSessionMs: 5 * 60_000,
  actionTimeoutMs: 15_000,
  maxDownloads: 0,
  viewport: Object.freeze({ width: 1280, height: 800 }),
  javaScriptEnabled: true,
});

const HARD_MAX_SESSION_MS = 60 * 60_000;
const HARD_MAX_ACTION_TIMEOUT_MS = 120_000;
const SENSITIVE_KEY = /passw(or)?d|passcode|token|secret|api[-_]?key|authorization|cookie|credential|otp/i;
const MAX_TRACE_ENTRIES = 500;
const MAX_BLOCKED_RECORDS = 100;
const ACTION_RETRY_ATTEMPTS = 3;
const ACTION_RETRY_BASE_MS = 150;
// How long after a click/select Atlas watches for the navigation it may have
// started. Playwright no longer waits for one, so without this the page can
// still show the old URL while a request to another origin is on its way.
const NAVIGATION_GRACE_MS = 300;

/** Normalizes an origin string; only http(s) origins can be allowed. */
export function normalizeOrigin(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new BrowserWorkerError("INVALID_ORIGIN", `'${String(candidate).slice(0, 200)}' is not a valid origin.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserWorkerError("INVALID_ORIGIN", `Only http and https origins can be allowed, not '${url.protocol}'.`);
  }
  return url.origin;
}

/** The origin a URL would be judged by, or null when its scheme is never allowed. */
function originOf(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

/** Redacts userinfo and sensitive query parameter values so traces never carry credentials. */
export function sanitizeUrl(candidate) {
  if (typeof candidate !== "string") return candidate;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return candidate.slice(0, 2048);
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  if (url.hash && /=/.test(url.hash)) url.hash = "#[REDACTED]";
  return url.toString().slice(0, 2048);
}

/**
 * Trace sanitizer: any field whose name looks like a credential is redacted,
 * and typed text is redacted unless the session opted into recording it.
 */
export function sanitizeArgs(value, { redactTypedText = true } = {}, key = "") {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (redactTypedText && (key === "text" || key === "value" || key === "values") && value !== undefined) {
    return typeof value === "string" ? `[REDACTED:${value.length} chars]` : "[REDACTED]";
  }
  if (key === "url") return sanitizeUrl(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeArgs(item, { redactTypedText }));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeArgs(v, { redactTypedText }, k)]));
  }
  if (typeof value === "string") return value.slice(0, 500);
  return value;
}

function sha256Bytes(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function boundedInt(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BrowserWorkerError("INVALID_LIMIT", `${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export class BrowserWorker {
  #browser = null;
  #launching = null;
  #sessions = new Map();
  #closed = new Map();
  #options;

  /**
   * @param {object} [options]
   * @param {string[]} [options.allowedOrigins]  ceiling: sessions may only allow a subset of these.
   *   When omitted, every session must name its own non-empty allow-list.
   * @param {number} [options.maxSessions=4]
   * @param {object} [options.defaults]  default session limits (see DEFAULT_SESSION_LIMITS)
   * @param {string} [options.executablePath]  Chromium binary; falls back to env ATLAS_CHROMIUM_EXECUTABLE,
   *   then to Playwright's own resolution through PLAYWRIGHT_BROWSERS_PATH.
   * @param {boolean} [options.headless=true]
   * @param {object} [options.playwright]  injected playwright-core module (tests / alternative builds)
   * @param {() => Date} [options.clock]
   */
  constructor(options = {}) {
    const ceiling = options.allowedOrigins === undefined ? null : new Set(options.allowedOrigins.map(normalizeOrigin));
    this.#options = {
      ceiling,
      maxSessions: boundedInt(options.maxSessions, 4, 1, 64, "maxSessions"),
      defaults: { ...DEFAULT_SESSION_LIMITS, ...(options.defaults ?? {}) },
      executablePath: options.executablePath ?? process.env.ATLAS_CHROMIUM_EXECUTABLE ?? undefined,
      headless: options.headless ?? true,
      playwright: options.playwright ?? null,
      clock: options.clock ?? (() => new Date()),
      onEvent: typeof options.onEvent === "function" ? options.onEvent : null,
      // Connect-time private-address policy for the egress proxy
      // (./address-guard.mjs): allowed hostnames may not resolve to
      // loopback/LAN/metadata addresses unless named explicitly.
      egress: {
        allowPrivateNetwork: options.allowPrivateNetwork === true,
        lookup: typeof options.lookup === "function" ? options.lookup : undefined,
        allowPrivateHosts: options.allowPrivateHosts,
      },
      downloadDirectory: options.downloadDirectory ?? null,
    };
  }

  async #launch() {
    if (this.#browser?.isConnected()) return this.#browser;
    if (!this.#launching) {
      this.#launching = (async () => {
        const playwright = this.#options.playwright ?? (await import("playwright-core"));
        try {
          const browser = await playwright.chromium.launch({
            headless: this.#options.headless,
            executablePath: this.#options.executablePath,
            // Playwright disables the Chromium sandbox by default when running as
            // root in containers; the worker's isolation is the disposable context
            // plus the network confinement, not the OS sandbox alone.
          });
          this.#browser = browser;
          return browser;
        } catch (error) {
          throw new BrowserWorkerError("NO_BROWSER", `Chromium could not be launched: ${error?.message?.split("\n")[0] ?? error}`);
        } finally {
          this.#launching = null;
        }
      })();
    }
    return this.#launching;
  }

  #emit(type, payload) {
    try {
      this.#options.onEvent?.({ type, payload, at: nowIso(this.#options.clock) });
    } catch {
      // An observer must never break the worker.
    }
  }

  /** Creates a disposable, isolated session. Returns its id and effective limits. */
  async createSession(opts = {}) {
    if (this.#sessions.size >= this.#options.maxSessions) {
      throw new BrowserWorkerError("TOO_MANY_SESSIONS", `At most ${this.#options.maxSessions} browser sessions may be open at once.`);
    }
    const defaults = this.#options.defaults;
    const requested = opts.allowedOrigins ?? (this.#options.ceiling ? [...this.#options.ceiling] : []);
    const allowedOrigins = new Set(requested.map(normalizeOrigin));
    if (allowedOrigins.size === 0) {
      throw new BrowserWorkerError("NO_ALLOWED_ORIGINS", "A session must name at least one allowed origin; everything else is denied.");
    }
    if (this.#options.ceiling) {
      const outside = [...allowedOrigins].filter((origin) => !this.#options.ceiling.has(origin));
      if (outside.length) {
        throw new BrowserWorkerError("ORIGIN_NOT_PERMITTED", `The worker does not permit these origins: ${outside.join(", ")}.`);
      }
    }
    const maxSessionMs = boundedInt(opts.maxSessionMs, defaults.maxSessionMs, 100, HARD_MAX_SESSION_MS, "maxSessionMs");
    const actionTimeoutMs = boundedInt(opts.actionTimeoutMs, defaults.actionTimeoutMs, 100, HARD_MAX_ACTION_TIMEOUT_MS, "actionTimeoutMs");
    const maxDownloads = boundedInt(opts.maxDownloads, defaults.maxDownloads, 0, 20, "maxDownloads");
    const viewport = {
      width: boundedInt(opts.viewport?.width, defaults.viewport.width, 320, 3840, "viewport.width"),
      height: boundedInt(opts.viewport?.height, defaults.viewport.height, 240, 2160, "viewport.height"),
    };
    const javaScriptEnabled = opts.javaScriptEnabled ?? defaults.javaScriptEnabled;
    const redactTypedText = opts.recordTypedText !== true;

    const browser = await this.#launch();
    const blocked = { count: 0, list: [] };
    const noteBlocked = (url, resourceType) => {
      blocked.count += 1;
      if (blocked.list.length < MAX_BLOCKED_RECORDS) blocked.list.push({ url: sanitizeUrl(url), resourceType, at: nowIso(this.#options.clock) });
    };
    const proxy = await startEgressProxy({ allowedOrigins, onBlocked: noteBlocked, ...this.#options.egress });
    let context;
    try {
      context = await browser.newContext({
        proxy: { server: proxy.server, bypass: "<-loopback>" },
        viewport,
        javaScriptEnabled: Boolean(javaScriptEnabled),
        bypassCSP: false,
        serviceWorkers: "block",
        acceptDownloads: maxDownloads > 0,
        permissions: [],
        ignoreHTTPSErrors: false,
        offline: false,
      });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    context.setDefaultTimeout(actionTimeoutMs);
    context.setDefaultNavigationTimeout(actionTimeoutMs);

    const id = newId("workerSession");
    const session = {
      id,
      context,
      page: null,
      allowedOrigins,
      limits: { maxSessionMs, actionTimeoutMs, maxDownloads, viewport, javaScriptEnabled: Boolean(javaScriptEnabled) },
      redactTypedText,
      proxy,
      trace: [],
      blocked,
      downloads: [],
      createdAt: nowIso(this.#options.clock),
      expiresAt: new Date(this.#options.clock().getTime() + maxSessionMs).toISOString(),
      queue: Promise.resolve(),
      closed: false,
      closeReason: null,
      timer: null,
    };

    const isAllowed = (url) => {
      const origin = originOf(url);
      return origin !== null && allowedOrigins.has(origin);
    };
    session.isAllowed = isAllowed;

    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isAllowed(url)) return route.continue().catch(() => {});
      noteBlocked(url, route.request().resourceType());
      return route.abort("blockedbyclient").catch(() => {});
    });
    await context.routeWebSocket(/.*/, (ws) => {
      if (isAllowed(ws.url())) {
        ws.connectToServer();
      } else {
        noteBlocked(ws.url(), "websocket");
        ws.close({ code: 1008, reason: "Blocked by Atlas origin policy" }).catch?.(() => {});
      }
    });

    // One page per session; popups are closed rather than followed.
    context.on("page", (popup) => {
      if (session.page && popup !== session.page) {
        this.#record(session, "popup_blocked", { url: popup.url() }, { ok: true });
        popup.close().catch(() => {});
      }
    });

    session.page = await context.newPage();
    session.page.on("download", async (download) => {
      if (session.downloads.length >= maxDownloads) {
        this.#record(session, "download_refused", { url: download.url() }, { ok: false, error: "DOWNLOAD_LIMIT" });
        await download.cancel().catch(() => {});
        return;
      }
      session.downloads.push({ suggestedFilename: download.suggestedFilename().slice(0, 200), url: sanitizeUrl(download.url()) });
    });
    session.page.on("dialog", (dialog) => {
      // Page dialogs are untrusted; dismiss them so a page cannot stall the session.
      this.#record(session, "dialog_dismissed", { type: dialog.type() }, { ok: true });
      dialog.dismiss().catch(() => {});
    });

    session.timer = setTimeout(() => {
      this.closeSession(id, { reason: "expired" }).catch(() => {});
    }, maxSessionMs);
    session.timer.unref?.();

    this.#sessions.set(id, session);
    this.#record(session, "create_session", { allowedOrigins: [...allowedOrigins], ...session.limits }, { ok: true });
    this.#emit("worker_session.opened", { sessionId: id, allowedOrigins: [...allowedOrigins] });
    return this.describeSession(id);
  }

  describeSession(sessionId) {
    const session = this.#sessions.get(sessionId) ?? this.#closed.get(sessionId);
    if (!session) throw new BrowserWorkerError("SESSION_NOT_FOUND", `No browser session '${sessionId}'.`);
    return {
      sessionId: session.id,
      open: !session.closed,
      closeReason: session.closeReason,
      allowedOrigins: [...session.allowedOrigins],
      limits: session.limits,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      blockedRequestCount: session.blocked.count,
      blockedRequests: session.blocked.list.slice(),
      downloads: session.downloads.slice(),
    };
  }

  /** The sanitized, ordered action trace; still available after the session closes. */
  getTrace(sessionId) {
    const session = this.#sessions.get(sessionId) ?? this.#closed.get(sessionId);
    if (!session) throw new BrowserWorkerError("SESSION_NOT_FOUND", `No browser session '${sessionId}'.`);
    return session.trace.map((entry) => ({ ...entry }));
  }

  #record(session, action, args, { ok, error = null, url = undefined }) {
    if (session.trace.length >= MAX_TRACE_ENTRIES) return;
    let pageUrl = url;
    if (pageUrl === undefined) {
      try {
        pageUrl = session.page && !session.page.isClosed() ? session.page.url() : null;
      } catch {
        pageUrl = null;
      }
    }
    session.trace.push({
      seq: session.trace.length + 1,
      action,
      args: sanitizeArgs(args ?? {}, { redactTypedText: session.redactTypedText }),
      url: pageUrl ? sanitizeUrl(pageUrl) : null,
      ok,
      error,
      at: nowIso(this.#options.clock),
    });
  }

  #open(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (session) return session;
    const closed = this.#closed.get(sessionId);
    if (closed) {
      throw new BrowserWorkerError(closed.closeReason === "expired" ? "SESSION_EXPIRED" : "SESSION_CLOSED", `Browser session '${sessionId}' is closed (${closed.closeReason}).`);
    }
    throw new BrowserWorkerError("SESSION_NOT_FOUND", `No browser session '${sessionId}'.`);
  }

  /** Runs one action serialized per session, tracing its outcome. */
  async #act(sessionId, action, args, fn) {
    const session = this.#open(sessionId);
    const run = async () => {
      if (session.closed) throw new BrowserWorkerError("SESSION_CLOSED", `Browser session '${sessionId}' is closed (${session.closeReason}).`);
      try {
        let result;
        for (let attempt = 1; ; attempt += 1) {
          try { result = await fn(session); break; }
          catch (error) {
            const message = String(error?.message ?? "");
            const retryable = !session.closed && (error?.name === "TimeoutError" || error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT" || error?.code === "EAI_AGAIN" || /^net::ERR_(ABORTED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)/u.test(message));
            if (!retryable || attempt >= ACTION_RETRY_ATTEMPTS) throw error;
            await new Promise((resolve) => setTimeout(resolve, ACTION_RETRY_BASE_MS * 2 ** (attempt - 1)));
          }
        }
        this.#record(session, action, args, { ok: true });
        return result;
      } catch (error) {
        const wrapped = error instanceof BrowserWorkerError
          ? error
          : session.closed
            ? new BrowserWorkerError(session.closeReason === "expired" ? "SESSION_EXPIRED" : "SESSION_CLOSED", `Browser session closed during '${action}' (${session.closeReason}).`)
            : new BrowserWorkerError(error?.name === "TimeoutError" ? "ACTION_TIMEOUT" : "ACTION_FAILED", String(error?.message ?? error).split("\n")[0].slice(0, 500));
        this.#record(session, action, args, { ok: false, error: wrapped.code });
        if (wrapped.closeSession && !session.closed) await this.closeSession(sessionId, { reason: wrapped.code.toLowerCase() });
        throw wrapped;
      }
    };
    const next = session.queue.then(run, run);
    session.queue = next.catch(() => {});
    return next;
  }

  #assertNavigable(session, candidate) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new BrowserWorkerError("INVALID_URL", "That is not a valid absolute URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BrowserWorkerError("UNSUPPORTED_SCHEME", `Only http and https URLs can be opened, not '${url.protocol}'.`);
    }
    if (url.username || url.password) {
      throw new BrowserWorkerError("CREDENTIALS_IN_URL", "URLs carrying credentials are refused.");
    }
    if (!session.allowedOrigins.has(url.origin)) {
      throw new BrowserWorkerError("ORIGIN_NOT_ALLOWED", `Origin '${url.origin}' is not in this session's allow-list.`);
    }
    return url.toString();
  }

  /** Checks the page is still on an allowed origin; leaving it closes the session. */
  #assertStillConfined(session, urlBefore) {
    const urlAfter = session.page.url();
    if (urlAfter === "about:blank" || session.isAllowed(urlAfter)) return urlAfter;
    throw this.#leftOrigins(urlBefore, urlAfter);
  }

  #leftOrigins(urlBefore, urlAfter) {
    const error = new BrowserWorkerError(
      "LEFT_ALLOWED_ORIGINS",
      `The page left the allowed origins (now at '${sanitizeUrl(urlAfter).slice(0, 200)}'); the session was closed.`,
      { urlBefore: sanitizeUrl(urlBefore), urlAfter: sanitizeUrl(urlAfter) },
    );
    error.closeSession = true;
    return error;
  }

  /**
   * Runs an action that can navigate and judges confinement by the
   * navigation it started, not only by the URL shown when it returns: a
   * main-frame navigation request to a disallowed origin (issued during the
   * action or within NAVIGATION_GRACE_MS after it) closes the session even
   * though the egress layer blocks the request itself. An allowed navigation
   * is waited for, then the resulting URL is checked as before.
   */
  async #confinedAction(session, urlBefore, run) {
    const page = session.page;
    const isNavigation = (request) => request.isNavigationRequest() && request.frame() === page.mainFrame();
    const navigations = [];
    const onRequest = (request) => { if (isNavigation(request)) navigations.push(request); };
    page.on("request", onRequest);
    let value;
    try {
      value = await run();
      if (navigations.length === 0) await page.waitForEvent("request", { predicate: isNavigation, timeout: NAVIGATION_GRACE_MS }).catch(() => null);
    } finally {
      page.off("request", onRequest);
    }
    const offOrigin = navigations.find((request) => !session.isAllowed(request.url()));
    if (offOrigin) throw this.#leftOrigins(urlBefore, offOrigin.url());
    if (navigations.length > 0) {
      const last = navigations.at(-1);
      await Promise.race([last.response().catch(() => null), new Promise((resolve) => setTimeout(resolve, session.limits.actionTimeoutMs))]);
    }
    await this.#settle(session);
    return { value, urlAfter: this.#assertStillConfined(session, urlBefore) };
  }

  #locator(session, target) {
    const page = session.page;
    if (!target || typeof target !== "object") throw new BrowserWorkerError("INVALID_TARGET", "A target is required.");
    const exact = target.exact ?? false;
    if (target.testId) return page.getByTestId(target.testId);
    if (target.role) return page.getByRole(target.role, target.name !== undefined ? { name: target.name, exact } : {});
    if (target.label) return page.getByLabel(target.label, { exact });
    if (target.text) return page.getByText(target.text, { exact });
    if (target.selector && target.allowSelector) return page.locator(target.selector);
    throw new BrowserWorkerError("INVALID_TARGET", "Identify an element by {role, name}, {testId}, {label} or {text}.");
  }

  async #single(session, target) {
    const locator = this.#locator(session, target);
    const count = await locator.count();
    if (count === 0) throw new BrowserWorkerError("ELEMENT_NOT_FOUND", "No element matches that target.");
    if (count > 1) throw new BrowserWorkerError("AMBIGUOUS_TARGET", `${count} elements match that target; be more specific.`);
    return locator;
  }

  async #settle(session) {
    await session.page.waitForLoadState("domcontentloaded", { timeout: session.limits.actionTimeoutMs }).catch(() => {});
  }

  async navigate(sessionId, { url } = {}) {
    return this.#act(sessionId, "navigate", { url }, async (session) => {
      const target = this.#assertNavigable(session, url);
      const urlBefore = session.page.url();
      let response = null;
      try {
        response = await session.page.goto(target, { waitUntil: "domcontentloaded", timeout: session.limits.actionTimeoutMs });
      } catch (error) {
        // An aborted redirect to a disallowed origin surfaces as a navigation error.
        const finalUrl = session.page.url();
        if (!session.isAllowed(finalUrl) && finalUrl !== "about:blank") this.#assertStillConfined(session, urlBefore);
        if (/ERR_BLOCKED_BY_CLIENT/.test(String(error?.message))) {
          const blocked = new BrowserWorkerError("LEFT_ALLOWED_ORIGINS", "Navigation was redirected to a disallowed origin and blocked; the session was closed.");
          blocked.closeSession = true;
          throw blocked;
        }
        throw error;
      }
      const urlAfter = this.#assertStillConfined(session, urlBefore);
      return {
        url: urlAfter,
        status: response?.status() ?? null,
        title: (await session.page.title().catch(() => "")).slice(0, 300),
        postcondition: { urlBefore, urlAfter, originAllowed: true },
        untrusted: true,
      };
    });
  }

  /** Semantic accessibility snapshot (ARIA YAML) of the page. */
  async inspectAccessibility(sessionId, { maxChars = 40_000 } = {}) {
    return this.#act(sessionId, "inspect_accessibility", {}, async (session) => {
      const snapshot = await session.page.locator("body").ariaSnapshot({ timeout: session.limits.actionTimeoutMs });
      return {
        url: session.page.url(),
        format: "aria-yaml",
        snapshot: snapshot.slice(0, maxChars),
        truncated: snapshot.length > maxChars,
        untrusted: true,
      };
    });
  }

  /**
   * Structured accessibility-first snapshot used by the local control plane's
   * browser session adapter. The extra `target` field is for the adapter; it
   * is ignored by callers that only need human-readable content.
   */
  async snapshot(sessionId, { maxChars = 40_000, maxElements = 250 } = {}) {
    return this.#act(sessionId, "snapshot", { maxChars, maxElements }, async (session) => {
      const text = await session.page.locator("body").ariaSnapshot({ timeout: session.limits.actionTimeoutMs }).catch(() => "");
      const locators = await session.page.locator("a, button, input, textarea, select, [role=button], [role=link], [role=textbox]").all().catch(() => []);
      const elements = [];
      for (const [index, locator] of locators.slice(0, maxElements).entries()) {
        const detail = await describeInteractiveElement(locator).catch(() => null);
        if (!detail?.name) continue;
        elements.push({
          ref: `e${index + 1}`,
          role: detail.role,
          name: detail.name.slice(0, 200),
          value: detail.value,
          target: { role: detail.role, name: detail.name.slice(0, 200), exact: true },
        });
      }
      return {
        url: session.page.url(),
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        elements,
        untrusted: true,
      };
    });
  }

  async inspectDom(sessionId, { selector = "body", maxChars = 20_000 } = {}) {
    return this.#act(sessionId, "inspect_dom", { selector, maxChars }, async (session) => {
      const locator = session.page.locator(selector).first();
      if ((await session.page.locator(selector).count()) === 0) throw new BrowserWorkerError("ELEMENT_NOT_FOUND", "No element matches that selector.");
      const html = await locator.evaluate((node) => node.outerHTML);
      return { url: session.page.url(), selector, html: html.slice(0, maxChars), truncated: html.length > maxChars, untrusted: true };
    });
  }

  async screenshot(sessionId, { fullPage = false } = {}) {
    return this.#act(sessionId, "screenshot", { fullPage }, async (session) => {
      const buffer = await session.page.screenshot({ type: "png", fullPage: Boolean(fullPage), timeout: session.limits.actionTimeoutMs });
      return {
        mediaType: "image/png",
        bytes: buffer.toString("base64"),
        byteLength: buffer.length,
        digest: sha256Bytes(buffer),
        url: session.page.url(),
        capturedAt: nowIso(this.#options.clock),
        untrusted: true,
      };
    });
  }

  async #consequentialClick(session, target, action) {
    const urlBefore = session.page.url();
    const locator = await this.#single(session, target);
    const { urlAfter } = await this.#confinedAction(session, urlBefore, () => locator.click({ timeout: session.limits.actionTimeoutMs }));
    return {
      action,
      postcondition: {
        urlBefore,
        urlAfter,
        navigated: urlBefore !== urlAfter,
        title: (await session.page.title().catch(() => "")).slice(0, 300),
      },
      untrusted: true,
    };
  }

  async click(sessionId, target = {}) {
    return this.#act(sessionId, "click", { target }, (session) => this.#consequentialClick(session, target, "click"));
  }

  /** Clicks a control that sends something (submit/buy/post). Callers must treat it as consequential. */
  async submit(sessionId, target = {}) {
    return this.#act(sessionId, "submit", { target }, (session) => this.#consequentialClick(session, target, "submit"));
  }

  async type(sessionId, { target, text, clear = true } = {}) {
    return this.#act(sessionId, "type", { target, text }, async (session) => {
      if (typeof text !== "string") throw new BrowserWorkerError("INVALID_INPUT", "text must be a string.");
      const urlBefore = session.page.url();
      const locator = await this.#single(session, target);
      if (clear) await locator.fill(text);
      else await locator.pressSequentially(text);
      const readBack = await locator.inputValue().catch(() => null);
      const urlAfter = this.#assertStillConfined(session, urlBefore);
      return {
        postcondition: {
          urlBefore,
          urlAfter,
          valueMatches: readBack === null ? null : clear ? readBack === text : readBack.endsWith(text),
          length: text.length,
        },
      };
    });
  }

  async select(sessionId, { target, values } = {}) {
    return this.#act(sessionId, "select", { target, values }, async (session) => {
      const list = Array.isArray(values) ? values : [values];
      const urlBefore = session.page.url();
      const locator = await this.#single(session, target);
      const { value: selected, urlAfter } = await this.#confinedAction(session, urlBefore, () => locator.selectOption(list.map(String)));
      return { postcondition: { urlBefore, urlAfter, selected, allSelected: list.every((v) => selected.includes(String(v))) } };
    });
  }

  async scroll(sessionId, { direction = "down", pixels = 600, target } = {}) {
    return this.#act(sessionId, "scroll", { direction, pixels, target }, async (session) => {
      if (target) {
        const locator = await this.#single(session, target);
        await locator.scrollIntoViewIfNeeded();
      } else {
        const dy = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
        const dx = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
        await session.page.mouse.wheel(dx, dy);
        await session.page.waitForTimeout(50);
      }
      const position = await session.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => null);
      return { url: session.page.url(), position };
    });
  }

  /** Waits for a load state, or for a target to reach a visibility state. */
  async waitForState(sessionId, { loadState, target, state = "visible", timeoutMs } = {}) {
    return this.#act(sessionId, "wait_for_state", { loadState, target, state, timeoutMs }, async (session) => {
      const timeout = Math.min(timeoutMs ?? session.limits.actionTimeoutMs, session.limits.actionTimeoutMs);
      if (target) {
        await this.#locator(session, target).first().waitFor({ state, timeout });
      } else {
        await session.page.waitForLoadState(loadState ?? "load", { timeout });
      }
      this.#assertStillConfined(session, session.page.url());
      return { url: session.page.url(), reached: target ? state : loadState ?? "load" };
    });
  }

  /**
   * Extracts text values. Output is data from an untrusted page: it is
   * returned verbatim, flagged untrusted, and never acted on here.
   */
  async extract(sessionId, { fields } = {}) {
    return this.#act(sessionId, "extract", { fields: Object.keys(fields ?? {}) }, async (session) => {
      if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
        throw new BrowserWorkerError("INVALID_INPUT", "Name at least one field to extract.");
      }

      async download(sessionId, { target, toPath = null } = {}) {
        return this.#act(sessionId, "download", { target, toPath }, async (session) => {
          if (session.limits.maxDownloads <= 0) {
            throw new BrowserWorkerError("DOWNLOADS_DISABLED", "This browser session was opened without download permission.");
          }
          const locator = await this.#single(session, target);
          const [download] = await Promise.all([
            session.page.waitForEvent("download", { timeout: session.limits.actionTimeoutMs }),
            locator.click({ timeout: session.limits.actionTimeoutMs }),
          ]);
          const targetPath = toPath || join(this.#options.downloadDirectory ?? process.cwd(), download.suggestedFilename().slice(0, 200));
          await mkdir(dirname(targetPath), { recursive: true });
          await download.saveAs(targetPath);
          await this.#settle(session);
          const urlAfter = this.#assertStillConfined(session, session.page.url());
          return { path: targetPath, url: urlAfter, suggestedFilename: download.suggestedFilename().slice(0, 200), untrusted: true };
        });
      }
      const values = {};
      const missing = [];
      for (const [name, spec] of Object.entries(fields)) {
        const locator = this.#locator(session, { ...spec, allowSelector: true });
        const count = await locator.count();
        if (count === 0) {
          values[name] = null;
          missing.push(name);
          continue;
        }

        async function describeInteractiveElement(locator) {
          return locator.evaluate((node) => {
            const trim = (value) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
            const attr = (name) => trim(node.getAttribute?.(name) ?? "");
            const role = attr("role") || (
              node.tagName === "A" ? "link"
                : node.tagName === "BUTTON" ? "button"
                  : node.tagName === "SELECT" ? "combobox"
                    : node.tagName === "TEXTAREA" ? "textbox"
                      : node.tagName === "INPUT"
                        ? ["button", "submit", "reset"].includes((node.type || "").toLowerCase()) ? "button" : "textbox"
                        : trim(node.tagName.toLowerCase())
            );
            const name = attr("aria-label")
              || trim(node.innerText)
              || attr("placeholder")
              || attr("name")
              || attr("value");
            const value = ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) ? trim(node.value ?? "") : null;
            return { role, name, value: value || null };
          });
        }
        if (count > 1) throw new BrowserWorkerError("AMBIGUOUS_TARGET", `Field '${name}' matches ${count} elements.`);
        const value = await locator.evaluate((node) =>
          ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) ? node.value : (node.innerText ?? node.textContent ?? ""),
        );
        values[name] = String(value).trim().slice(0, 10_000);
      }
      return { url: session.page.url(), values, missing, untrusted: true };
    });
  }

  async closeSession(sessionId, { reason = "closed" } = {}) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      const closed = this.#closed.get(sessionId);
      if (closed) return { sessionId, closed: true, reason: closed.closeReason, alreadyClosed: true };
      throw new BrowserWorkerError("SESSION_NOT_FOUND", `No browser session '${sessionId}'.`);
    }
    session.closed = true;
    session.closeReason = reason;
    clearTimeout(session.timer);
    this.#sessions.delete(sessionId);
    this.#closed.set(sessionId, session);
    if (this.#closed.size > 256) this.#closed.delete(this.#closed.keys().next().value);
    this.#record(session, "close_session", { reason }, { ok: true, url: null });
    await session.context.close().catch(() => {});
    await session.proxy.close().catch(() => {});
    session.context = null;
    session.page = null;
    this.#emit("worker_session.closed", { sessionId, reason });
    return { sessionId, closed: true, reason, traceLength: session.trace.length };
  }

  /** Closes every session and the browser process. */
  async closeAll() {
    await Promise.all([...this.#sessions.keys()].map((id) => this.closeSession(id, { reason: "worker_shutdown" })));
    const browser = this.#browser;
    this.#browser = null;
    await browser?.close().catch(() => {});
  }

  get openSessionCount() {
    return this.#sessions.size;
  }
}
