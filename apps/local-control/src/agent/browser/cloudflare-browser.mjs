import { InfrastructureError, createApiClient } from "../../agent/infrastructure/adapter.mjs";

/**
 * Cloudflare Browser Rendering, behind the same page contract Playwright and
 * the fixture browser implement.
 *
 * That shared contract is what gives approval parity for free: a hosted page
 * is driven by the same operator session, so it classifies the same actions,
 * asks for the same approvals, and records the same evidence. There is no
 * second, laxer path for hosted execution.
 */
export function createCloudflareBrowserProvider({ accountId, token, fetchImpl = fetch }) {
  if (!accountId || !token) throw new InfrastructureError("NO_CREDENTIAL", "Cloudflare Browser Rendering needs an account id and a scoped token.");
  const call = createApiClient({
    root: `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`,
    headers: { authorization: `Bearer ${token}` },
    fetchImpl,
    timeoutMs: 120_000,
  });

  return {
    provider: "cloudflare-browser-rendering",

    async createPage({ tenantScope, signal }) {
      let current = "about:blank";
      let lastElements = new Map();

      // Every call carries the tenant scope, so the provider's own session
      // isolation is keyed on it too rather than on our word alone.
      const act = (path, body) => call(path, { method: "POST", body: { ...body, scope: tenantScope }, signal });

      return {
        async url() { return current; },
        async title() { return (await act("/content", { url: current, extract: "title" }))?.result?.title ?? ""; },

        async snapshot() {
          const result = (await act("/snapshot", { url: current }))?.result ?? {};
          // Truncated once, here, so the name the operator is shown and the
          // name the approval digest covers are the same string the adapter
          // holds — they used to diverge for anything over 200 characters.
          lastElements = new Map((result.elements ?? []).map((element, index) => [
            `e${index + 1}`,
            { ...element, name: String(element.name ?? "").slice(0, 200) },
          ]));
          return {
            text: String(result.text ?? "").slice(0, 200_000),
            elements: [...lastElements.entries()].map(([ref, element]) => ({
              ref,
              role: element.role ?? "element",
              name: element.name,
              value: element.value ?? null,
            })),
          };
        },

        async goto({ url }) { await act("/goto", { url }); current = url; },
        async click({ ref }) { await act("/click", { url: current, selector: selectorFor(ref, lastElements) }); },
        async fill({ ref, text }) { await act("/type", { url: current, selector: selectorFor(ref, lastElements), text }); },
        async press({ ref, key }) { await act("/press", { url: current, selector: selectorFor(ref, lastElements), key }); },

        async setInputFiles() {
          // Uploading from a hosted container would mean sending the
          // operator's file to a third party first. That is a different
          // decision from "let Atlas use a browser", so it is refused here
          // rather than quietly performed.
          throw new InfrastructureError("NOT_SUPPORTED", "A hosted browser cannot upload a file from your machine. Run this on your own companion.");
        },

        async download({ toPath }) {
          const result = (await act("/download", { url: current }))?.result ?? {};
          return { path: toPath ?? result.path ?? null };
        },

        async screenshot() {
          const result = await act("/screenshot", { url: current });
          return Buffer.from(result?.result?.image ?? "", "base64");
        },

        async close() { await act("/close", {}).catch(() => {}); },
      };
    },
  };
}

/**
 * The provider's own handle for an element, and nothing else.
 *
 * This used to fall back to `element.name` — the accessible name, i.e. text
 * the page writes. A hostile page could render a decoy whose name is
 * `button[type=submit]`, have the operator approve *that* element, and have
 * the provider execute a CSS selector against a different node entirely. The
 * local adapter documents this exact invariant ("references are assigned by
 * us, not taken from the page"); the hosted path laundered them back through
 * page content.
 */
function selectorFor(ref, elements) {
  const element = elements.get(ref);
  if (!element) throw new InfrastructureError("STALE_REFERENCE", `Reference '${ref}' is not in the current snapshot.`);
  if (!element.selector) {
    throw new InfrastructureError("NO_HANDLE", `The hosted browser did not return a usable handle for '${ref}'. Atlas will not target an element by its page-supplied text.`);
  }
  return element.selector;
}
