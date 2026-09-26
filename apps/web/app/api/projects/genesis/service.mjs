import { canManageTenant, upsertTenantRepository } from "../../../../db/tenancy.mjs";
import { defaultMergePolicy } from "../../tasks/dispatch.mjs";
import { GENESIS_TEMPLATE_NAMES, GENESIS_TEMPLATES, genesisTemplateByName } from "./templates.mjs";

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const repoPattern = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;
const ownerTypeValues = new Set(["org", "user"]);
const githubApi = "https://api.github.com";

export function genesisConfiguration(environment = process.env) {
  const owner = String(environment.ATLAS_GENESIS_REPOSITORY_OWNER ?? "").trim().toLowerCase();
  const ownerType = String(environment.ATLAS_GENESIS_REPOSITORY_OWNER_TYPE ?? (owner ? "org" : "user")).trim().toLowerCase();
  const githubAppConfigured = Boolean(environment.ATLAS_GITHUB_APP_ID && environment.ATLAS_GITHUB_INSTALLATION_ID && environment.ATLAS_GITHUB_APP_PRIVATE_KEY);
  return {
    configured: githubAppConfigured && Boolean(owner) && ownerPattern.test(owner) && ownerTypeValues.has(ownerType),
    githubAppConfigured,
    owner: owner && ownerPattern.test(owner) ? owner : "",
    ownerType: ownerTypeValues.has(ownerType) ? ownerType : "user",
  };
}

export function genesisNamespaceOwners(environment = process.env) {
  const configuration = genesisConfiguration(environment);
  return configuration.configured && configuration.owner ? [configuration.owner] : [];
}

export function availableGenesisTemplates() {
  return GENESIS_TEMPLATES.map(({ name, description, stack, commands }) => ({ name, description, stack, commands }));
}

export function validateGenesisRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A Genesis project payload is required.", status: 400 };
  }
  const template = typeof body.template === "string" ? body.template.trim() : "";
  if (!GENESIS_TEMPLATE_NAMES.includes(template)) {
    return { error: `Template must be one of: ${GENESIS_TEMPLATE_NAMES.join(", ")}.`, status: 400 };
  }
  const normalizedName = normalizeRepositoryName(body.name);
  if (!normalizedName || !repoPattern.test(normalizedName)) {
    return { error: "Project name is invalid.", status: 400 };
  }
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
  if (!description) return { error: "Project description is required.", status: 400 };
  return { project: { name: normalizedName, template, description } };
}

export async function genesisProjectResponse(request, { d1, tenant, githubToken, environment = process.env, fetcher = fetch } = {}) {
  if (!tenant) return Response.json({ message: "Choose a workspace before creating a project." }, { status: 403 });
  if (!canManageTenant(tenant.role)) return Response.json({ message: "Workspace owner or admin access is required to create a new repository." }, { status: 403 });
  const configuration = genesisConfiguration(environment);
  if (!configuration.configured) return Response.json({ message: "Project Genesis is not configured for this Atlas deployment." }, { status: 503 });
  if (typeof githubToken !== "string" || githubToken.length < 20) return Response.json({ message: "GitHub App authentication failed, so no repository was created." }, { status: 502 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const validated = validateGenesisRequest(body);
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });

  try {
    const created = await createGenesisRepository(validated.project, { configuration, githubToken, fetcher });
    await upsertTenantRepository(d1, tenant.tenantId, {
      owner: created.owner,
      name: created.name,
      mergePolicy: defaultMergePolicy(environment.ATLAS_DEFAULT_MERGE_POLICY),
    });
    return Response.json({
      ok: true,
      repository: `${created.owner}/${created.name}`,
      owner: created.owner,
      name: created.name,
      url: created.url,
      branch: created.defaultBranch,
      template: validated.project.template,
    }, { status: 201 });
  } catch (error) {
    const status = Number.isSafeInteger(error?.status) ? error.status : 502;
    return Response.json({ message: error instanceof Error ? error.message : "Atlas could not create that repository." }, { status });
  }
}

export async function createGenesisRepository(project, { configuration, githubToken, fetcher = fetch }) {
  const template = genesisTemplateByName(project.template);
  if (!template) throw withStatus(400, `Unknown template '${project.template}'.`);
  const repository = await githubJson(repoCreationUrl(configuration), {
    method: "POST",
    headers: githubHeaders(githubToken),
    body: JSON.stringify({ name: project.name, description: project.description, private: true, auto_init: false }),
  }, fetcher, "GitHub rejected the new repository request.");
  const owner = String(repository?.owner?.login ?? configuration.owner ?? "").trim().toLowerCase();
  const name = String(repository?.name ?? project.name).trim().toLowerCase();
  const defaultBranch = String(repository?.default_branch ?? "main").trim() || "main";
  if (!owner || !name) throw withStatus(502, "GitHub created a repository without a usable owner or name.");

  const tree = await Promise.all(Object.entries(template.files).map(async ([path, content]) => {
    const blob = await githubJson(`${githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs`, {
      method: "POST",
      headers: githubHeaders(githubToken),
      body: JSON.stringify({ content, encoding: "utf-8" }),
    }, fetcher, `GitHub could not upload template file ${path}.`);
    return { path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const createdTree = await githubJson(`${githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees`, {
    method: "POST",
    headers: githubHeaders(githubToken),
    body: JSON.stringify({ tree }),
  }, fetcher, "GitHub could not assemble the template tree.");
  const commit = await githubJson(`${githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/commits`, {
    method: "POST",
    headers: githubHeaders(githubToken),
    body: JSON.stringify({ message: `Atlas Genesis: seed ${template.name} template`, tree: createdTree.sha, parents: [] }),
  }, fetcher, "GitHub could not create the initial commit.");
  await githubJson(`${githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`, {
    method: "POST",
    headers: githubHeaders(githubToken),
    body: JSON.stringify({ ref: `refs/heads/${defaultBranch}`, sha: commit.sha }),
  }, fetcher, "GitHub could not create the default branch.");
  return {
    owner,
    name,
    defaultBranch,
    url: String(repository?.html_url ?? `https://github.com/${owner}/${name}`),
  };
}

function repoCreationUrl(configuration) {
  return configuration.ownerType === "org" && configuration.owner
    ? `${githubApi}/orgs/${encodeURIComponent(configuration.owner)}/repos`
    : `${githubApi}/user/repos`;
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: ["Bearer", token].join(" "),
    "content-type": "application/json",
    "user-agent": "atlas-control-plane",
    "x-github-api-version": "2022-11-28",
  };
}

async function githubJson(url, init, fetcher, message) {
  const response = await fetcher(url, init);
  if (!response.ok) throw withStatus(response.status, message);
  return response.status === 204 ? {} : await response.json();
}

function normalizeRepositoryName(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "").replace(/-{2,}/gu, "-");
  return normalized.slice(0, 100);
}

function withStatus(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
