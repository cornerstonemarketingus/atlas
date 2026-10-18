import { createHash } from "node:crypto";
import { GenesisError } from "./service.mjs";

/** One durable, bounded operation; all execution and publishing belongs to Genesis. */
export class ProjectCreation {
  constructor({ genesis, executor, publisher }) {
    Object.assign(this, { genesis, executor, publisher });
    this.running = new Set();
  }

  async create(input) {
    const { requestId, name, description, template = "web-app", visibility = "private", host = "github" } = input ?? {};
    if (!/^[a-zA-Z0-9_-]{16,100}$/u.test(requestId ?? "") || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name ?? "") || typeof description !== "string" || !description.trim() || description.length > 4000 || !["web-app", "static-site", "api-service"].includes(template) || !["private", "public"].includes(visibility) || host !== "github") {
      throw new GenesisError("INVALID_PROJECT", "Use a request id, safe repository name, description, curated template, GitHub host and explicit visibility.");
    }
    const spec = { name, description, template, visibility, host };
    const digest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const previous = this.genesis.store.operation(requestId);
    if (previous) {
      if (previous.digest !== digest) throw new GenesisError("REQUEST_CONFLICT", "This request id already belongs to a different project. Nothing was started.");
      return this.status(requestId);
    }
    const capabilities = await this.publisher.repositoryCapabilities({ visibility });
    const concurrent = this.genesis.store.operation(requestId);
    if (concurrent) {
      if (concurrent.digest !== digest) throw new GenesisError("REQUEST_CONFLICT", "This request id already belongs to a different project. Nothing was started.");
      return this.status(requestId);
    }
    if (!capabilities.github.connected || capabilities.github.canCreateRepositories === false) {
      return { status: "unavailable", capabilities, message: `Repository creation unavailable: ${capabilities.github.reason}. Configure an account-level GitHub credential and publish.remote policy on the Genesis node.` };
    }
    // Reserve before asynchronous planning: retries cannot create two workspaces.
    this.genesis.store.saveOperation({ id: requestId, digest, spec, status: "building" });
    this.running.add(requestId);
    this.run(requestId).finally(() => this.running.delete(requestId)).catch(() => {});
    return this.status(requestId);
  }

  async run(id) {
    let operation = this.genesis.store.operation(id);
    try {
      const project = await this.genesis.create(operation.spec.description, { name: operation.spec.name, template: operation.spec.template, actor: "hosted-owner" });
      operation = this.genesis.store.saveOperation({ ...operation, projectId: project.id });
      await this.executor.run(project.id);
      const built = this.genesis.view(project.id);
      if (built.state !== "ready") {
        this.genesis.store.saveOperation({ ...operation, status: "blocked", message: `Genesis is ${built.state}. Open the project on the Genesis node to answer questions, approve the plan or resolve failed checks.` });
        return;
      }
      // Persist the boundary before any external call. Restart never repeats it.
      await this.publish(operation);
    } catch (error) {
      // Known publisher messages are controlled; arbitrary runtime errors may contain secrets.
      this.genesis.store.saveOperation({ ...operation, status: "failed", code: error.code ?? "EXECUTION_FAILED", message: error.name === "PublishError" ? error.message : "Project creation failed. Inspect Genesis diagnostics on the execution node; do not retry an uncertain publish automatically." });
    }
  }

  async publish(operation) {
    operation = this.genesis.store.saveOperation({ ...operation, status: "publishing", message: null });
    try {
      const result = await this.publisher.requestRepository(operation.projectId, operation.spec);
      this.genesis.store.saveOperation({ ...operation, ...result });
    } catch (error) {
      this.genesis.store.saveOperation({ ...operation, status: "failed", code: error.code ?? "PUBLISH_FAILED", message: error.name === "PublishError" ? error.message : "Publishing could not be confirmed. Inspect Genesis before retrying." });
    }
  }

  onReady(projectId) {
    const operation = this.genesis.store.operations().find((value) => value.projectId === projectId && value.status === "blocked");
    if (!operation || this.running.has(operation.id)) return;
    this.running.add(operation.id);
    this.publish(operation).finally(() => this.running.delete(operation.id)).catch(() => {});
  }

  recordApproval(approval, result) {
    const operation = this.genesis.store.operations().find((value) => value.approvalId === approval.id);
    if (operation && result) this.genesis.store.saveOperation({ ...operation, ...result });
  }

  status(id) {
    const operation = this.genesis.store.operation(id);
    if (!operation) return { status: "not-found", message: "No project operation with that id." };
    const project = operation.projectId ? this.genesis.view(operation.projectId) : null;
    const published = project?.transitions.findLast((transition) => transition.evidence?.kind === "published");
    const approval = operation.approvalId ? this.publisher.approvals.get(operation.approvalId) : null;
    let status = published ? "published" : operation.status;
    if (status === "awaiting-approval" && approval?.status === "denied") status = "denied";
    if (status === "awaiting-approval" && approval?.status === "approved" && project?.transitions.at(-1)?.evidence.kind === "publish-failed") status = "failed";
    if (["building", "publishing"].includes(status) && !this.running.has(id)) status = "interrupted";
    const result = published?.evidence ?? operation;
    return { operationId: id, projectId: operation.projectId ?? null, status, projectState: project?.state ?? null,
      name: operation.spec.name, visibility: operation.spec.visibility, approvalId: operation.approvalId ?? null,
      repository: result.repository ?? null, commit: result.commit ?? null, deploymentState: "not-deployed",
      message: operation.message ?? (status === "interrupted" ? "Atlas restarted. Inspect the project before resuming; publishing is never replayed automatically." : status === "failed" ? "Publishing did not complete. Inspect Genesis diagnostics." : null) };
  }
}
