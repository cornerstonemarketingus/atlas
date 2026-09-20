import { createPublicKey, publicEncrypt, constants } from "node:crypto";

import { buildPlan, CONFIRMATION, createApiClient, InfrastructureError, redactValue } from "./adapter.mjs";

/**
 * GitHub, GitLab and Forgejo behind one shape: repository settings,
 * variables, secrets, and workflows.
 *
 * Secrets are write-only everywhere here, which matches how all three hosts
 * behave — none of them will hand a secret back, and Atlas does not try. A
 * GitHub secret is sealed with the repository's public key before it leaves
 * this process, so the plaintext never crosses the network at all.
 */
const ROOTS = {
  github: "https://api.github.com",
  gitlab: "https://gitlab.com/api/v4",
};

export function createGitHostAdapter({ host, token, repository, baseUrl = null, fetchImpl = fetch }) {
  if (!token) throw new InfrastructureError("NO_CREDENTIAL", `A ${host} token is required.`);
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "")) throw new InfrastructureError("BAD_REPOSITORY", "repository must be owner/name.");
  const root = baseUrl ?? ROOTS[host];
  if (!root) throw new InfrastructureError("UNKNOWN_HOST", `Unsupported host: ${host}. Use github, gitlab, or a Forgejo base URL.`);

  const headers = host === "gitlab"
    ? { "private-token": token }
    : { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const call = createApiClient({ root, headers, fetchImpl });
  const encoded = encodeURIComponent(repository);

  const api = {
    provider: host,
    repository,

    async settings({ signal } = {}) {
      if (host === "gitlab") {
        const project = await call(`/projects/${encoded}`, { signal });
        return { name: project.path_with_namespace, visibility: project.visibility, defaultBranch: project.default_branch, archived: Boolean(project.archived) };
      }
      const repo = await call(`/repos/${repository}`, { signal });
      return { name: repo.full_name, visibility: repo.private ? "private" : "public", defaultBranch: repo.default_branch, archived: Boolean(repo.archived) };
    },

    async listVariables({ signal } = {}) {
      if (host === "gitlab") {
        const variables = await call(`/projects/${encoded}/variables`, { signal });
        return (variables ?? []).filter((variable) => !variable.masked).map((variable) => ({ name: variable.key, updatedAt: null }));
      }
      const payload = await call(`/repos/${repository}/actions/variables`, { signal });
      return (payload?.variables ?? []).map((variable) => ({ name: variable.name, updatedAt: variable.updated_at ?? null }));
    },

    /** Names and timestamps only; no host will return a secret's value. */
    async listSecrets({ signal } = {}) {
      if (host === "gitlab") {
        const variables = await call(`/projects/${encoded}/variables`, { signal });
        return (variables ?? []).filter((variable) => variable.masked).map((variable) => ({ name: variable.key, updatedAt: null }));
      }
      const payload = await call(`/repos/${repository}/actions/secrets`, { signal });
      return (payload?.secrets ?? []).map((secret) => ({ name: secret.name, updatedAt: secret.updated_at ?? null }));
    },

    async listWorkflows({ signal } = {}) {
      if (host !== "github") return [];
      const payload = await call(`/repos/${repository}/actions/workflows`, { signal });
      return (payload?.workflows ?? []).map((workflow) => ({ id: workflow.id, name: workflow.name, path: workflow.path, state: workflow.state }));
    },

    async planSecret({ name, value, signal }) {
      const existing = (await api.listSecrets({ signal })).some((secret) => secret.name === name);
      return buildPlan({
        provider: host,
        operation: existing ? "rotate" : "create",
        resource: "repository_secret",
        target: `${name} on ${repository}`,
        before: existing ? { name, value: "(present, never readable)" } : null,
        after: { name, value: redactValue(value) },
        reversible: false,
        notes: [
          "Neither this host nor Atlas can read a secret back after it is written.",
          existing ? "Rotating replaces the current value; the old one is not recoverable." : "This creates a new secret.",
          // Said at plan time rather than at apply time. Learning that this
          // cannot work only after approving it wastes the approval and
          // reads as a failure rather than as a known limitation.
          ...(host === "github"
            ? ["GitHub seals secrets with a libsodium key, which needs a native dependency Atlas does not carry, so this will be refused. Set this secret in the repository's own settings."]
            : []),
        ],
      });
    },

    async applySecret({ name, value, signal }) {
      if (host === "gitlab") {
        const existing = (await api.listSecrets({ signal })).some((secret) => secret.name === name);
        const path = `/projects/${encoded}/variables${existing ? `/${encodeURIComponent(name)}` : ""}`;
        await call(path, { method: existing ? "PUT" : "POST", body: { key: name, value, masked: true, protected: false }, signal });
      } else {
        // GitHub seals with the repository's own public key, so the plaintext
        // value is never transmitted.
        const key = await call(`/repos/${repository}/actions/secrets/public-key`, { signal });
        await call(`/repos/${repository}/actions/secrets/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: { encrypted_value: sealSecret(value, key.key), key_id: key.key_id },
          signal,
        });
      }
      // A secret's value is never readable, so this establishes that a
      // secret of that name is now there and nothing about what it holds.
      const after = (await api.listSecrets({ signal })).some((secret) => secret.name === name);
      return { verified: after, confirmation: after ? CONFIRMATION.PRESENCE : null, observed: { name, present: after } };
    },

    async planVariable({ name, value, signal }) {
      const existing = (await api.listVariables({ signal })).some((variable) => variable.name === name);
      return buildPlan({
        provider: host,
        operation: existing ? "update" : "create",
        resource: "repository_variable",
        target: `${name} on ${repository}`,
        before: existing ? { name } : null,
        // A variable is not a secret, so the preview shows the real value.
        after: { name, value },
        reversible: existing,
        notes: ["Variables are not secret; this value is visible to anyone who can read the repository's settings."],
      });
    },

    async applyVariable({ name, value, signal }) {
      if (host === "gitlab") {
        const existing = (await api.listVariables({ signal })).some((variable) => variable.name === name);
        const path = `/projects/${encoded}/variables${existing ? `/${encodeURIComponent(name)}` : ""}`;
        await call(path, { method: existing ? "PUT" : "POST", body: { key: name, value, masked: false }, signal });
      } else {
        const existing = (await api.listVariables({ signal })).some((variable) => variable.name === name);
        if (existing) await call(`/repos/${repository}/actions/variables/${encodeURIComponent(name)}`, { method: "PATCH", body: { name, value }, signal });
        else await call(`/repos/${repository}/actions/variables`, { method: "POST", body: { name, value }, signal });
      }
      // Presence only, and deliberately so. A variable is not secret, but
      // listVariables drops values on purpose: a value that came back here
      // would make "write a variable, then read the listing" a way to pull
      // anything out of the vault through a tool result. Confirming the write
      // is not worth handing over that primitive.
      const after = (await api.listVariables({ signal })).some((variable) => variable.name === name);
      return { verified: after, confirmation: after ? CONFIRMATION.PRESENCE : null, observed: { name, present: after } };
    },
  };

  return api;
}

/**
 * Seals a secret to a repository public key.
 *
 * Worth stating rather than leaving to be discovered: GitHub's secrets API
 * hands out a libsodium sealed-box key and only that, so on GitHub this
 * refuses every time. Sealing a box needs a native dependency, and this
 * package carries none on purpose -- that is a deliberate trade, not an
 * oversight, and writing a GitHub Actions secret through Atlas is simply not
 * available until it is revisited.
 *
 * The RSA-OAEP branch is not dead code: a self-hosted host or an enterprise
 * deployment that publishes an RSA key is sealed correctly here. What it is
 * not is a path GitHub.com will ever take.
 *
 * Either way a key this cannot seal is refused loudly, never sent in the
 * clear.
 */
export function sealSecret(value, base64Key) {
  const der = Buffer.from(base64Key, "base64");
  let key;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new InfrastructureError(
      "UNSUPPORTED_KEY",
      "This host's secret key is a libsodium sealed-box key, which needs a native dependency Atlas does not carry. Set this secret through the host's own interface.",
    );
  }
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(value, "utf8")).toString("base64");
}
