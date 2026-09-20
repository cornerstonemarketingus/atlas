import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A Playwright-backed page adapter.
 *
 * This is the production implementation of the page contract the operator
 * session drives; the fixture browser in the Windows companion implements the
 * same contract for tests. Playwright is imported dynamically because the
 * local control plane carries no third-party dependencies of its own: on a
 * machine without it, the browser tools fail closed with "no browser on this
 * machine", which is the honest answer.
 */
export class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserUnavailableError";
    this.code = "NO_BROWSER";
  }
}

export async function createPlaywrightPage({
  profileDirectory,
  channel = process.env.ATLAS_BROWSER_CHANNEL || "msedge",
  headless = process.env.ATLAS_BROWSER_HEADLESS === "1",
  downloadDirectory,
  importPlaywright = () => import("playwright-core"),
} = {}) {
  let playwright;
  try {
    playwright = await importPlaywright();
  } catch {
    throw new BrowserUnavailableError("Playwright is not installed on this machine, so Atlas cannot drive a browser here. Install the Atlas Windows companion, or run browser work on a paired device.");
  }

  await mkdir(profileDirectory, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(profileDirectory, {
    channel,
    headless,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // References are assigned by us, not taken from the page: a page-supplied
  // identifier is attacker-controlled on a hostile site.
  let handles = new Map();

  return {
    async close() { await context.close(); },

    async url() { return page.url(); },
    async title() { return page.title().catch(() => ""); },

    async snapshot() {
      const text = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "");
      const locators = await page.locator("a, button, input, textarea, select, [role=button], [role=link], [role=textbox]").all().catch(() => []);
      handles = new Map();
      const elements = [];
      for (const [index, locator] of locators.slice(0, 250).entries()) {
        const ref = `e${index + 1}`;
        const [role, name, rawValue, secretField] = await Promise.all([
          locator.evaluate((node) => node.getAttribute("role") ?? node.tagName.toLowerCase()).catch(() => "element"),
          accessibleName(locator),
          locator.inputValue().catch(() => null),
          // Decided from the DOM, not from the field's label: `inputValue()`
          // on a password input returns plaintext, and the persistent profile
          // means the browser's own autofill puts credentials there that Atlas
          // never typed. That value used to go straight into the snapshot the
          // model reads.
          locator.evaluate((node) => {
            const type = (node.getAttribute("type") ?? "").toLowerCase();
            const autocomplete = (node.getAttribute("autocomplete") ?? "").toLowerCase();
            return type === "password" || /password|one-time-code|cc-number|cc-csc/u.test(autocomplete);
          }).catch(() => true),
        ]);
        const value = secretField ? "(hidden)" : rawValue;
        if (!name.display) continue;
        handles.set(ref, locator);
        // `name` is what the operator sees; `names` is every string the element
        // offers. Classification runs over the union, so a benign aria-label
        // cannot mask dangerous visible text.
        elements.push({ ref, role, name: name.display.slice(0, 200), names: name.candidates, value });
      }
      return { text, elements };
    },

    async goto({ url }) { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); },
    async click({ ref }) { await locatorFor(ref).click({ timeout: 30_000 }); },
    async fill({ ref, text }) { await locatorFor(ref).fill(text, { timeout: 30_000 }); },
    async press({ ref, key }) { await locatorFor(ref).press(key, { timeout: 30_000 }); },
    async setInputFiles({ ref, path }) { await locatorFor(ref).setInputFiles(path, { timeout: 60_000 }); },

    async download({ ref, toPath }) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 120_000 }),
        locatorFor(ref).click({ timeout: 30_000 }),
      ]);
      const target = toPath ?? join(downloadDirectory, download.suggestedFilename());
      await mkdir(downloadDirectory, { recursive: true });
      await download.saveAs(target);
      return { path: target };
    },

    async screenshot() { return page.screenshot({ fullPage: false }); },
  };

  function locatorFor(ref) {
    const locator = handles.get(ref);
    if (!locator) throw new Error(`Reference '${ref}' is not in the current snapshot.`);
    return locator;
  }

  /**
   * Every name an element offers, not the first one that answers.
   *
   * `aria-label` used to be read first, and it is the one attribute with no
   * relationship to what a control does and nothing stopping a hostile page
   * from setting it: `<button aria-label="Read more" onclick="sendMoney()">
   * Send money</button>` classified as an ordinary click. The classifier is a
   * pure function of this string, so ranking an attacker-chosen field above
   * the visible text inverted the trust order.
   *
   * Visible text leads for display, because that is what the operator sees on
   * screen; the union is what gets classified.
   */
  async function accessibleName(locator) {
    const candidates = [];
    for (const read of [
      () => locator.evaluate((node) => node.innerText?.trim().slice(0, 200) ?? ""),
      () => locator.getAttribute("aria-label"),
      () => locator.getAttribute("title"),
      () => locator.getAttribute("placeholder"),
      () => locator.getAttribute("value"),
      () => locator.getAttribute("name"),
    ]) {
      const value = await read().catch(() => null);
      const cleaned = value ? String(value).replace(/\s+/gu, " ").trim() : "";
      if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
    }
    return { display: candidates[0] ?? "", candidates };
  }
}

/** Screenshots are written to the operator's disk and nowhere else. */
export function createLocalScreenshotStore(directory) {
  return {
    async store({ bytes, url, takenAtMs }) {
      await mkdir(directory, { recursive: true });
      const name = `${new Date(takenAtMs).toISOString().replaceAll(":", "-")}.png`;
      const path = join(directory, name);
      await writeFile(path, bytes, { mode: 0o600 });
      return path;
    },
    directory,
    // Uploading a screenshot is a separate, approval-bound decision; storing
    // one never implies permission to send it anywhere.
    uploadsRequireApproval: true,
  };
}
