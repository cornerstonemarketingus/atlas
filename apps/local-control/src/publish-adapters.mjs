const PROVIDERS = new Set(["github", "gitlab", "forgejo"]);

export async function publishChange(input, { fetchImpl = fetch, push = pushBranch } = {}) {
  validate(input);
  const pushed = await push(input.worktree, input.remote ?? "origin", input.branch);
  if (!pushed.ok) return { ok: false, stage: "push", message: pushed.message };
  const request = buildRequest(input);
  const response = await fetchImpl(request.url, request.options);
  const text = await response.text(); let data = {}; try { data = JSON.parse(text); } catch { /* bounded error below */ }
  if (!response.ok) return { ok: false, stage: "pull-request", message: String(data.message ?? text ?? `HTTP ${response.status}`).slice(0, 2000) };
  return { ok: true, url: data.html_url ?? data.web_url ?? data.url ?? null, number: data.number ?? data.iid ?? data.index ?? null };
}

export function buildRequest(input) {
  const base = normalizedBase(input.baseUrl);
  if (input.provider === "github") return {
    url: new URL(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`, base),
    options: { method: "POST", headers: { authorization: `Bearer ${input.token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, body: JSON.stringify({ title: input.title, body: input.body ?? "", head: input.branch, base: input.targetBranch ?? "main" }) },
  };
  if (input.provider === "gitlab") return {
    url: new URL(`/api/v4/projects/${encodeURIComponent(`${input.owner}/${input.repository}`)}/merge_requests`, base),
    options: { method: "POST", headers: { "private-token": input.token, "content-type": "application/json" }, body: JSON.stringify({ title: input.title, description: input.body ?? "", source_branch: input.branch, target_branch: input.targetBranch ?? "main" }) },
  };
  return {
    url: new URL(`/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`, base),
    options: { method: "POST", headers: { authorization: `token ${input.token}`, "content-type": "application/json" }, body: JSON.stringify({ title: input.title, body: input.body ?? "", head: input.branch, base: input.targetBranch ?? "main" }) },
  };
}

function validate(input) {
  if (!PROVIDERS.has(input?.provider)) throw new Error("provider must be github, gitlab, or forgejo.");
  for (const key of ["worktree", "branch", "owner", "repository", "title", "token", "baseUrl"]) if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`${key} is required.`);
  if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(input.branch) || input.branch.startsWith("-") || input.branch.includes("..")) throw new Error("branch is invalid.");
}

function normalizedBase(value) {
  const url = new URL(value); const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Remote Git APIs require HTTPS unless they are loopback.");
  url.pathname = "/"; url.search = ""; url.hash = ""; return url;
}

async function pushBranch(worktree, remote, branch) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", worktree, "push", remote, `HEAD:refs/heads/${branch}`], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on("error", (error) => resolve({ ok: false, message: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, message: code === 0 ? "pushed" : stderr.trim() || `git push exited ${code}` }));
  });
}
