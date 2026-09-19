/**
 * A deterministic in-memory browser.
 *
 * The demo workflows have to be safe to run in CI, on any machine, without
 * touching a real site — an operator-automation suite that needs the live
 * internet is a suite nobody runs. This adapter implements the same page
 * contract Playwright does, so the workflows exercise the real session:
 * classification, approval gating, CAPTCHA detection, evidence, and stale
 * references after navigation.
 */
export function createFixtureBrowser({ sites, startUrl }) {
  let current = startUrl;
  let state = {};
  const screenshotsTaken = [];

  const site = () => {
    const found = sites[current];
    if (!found) throw new Error(`The fixture has no page for ${current}.`);
    return typeof found === "function" ? found(state) : found;
  };

  return {
    // --- The page contract the operator session calls. ---
    async url() { return current; },
    async title() { return site().title ?? ""; },

    async snapshot() {
      const page = site();
      return {
        text: page.text ?? "",
        elements: (page.elements ?? []).map((element) => ({ ...element, value: state[element.ref] ?? element.value ?? null })),
      };
    },

    async goto({ url }) {
      if (!sites[url]) throw new Error(`Navigation to ${url} is not in this fixture.`);
      current = url;
    },

    async click({ ref }) {
      const page = site();
      const handler = (page.on ?? {})[ref];
      if (!handler) return;
      if (handler.navigateTo) current = handler.navigateTo;
      if (handler.set) state = { ...state, ...handler.set };
    },

    async fill({ ref, text }) { state = { ...state, [ref]: text }; },
    async press() { /* The fixture has no keyboard-specific behaviour. */ },
    async setInputFiles({ ref, path }) { state = { ...state, [ref]: path }; },
    async download({ toPath }) { return { path: toPath ?? "downloaded-file" }; },
    async screenshot() { screenshotsTaken.push(current); return Buffer.from(`screenshot of ${current}`); },
    async focusApplication({ name }) { return { title: name }; },

    // --- Test helpers. ---
    state: () => ({ ...state }),
    screenshotsTaken,
    goTo: (url) => { current = url; },
  };
}

/** Records screenshots in memory so tests can assert nothing was uploaded. */
export function createMemoryScreenshotStore() {
  const stored = [];
  return {
    stored,
    async store({ bytes, url, takenAtMs }) {
      const path = `local://screenshots/${stored.length + 1}.png`;
      stored.push({ path, bytes, url, takenAtMs });
      return path;
    },
  };
}

/** Approves only the digests it was told to; records everything it was asked. */
export function createScriptedApprovals(allow = () => false) {
  const asked = [];
  return {
    asked,
    async request({ digest, summary, classification, url }) {
      asked.push({ digest, summary, classification, url });
      return allow({ digest, summary, classification, url });
    },
  };
}
