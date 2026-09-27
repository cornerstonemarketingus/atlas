import { createPublicKey, publicEncrypt, constants } from "node:crypto";

import { buildPlan, createApiClient, InfrastructureError, redactValue } from "./adapter.mjs";

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
      const after = (await api.listSecrets({ signal })).some((secret) => secret.name === name);
      return { verified: after, observed: { name, present: after } };
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
      const after = (await api.listVariables({ signal })).some((variable) => variable.name === name);
      return { verified: after, observed: { name, present: after } };
    },
  };

  return api;
}

/**
 * Seals a secret to a repository public key.
 *
 * GitHub documents libsodium sealed boxes; that needs a native dependency
 * this package will not take. RSA-OAEP through Node's own crypto is used when
 * the host supplies an RSA key, and a non-RSA key is refused loudly rather
 * than silently sent in the clear.
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

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/u;

/**
 * Creating a repository on a git host, in the same plan → approve → apply →
 * verify shape as the rest of this file. Creating is reversible only by
 * deleting the repository on the host, which Atlas does not do on its own.
 *
 * GitHub: POST /user/repos · GitLab: POST /projects · Forgejo: POST /api/v1/user/repos.
 */
export function createRepositoryCreator({ host, token, baseUrl = null, fetchImpl = fetch }) {
  if (!token) throw new InfrastructureError("NO_CREDENTIAL", `A ${host} token is required to create a repository.`);
  const root = host === "forgejo" ? `${String(baseUrl ?? "").replace(/\/+$/u, "")}/api/v1` : (baseUrl ?? ROOTS[host]);
  if (!root || (host === "forgejo" && !baseUrl)) throw new InfrastructureError("UNKNOWN_HOST", "Use github, gitlab, or forgejo with its base URL.");
  const headers = host === "gitlab"
    ? { "private-token": token }
    : host === "forgejo"
      ? { authorization: `token ${token}` }
      : { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const call = createApiClient({ root, headers, fetchImpl });

  async function owner(signal) {
    const user = await call(host === "gitlab" ? "/user" : "/user", { signal });
    return host === "gitlab" ? user.username : user.login;
  }

  async function find(fullName, signal) {
    try {
      if (host === "gitlab") return await call(`/projects/${encodeURIComponent(fullName)}`, { signal });
      return await call(`/repos/${fullName}`, { signal });
    } catch (error) {
      if (error.code === "NOT_FOUND" || /404/u.test(String(error.message))) return null;
      throw error;
    }
  }

  const cloneUrl = (repo) => repo.clone_url ?? repo.http_url_to_repo ?? null;
  const webUrl = (repo) => repo.html_url ?? repo.web_url ?? null;

  return {
    provider: host,
    async planRepository({ name, visibility = "private", description = "", signal }) {
      if (!REPOSITORY_NAME.test(name ?? "")) throw new InfrastructureError("BAD_REPOSITORY", "A repository name uses letters, numbers, dots, dashes and underscores.");
      if (!["private", "public"].includes(visibility)) throw new InfrastructureError("BAD_VISIBILITY", "Visibility is private or public.");
      const login = await owner(signal);
      const fullName = `${login}/${name}`;
      if (await find(fullName, signal)) throw new InfrastructureError("EXISTS", `${fullName} already exists on ${host}; choose another name or publish to it directly.`);
      return buildPlan({
        provider: host,
        operation: "create",
        resource: "repository",
        target: `${fullName} (${visibility})`,
        before: null,
        after: { name, owner: login, visibility, description: description.slice(0, 200) },
        reversible: false,
        notes: [
          visibility === "public" ? "A public repository is visible to everyone on the internet." : "A private repository is visible only to you and people you invite.",
          "Undoing this means deleting the repository on the host yourself.",
        ],
      });
    },
    async applyRepository({ plan, signal }) {
      const { name, visibility, description, owner: login } = plan.after;
      const body = host === "gitlab"
        ? { name, path: name, visibility, description }
        : { name, private: visibility === "private", description, auto_init: false };
      await call(host === "gitlab" ? "/projects" : "/user/repos", { method: "POST", body, signal });
      // Read back rather than trusting the create call's own response.
      const created = await find(`${login}/${name}`, signal);
      return { verified: Boolean(created), observed: created ? { fullName: `${login}/${name}`, cloneUrl: cloneUrl(created), webUrl: webUrl(created) } : null };
    },
  };
}
