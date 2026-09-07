#!/usr/bin/env node
/**
 * Atlas one-time setup.
 *
 *   node scripts/setup.mjs            # interactive
 *   node scripts/setup.mjs --dry-run  # show the plan, change nothing
 *
 * WHY THIS EXISTS, AND WHY IT RUNS ON YOUR MACHINE
 *
 * Setting these secrets could be automated inside the agent instead. It
 * deliberately is not. Writing repository secrets needs a token with admin
 * scope, and handing that to an agent that runs unattended every night, edits
 * its own source, and reads repository content authored by other people would
 * give it a way to escalate its own privileges — overwrite the operator token,
 * or mint itself a wider one. Least privilege is also the thing Atlas sells.
 *
 * So the credentials live in your shell for as long as this script runs and
 * never reach the agent, a repository secret, or a log.
 *
 * WHAT IT DOES NOT DO
 *
 * It never creates or edits a Cloudflare API token. Updating a token means
 * replacing its whole policy set, and getting that wrong would break the
 * working deploy. It probes your token's D1 access read-only and tells you
 * exactly what to add if it is missing.
 *
 * It cannot create the GitHub OAuth App either — GitHub has no API for that,
 * by design. It prints the exact form values and waits for you to paste back
 * the two it gives you.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline/promises";
import process from "node:process";

const REPOSITORY = "cornerstonemarketingus/atlas";
const SITE = "https://atlas-web.cornerstonemarketingus.workers.dev";
const CALLBACK = `${SITE}/api/auth/github/callback`;
const WEBHOOK = `${SITE}/api/billing/webhook`;

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Every secret the Worker reads, in the order it makes sense to set them.
 * `generate` marks the one value that needs no account anywhere — the script
 * offers to mint it rather than making you find a random-string tool.
 */
const SECRETS = [
  {
    name: "ATLAS_SESSION_SECRET",
    group: "sign-in",
    generate: true,
    help: "Signs session cookies. Any long random string; this script can make one.",
  },
  {
    name: "ATLAS_GITHUB_OAUTH_CLIENT_ID",
    group: "sign-in",
    help: "Client ID from the OAuth App (see the printed instructions).",
  },
  {
    name: "ATLAS_GITHUB_OAUTH_CLIENT_SECRET",
    group: "sign-in",
    help: "Client secret from the same OAuth App.",
  },
  {
    name: "ATLAS_STRIPE_SECRET_KEY",
    group: "billing",
    help: "Stripe -> Developers -> API keys -> Secret key.",
  },
  {
    name: "ATLAS_STRIPE_WEBHOOK_SECRET",
    group: "billing",
    help: `Stripe -> Webhooks -> your endpoint (${WEBHOOK}) -> Signing secret.`,
  },
  { name: "ATLAS_STRIPE_PRICE_PRO", group: "billing", help: "Price ID (price_...) for the Pro plan." },
  { name: "ATLAS_STRIPE_PRICE_TEAM", group: "billing", help: "Price ID (price_...) for the Team plan." },
];

function say(text = "") {
  process.stdout.write(`${text}\n`);
}

function heading(text) {
  say(`\n${text}\n${"-".repeat(text.length)}`);
}

/** Runs a command and captures output. Never used with a secret in argv. */
function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

/**
 * Input handling, split deliberately into two paths.
 *
 * PIPED INPUT uses one shared queue fed by readline's `line` events. It cannot
 * use `rl.question()` in a loop: with a pipe, Node drains the whole stream at
 * once and emits every line immediately, so only the FIRST question ever
 * resolves and every later prompt hangs forever. Buffering the lines and
 * handing them out one at a time is the only thing that works.
 *
 * A TERMINAL reading a secret uses raw mode, so typed characters are not
 * echoed into the scrollback of a shared screen. Raw mode is correct here
 * precisely because keystrokes arrive one at a time, which is the case the
 * queue is not needed for.
 */
let reader;
const pendingLines = [];
const waitingResolvers = [];
let inputEnded = false;

function lineReader() {
  if (reader) return reader;
  reader = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  reader.on("line", (line) => {
    const resolve = waitingResolvers.shift();
    if (resolve) resolve(line);
    else pendingLines.push(line);
  });
  reader.on("close", () => {
    inputEnded = true;
    // Anything still waiting gets "" rather than hanging, so a truncated
    // script ends cleanly instead of stalling with no explanation.
    while (waitingResolvers.length > 0) waitingResolvers.shift()("");
  });
  return reader;
}

function closeReader() {
  reader?.close();
  reader = undefined;
}

function nextLine() {
  lineReader();
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
  if (inputEnded) return Promise.resolve("");
  return new Promise((resolve) => waitingResolvers.push(resolve));
}

/** Raw-mode masked read. Only reachable on a terminal. */
function askMasked(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const { stdin } = process;
    let buffer = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onKey = (key) => {
      // Ctrl-C and Ctrl-D must keep working while raw mode is on, or a
      // mistyped paste leaves the terminal wedged with no way out.
      if (key === "\u0003" || key === "\u0004") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onKey);
        stdin.pause();
        say("\nCancelled. Nothing was changed.");
        process.exit(130);
      }
      if (key === "\r" || key === "\n") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onKey);
        stdin.pause();
        process.stdout.write("\n");
        resolve(buffer);
        return;
      }
      if (key === "\u007f" || key === "\b") {
        buffer = buffer.slice(0, -1);
        return;
      }
      buffer += key;
    };
    stdin.on("data", onKey);
  });
}

async function ask(question, { secret = false } = {}) {
  if (secret && process.stdin.isTTY === true) return askMasked(question);
  process.stdout.write(question);
  const answer = await nextLine();
  // Echo a newline for piped input so the transcript stays readable.
  if (process.stdin.isTTY !== true) process.stdout.write("\n");
  return answer;
}

async function confirm(question) {
  const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------- preflight

function preflight() {
  heading("Checking prerequisites");

  const version = run("gh", ["--version"]);
  if (version.error || version.status !== 0) {
    say("The GitHub CLI (gh) is not installed.");
    say("");
    say("This script uses it so that secret encryption is handled by GitHub's");
    say("own tooling rather than re-implemented here. Install it from");
    say("https://cli.github.com, run `gh auth login`, then run this again.");
    return false;
  }
  say(`gh: ${version.stdout.split("\n")[0]}`);

  const auth = run("gh", ["auth", "status"]);
  if (auth.status !== 0) {
    say("gh is installed but not signed in. Run `gh auth login` and try again.");
    return false;
  }
  say("gh: authenticated");
  return true;
}

/** Secret NAMES only. GitHub never returns values, and this never asks for them. */
function existingSecretNames() {
  const listed = run("gh", ["secret", "list", "--repo", REPOSITORY, "--json", "name"]);
  if (listed.status !== 0) {
    say(`\nCould not list repository secrets: ${listed.stderr.trim()}`);
    say("Your token likely lacks admin access to the repository.");
    return null;
  }
  try {
    return new Set(JSON.parse(listed.stdout).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

// ------------------------------------------------------------------ oauth

function printOAuthInstructions() {
  heading("Create the GitHub OAuth App (the one step nothing can automate)");
  say("GitHub has no API for creating OAuth Apps, so this part is yours.");
  say("");
  say("  1. Open https://github.com/settings/applications/new");
  say("  2. Application name:  Atlas");
  say(`  3. Homepage URL:      ${SITE}`);
  say(`  4. Callback URL:      ${CALLBACK}`);
  say("  5. Register, then 'Generate a new client secret'");
  say("");
  say("The callback URL must match exactly — no trailing slash.");
  say("Keep that tab open; you will paste two values in a moment.");
}

// ------------------------------------------------------------- cloudflare

/**
 * Read-only probe. Deliberately does not modify the token: updating one means
 * replacing its entire policy set, and a mistake there breaks the deploy that
 * currently works.
 */
async function checkCloudflareD1(token, accountId) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (response.ok) {
    const body = await response.json();
    const names = (body.result ?? []).map((database) => database.name);
    return { ok: true, names };
  }
  return { ok: false, status: response.status };
}

// -------------------------------------------------------------------- main

async function main() {
  say("Atlas setup");
  say(`Repository: ${REPOSITORY}`);
  if (DRY_RUN) say("DRY RUN — nothing will be changed.");

  if (!preflight()) return 1;

  const existing = existingSecretNames();
  if (existing === null) return 1;

  heading("Current state");
  for (const secret of SECRETS) {
    say(`  ${existing.has(secret.name) ? "set    " : "MISSING"}  ${secret.name}`);
  }

  const missing = SECRETS.filter((secret) => !existing.has(secret.name));
  if (missing.length === 0) {
    say("\nEvery secret is already set. Nothing to do.");
    return 0;
  }

  if (missing.some((secret) => secret.group === "sign-in" && secret.name.includes("OAUTH"))) {
    printOAuthInstructions();
    say("");
    if (!(await confirm("Ready to continue?"))) {
      say("Stopped. Nothing was changed.");
      return 0;
    }
  }

  heading("Collecting values");
  say("Input is hidden. Press Enter with nothing typed to skip a secret.\n");

  const collected = [];
  for (const secret of missing) {
    say(`${secret.name}`);
    say(`  ${secret.help}`);
    let value = "";
    if (secret.generate) {
      if (await confirm("  Generate one automatically?")) {
        value = randomBytes(32).toString("hex");
        say("  Generated (32 random bytes).");
      }
    }
    if (!value) value = (await ask("  Value: ", { secret: true })).trim();
    if (!value) {
      say("  Skipped.\n");
      continue;
    }
    collected.push({ name: secret.name, value });
    say("  Captured.\n");
  }

  if (collected.length === 0) {
    say("Nothing to set.");
    return 0;
  }

  heading("Writing secrets");
  say(`About to set ${collected.length} secret(s): ${collected.map((s) => s.name).join(", ")}`);
  if (DRY_RUN) {
    say("DRY RUN — stopping here without writing.");
    return 0;
  }
  if (!(await confirm("Proceed?"))) {
    say("Stopped. Nothing was changed.");
    return 0;
  }

  let written = 0;
  for (const secret of collected) {
    // The value goes in on stdin, never argv: arguments are visible in the
    // process list to every other user on the machine.
    const result = await new Promise((resolve) => {
      const child = spawn("gh", ["secret", "set", secret.name, "--repo", REPOSITORY], {
        stdio: ["pipe", "inherit", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.end(secret.value);
    });
    if (result.code === 0) {
      say(`  set      ${secret.name}`);
      written += 1;
    } else {
      say(`  FAILED   ${secret.name}: ${result.stderr.trim()}`);
    }
  }
  say(`\n${written} of ${collected.length} secret(s) written.`);

  heading("Cloudflare D1 access");
  say("The database migration needs a Cloudflare token with D1 permission.");
  say("This only READS, to tell you whether yours has it.\n");
  const cfToken = (await ask("Cloudflare API token (Enter to skip): ", { secret: true })).trim();
  if (cfToken) {
    const accountId = (await ask("Cloudflare account ID: ")).trim();
    if (accountId) {
      const probe = await checkCloudflareD1(cfToken, accountId);
      if (probe.ok) {
        say(`\n  D1 access confirmed. Databases: ${probe.names.join(", ") || "(none yet)"}`);
        say("  Use one of those names when running the migrate-d1 workflow.");
      } else {
        say(`\n  D1 access DENIED (HTTP ${probe.status}).`);
        say("  Fix at https://dash.cloudflare.com/profile/api-tokens — edit the token and add:");
        say("    D1: Edit");
        say("    Account Settings: Read");
        say("  This script does not edit tokens: replacing a policy set incorrectly");
        say("  would break the deploy that currently works.");
      }
    }
  } else {
    say("  Skipped.");
  }

  heading("Next");
  say("  1. Re-run the deploy so the Worker picks the secrets up:");
  say(`       gh workflow run deploy-cloudflare.yml --repo ${REPOSITORY} --ref main`);
  say("     Read its 'Upload Worker runtime secrets' step — it prints what landed.");
  say("  2. Apply the database migrations (once D1 access works):");
  say(`       gh workflow run migrate-d1.yml --repo ${REPOSITORY} --ref main \\`);
  say("         -f database_name=<name> -f from_migration=0001 -f dry_run=true");
  say("     Read the SQL, then repeat with dry_run=false.");
  say(`  3. Verify: GET ${SITE}/api/setup/status with your operator token.`);
  return 0;
}

main().then(
  (code) => {
    closeReader();
    process.exit(code);
  },
  (error) => {
    closeReader();
    say(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
