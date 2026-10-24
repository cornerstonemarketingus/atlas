import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SkillError } from "./package.mjs";
import { SkillRegistry } from "./skill-registry.mjs";

/**
 * The daemon's skill marketplace: the signed-package registry opened under the
 * data directory, its active skills' tools mounted in the shared ToolRegistry,
 * and the owner-only routes that drive install.
 *
 * Install order (each step audited by the registry): a publisher key is trusted
 * by the owner, a permission ceiling is set by the owner, anything may *request*
 * an install (recorded as an agent, so it can never approve itself), the owner
 * approves exactly that manifest digest, and `install` re-checks signature,
 * file digests, ceiling and the package's own tests before activating it.
 * Skills are never installed because a model produced them.
 */

const AGENT = Object.freeze({ agentId: "atlas" });
const SKILL_TOOL_LIMITS = Object.freeze({ timeoutMs: 30_000, maxOutputCharacters: 20_000 });

export function createDaemonSkills({ dataDirectory, testRunner = undefined }) {
  const storeDirectory = join(dataDirectory, "skills");
  mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
  return new SkillRegistry({ storeDirectory, ...(testRunner ? { testRunner } : {}) });
}

/**
 * Mounts the tools of every active skill. Each call re-checks that the version
 * it was mounted from is still the active one, so deactivating or rolling back
 * a skill takes effect without a restart. A skill that fails re-verification is
 * reported, never mounted. Returns the names mounted and the refusals.
 */
export async function registerSkillTools(registry, skills, tenantId) {
  const mounted = [];
  const refused = [];
  for (const { name, version } of skills.listActive(tenantId)) {
    let loaded;
    try {
      loaded = await skills.loadSkill(tenantId, name);
    } catch (error) {
      if (!(error instanceof SkillError)) throw error;
      refused.push({ name, version, code: error.code, message: error.message });
      continue;
    }
    for (const tool of loaded) {
      if (registry.has(tool.name)) { refused.push({ name, version, code: "DUPLICATE_TOOL", message: `A tool named '${tool.name}' is already registered.` }); continue; }
      registry.register({
        name: tool.name,
        description: tool.description,
        capability: `skill.${name}`,
        risk: tool.risk === "read" ? "low" : tool.consequential ? "high" : "moderate",
        // Consequential or anything that is not a read asks the owner first.
        requiresApproval: tool.consequential || tool.risk !== "read",
        inputSchema: tool.inputSchema,
        ...SKILL_TOOL_LIMITS,
        async execute({ input, context = {} }) {
          if (skills.activeVersion(tenantId, name) !== version) throw new SkillError("NOT_ACTIVE", `Skill '${name}' ${version} is no longer the active version.`);
          const result = await tool.execute(input, context);
          const output = result && typeof result === "object" && "output" in result ? result.output : result;
          return typeof output === "string" ? output : JSON.stringify(output);
        },
      });
      mounted.push(tool.name);
    }
  }
  return { mounted, refused };
}

const STATUS = { INVALID_INPUT: 400, INVALID_PACKAGE: 400, INVALID_KEY: 400, NOT_FOUND: 404, ALREADY_INSTALLED: 409, APPROVAL_RESOLVED: 409, SELF_APPROVAL: 403, HUMAN_APPROVAL_REQUIRED: 403, APPROVAL_REQUIRED: 403, UNTRUSTED_PUBLISHER: 403, BAD_SIGNATURE: 403, DIGEST_MISMATCH: 422, PERMISSION_ESCALATION: 403, TESTS_FAILED: 422 };

/**
 * Owner-only routes. Reads are open to any signed-in device; every write needs
 * the owner. `mount` is called after a successful install so the new tools are
 * usable at once.
 */
export function createSkillRoutes({ skills, tenantId, owner, parseBody, send, mount = async () => {} }) {
  const human = { userId: owner || "owner" };
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/skills")) return false;
    try {
      if (request.method === "GET" && url.pathname === "/v1/skills") {
        return send(response, 200, {
          active: skills.listActive(tenantId),
          ceiling: skills.getPermissionCeiling(tenantId),
          audit: skills.auditLog(tenantId, { limit: 100 }),
        });
      }
      const approvalMatch = /^\/v1\/skills\/approvals\/([A-Za-z0-9_-]{1,80})$/u.exec(url.pathname);
      if (request.method === "GET" && approvalMatch) {
        const approval = skills.approvals.get(tenantId, approvalMatch[1]);
        return approval ? send(response, 200, approval) : send(response, 404, { code: "NOT_FOUND", message: "No such approval." });
      }
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", unblock: "Use the local owner token." });
      const body = await parseBody(request, response); if (!body) return true;
      if (url.pathname === "/v1/skills/publishers") {
        return send(response, 200, skills.trustPublisher(tenantId, { publisher: body.publisher, publicKeyPem: body.publicKeyPem, trustedBy: human }));
      }
      if (url.pathname === "/v1/skills/ceiling") {
        return send(response, 200, { ceiling: skills.setPermissionCeiling(tenantId, body.permissions, { setBy: human }) });
      }
      if (url.pathname === "/v1/skills/install-requests") {
        skills.verifyPackage(tenantId, body.package);
        return send(response, 202, skills.requestInstallApproval(tenantId, body.package, { requestedBy: AGENT }));
      }
      const decision = /^\/v1\/skills\/approvals\/([A-Za-z0-9_-]{1,80})\/(approve|reject)$/u.exec(url.pathname);
      if (decision) {
        return send(response, 200, skills.approvals.resolve(tenantId, decision[1], { approver: human, decision: decision[2] === "approve" ? "approved" : "rejected" }));
      }
      if (url.pathname === "/v1/skills/install") {
        const installed = await skills.install(body.package, { tenantId, approvalId: body.approvalId, approvedBy: human });
        const mounted = await mount();
        return send(response, 201, { installed, mounted });
      }
      const deactivate = /^\/v1\/skills\/([a-z][a-z0-9_-]{0,63})\/deactivate$/u.exec(url.pathname);
      if (deactivate) return send(response, 200, skills.deactivate(tenantId, deactivate[1], { actor: human }) ?? { deactivated: deactivate[1] });
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      if (error instanceof SkillError) return send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message });
      return send(response, 500, { code: "ERROR", message: "The request failed." });
    }
  };
}
