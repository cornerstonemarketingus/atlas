#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

import { createCredentialVault } from "../../apps/local-control/src/agent/credential-vault.mjs";
import { openInBrowser, ownerAccount, resolveOwnerToken, signInUrl } from "../../apps/local-control/src/identity/owner.mjs";

/**
 * Opens the local Atlas app signed in as its owner — this computer's OS
 * account — with no token to copy and no GitHub account. It reads the owner
 * token from this account's vault (or the fallback file), which only this OS
 * user can do, and passes it to the browser in the URL fragment.
 *
 *   node scripts/local/open-atlas.mjs [--print]
 *
 * --print shows the sign-in URL instead of opening a browser (for a browser
 * on another profile). Treat that URL like a password.
 */

const dataDirectory = process.env.ATLAS_LOCAL_DATA_DIR || join(homedir(), ".atlas");
const host = process.env.ATLAS_LOCAL_HOST && !["0.0.0.0", "::"].includes(process.env.ATLAS_LOCAL_HOST) ? process.env.ATLAS_LOCAL_HOST : "127.0.0.1";
const baseUrl = `http://${host}:${Number(process.env.ATLAS_LOCAL_PORT || 4317)}`;

const vault = createCredentialVault({ filePath: join(dataDirectory, "credentials.vault.json") });
const { token, storage, created } = await resolveOwnerToken({ dataDirectory, vault });
const account = ownerAccount();
const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.ok).catch(() => false);
if (!health) console.warn(`Atlas is not answering at ${baseUrl}. Start it first (node apps/local-control/src/main.mjs).`);
if (created) console.warn("A new owner token was created; restart Atlas so it uses it.");
const url = signInUrl(baseUrl, token);
if (process.argv.includes("--print")) {
  console.log(url);
} else if (!openInBrowser(url)) {
  console.log(`Open this address in your browser:\n${url}`);
} else {
  console.log(`Opened Atlas as ${account.user} on ${account.host} (owner token in ${storage === "file" ? "a private file" : `the ${storage} vault`}).`);
}
