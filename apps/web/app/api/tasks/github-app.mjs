const githubApi = "https://api.github.com";

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function privateKeyBytes(pem) {
  const encoded = pem.replace(/\\n/gu, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, "");
  if (!encoded) throw new Error("GitHub App private key is empty.");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function githubAppConfiguration(environment = process.env) {
  const appId = environment.ATLAS_GITHUB_APP_ID;
  const installationId = environment.ATLAS_GITHUB_INSTALLATION_ID;
  const privateKey = environment.ATLAS_GITHUB_APP_PRIVATE_KEY;
  const slug = environment.ATLAS_GITHUB_APP_SLUG;
  if (!appId || !installationId || !privateKey) return { configured: false, slug: slug || null };
  if (!/^[1-9][0-9]{0,19}$/u.test(appId) || !/^[1-9][0-9]{0,19}$/u.test(installationId)) throw new Error("GitHub App identifiers are invalid.");
  return { configured: true, appId, installationId, privateKey, slug: slug || null };
}

export function githubAppInstallUrl(slug) {
  return typeof slug === "string" && /^[A-Za-z0-9-]{1,100}$/u.test(slug) ? `https://github.com/apps/${slug}/installations/new` : null;
}

export async function createGitHubAppJwt(configuration, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: configuration.appId }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", privateKeyBytes(configuration.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export async function createInstallationToken(configuration, fetcher = fetch) {
  const jwt = await createGitHubAppJwt(configuration);
  const response = await fetcher(`${githubApi}/app/installations/${configuration.installationId}/access_tokens`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "user-agent": "atlas-control-plane", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error("GitHub App installation token request failed.");
  const value = await response.json();
  if (!value || typeof value.token !== "string" || value.token.length < 20) throw new Error("GitHub returned an invalid installation token.");
  return value.token;
}
