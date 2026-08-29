const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|\s|[\x5b~^:?*]))[A-Za-z0-9._/-]{1,255}$/;
const workflowPattern = /^(?:[A-Za-z0-9_.-]{1,128}|[1-9][0-9]{0,18})$/;
const modes = new Set(["inspect", "debug"]);

export function allowedRepositories(value = "cornerstonemarketingus/atlas") {
  return new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function validateTask(body, allowlist) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "A task payload is required.", status: 400 };
  const { repository, branch, mode, objective } = body;
  if (typeof repository !== "string" || !repositoryPattern.test(repository) || !allowlist.has(repository.toLowerCase())) {
    return { error: "That repository is not on your Atlas allowlist.", status: 403 };
  }
  if (typeof branch !== "string" || !branchPattern.test(branch)) return { error: "Branch name is invalid.", status: 400 };
  if (typeof mode !== "string" || !modes.has(mode)) return { error: "Task mode is invalid.", status: 400 };
  if (typeof objective !== "string" || !objective.trim() || objective.length > 4_000) return { error: "Objective is invalid.", status: 400 };
  return { task: { repository: repository.toLowerCase(), branch, mode, objective: objective.trim() } };
}

export function githubDispatchRequest({ token, workflow = "atlas-runner.yml", workflowRef = "main", task, taskId }) {
  if (!workflowPattern.test(workflow)) throw new Error("ATLAS_GITHUB_WORKFLOW is invalid.");
  if (workflowRef !== "main") throw new Error("ATLAS_RUNNER_WORKFLOW_REF must be 'main'.");
  const [owner, repo] = task.repository.split("/");
  return {
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    init: {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "atlas-control-plane",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        // The workflow definition must always come from the protected, trusted
        // default branch. The requested branch is passed only as runner input.
        ref: workflowRef,
        inputs: {
          repository: task.repository,
          branch: task.branch,
          mode: task.mode,
          objective: task.objective,
          task_id: taskId,
        },
      }),
    },
  };
}

export async function dispatchGitHub(options, fetcher = fetch) {
  const request = githubDispatchRequest(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetcher(request.url, { ...request.init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
