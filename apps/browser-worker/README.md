# @atlas/browser-worker

Execution-plane browser worker for Atlas. It lives outside `apps/local-control`
so the control plane stays dependency-free. Its only dependency is
`playwright-core`, pinned at an exact version.

## Run

```sh
cd apps/browser-worker
npm install          # installs playwright-core 1.56.1; never runs `playwright install`
npm test             # node --test tests/*.test.mjs
```

### Browser executable

`playwright-core@1.56.1` expects Chromium revision **1194** (Chromium 141.0.7390.37).
The worker finds the browser in this order:

1. `new BrowserWorker({ executablePath })`
2. env `ATLAS_CHROMIUM_EXECUTABLE`
3. Playwright's own lookup under `PLAYWRIGHT_BROWSERS_PATH` (for example `/opt/pw-browsers/chromium-1194`)

If Chromium cannot launch, the Chromium tests fail with `NO_BROWSER`. They are
skipped only when `ATLAS_BROWSER_TESTS=skip` is set.

## API

```js
import { BrowserWorker, browserToolDefinitions, verifyExtraction } from "@atlas/browser-worker";

const worker = new BrowserWorker({
  allowedOrigins: ["https://shop.example"], // the ceiling; each session may allow only a subset
  maxSessions: 4,
  defaults: { maxSessionMs: 300_000, actionTimeoutMs: 15_000 },
});
const { sessionId } = await worker.createSession({ allowedOrigins: ["https://shop.example"] });
await worker.navigate(sessionId, { url: "https://shop.example/" });
await worker.click(sessionId, { role: "link", name: "View quote" });
const { values } = await worker.extract(sessionId, { fields: { total: { testId: "quote-total" } } });
verifyExtraction({ artifactContent: { values }, expected: { total: { pattern: "[\\d,]+\\.\\d{2}" } } });
await worker.closeSession(sessionId);
await worker.closeAll();
```

The worker has these methods: `createSession`, `navigate`, `inspectAccessibility`
(ARIA snapshot), `inspectDom`, `screenshot`, `click`, `submit`, `type`, `select`,
`scroll`, `waitForState`, `extract`, `closeSession`, `closeAll`, `getTrace` and
`describeSession`.

To target an element, pass one of these: `{role, name?, exact?}`, `{testId}`, `{label}` or `{text}`.
`extract` also accepts `{selector}`. The target must match exactly one element.
If it matches none, the call fails with `ELEMENT_NOT_FOUND`. If it matches more
than one, the call fails with `AMBIGUOUS_TARGET`.

`browserToolDefinitions(worker)` returns `defineTool` objects:

| Tool | Risk | Consequential |
|---|---|---|
| `browser.create_session`, `browser.navigate`, `browser.scroll`, `browser.close_session` | low | no |
| `browser.inspect_accessibility`, `browser.inspect_dom`, `browser.screenshot`, `browser.extract`, `browser.wait_for_state` | read | no |
| `browser.click`, `browser.type`, `browser.select` | moderate | no |
| `browser.submit` (requires `intent`) | high | **yes** |

Every input schema sets `additionalProperties: false`, including the nested
`target` and extract `fields` schemas. Each tool's `execute(input, context)`
returns `{ output, evidence? }`.

## Security model

- **Disposable isolation.** Each session gets a fresh `browser.newContext()`.
  There is no persisted profile, cookie jar or storage. Service workers are
  blocked, no permissions are granted, `bypassCSP` is false and HTTPS errors are
  not ignored. Closing a session discards the context and its egress proxy.
- **Network-destination limit.** All destinations are denied unless listed.
  There are two layers:
  1. `context.route("**/*")` aborts any request whose origin is not allowed or
     whose scheme is not http(s). This covers navigations, subresources and
     fetch/XHR. `context.routeWebSocket` closes WebSockets to disallowed origins.
  2. Every context sends its traffic through a per-session local **egress
     proxy**, with loopback included through `<-loopback>`. The proxy checks
     every HTTP request, every **redirect hop**, every CONNECT tunnel and every
     upgrade against the allow-list. Route interception cannot see redirect
     hops, so a 302 from an allowed page to a disallowed origin would otherwise
     reach that origin. The tests verify that the disallowed server receives
     zero requests.
- **URL checks.** Only `http:` and `https:` URLs are accepted. `file:`,
  `javascript:`, `data:` and other schemes are refused before navigation, as
  are URLs with embedded credentials. After a navigation or a
  click/type/select/submit, the final URL must still be on an allowed origin.
  If it is not (for example after a redirect or an off-site link), the call
  fails with `LEFT_ALLOWED_ORIGINS` and the session is closed.
- **Postconditions.** Click and submit return
  `{postcondition: {urlBefore, urlAfter, navigated, title}}`. Type returns
  `valueMatches`, which comes from reading the field value back. Select
  returns the selected values. Navigate returns `originAllowed`.
- **Limits.** `maxSessionMs` is a wall-clock limit (default 5 min, maximum
  1 h); when it runs out, the session is closed automatically with the reason
  `expired`. `actionTimeoutMs` is the per-action timeout (default 15 s). The
  `viewport` and `javaScriptEnabled` settings are configurable. Downloads are
  disabled by default. With `maxDownloads` above 0 they are accepted up to
  that limit, and later downloads are cancelled. Popups are closed, dialogs
  are dismissed, and at most `maxSessions` sessions can be open at once.
- **Untrusted content.** Page text is data. The outputs of inspect, extract,
  navigate and screenshot carry `untrusted: true` and are returned as they
  are. They are never interpreted as instructions.
- **Sanitized trace.** Each session keeps an ordered trace of
  `{seq, action, args, url, ok, error, at}`. Trace fields with names like
  password, token, secret, api key, cookie or credential are redacted. Typed
  text and selected values are redacted by default as `[REDACTED:n chars]`.
  Sensitive query parameters in URLs are redacted, and extracted values are
  never written to the trace.

## Not implemented

- Authenticated per-user sessions with encrypted storage-state persistence. Every session starts logged out and is thrown away when it closes.
- File uploads, and saving downloads to durable storage.
- Pausing for CAPTCHA or MFA with a human handoff.
- A vision or coordinate fallback when semantic locators fail.
- Remote or cloud hosting of the worker. It runs in-process with the caller on
  the local machine. It has no RPC or HTTP surface and no multi-tenant quota.
- DNS-rebinding defenses. The allow-list is matched on hostname and port, not
  on resolved IP addresses.
