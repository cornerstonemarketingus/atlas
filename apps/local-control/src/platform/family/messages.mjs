import {
  SCHEMA_VERSION,
  agentMessageSchema,
  assertSchema,
  newCorrelationId,
  newId,
} from "../../../../../packages/atlas-contracts/src/index.mjs";

import { FamilyError } from "./family-graph.mjs";

/** Principal used as the source of messages the platform itself emits. */
export const SYSTEM_SOURCE = "atlas.system";

/**
 * Typed, append-only agent messaging over the family registry's database.
 * Every message is validated against the shared agentMessageSchema before it
 * is stored. A message addressed to an unknown or no-longer-live agent is not
 * silently dropped: it lands in dead_letters and an ESCALATION goes to the
 * sender's parent (or to the sender itself when it has none).
 */
export class MessageBus {
  #registry;

  constructor(registry) {
    this.#registry = registry;
  }

  #build({ type, source, destination, taskId, correlationId, payload = {} }) {
    const message = {
      schemaVersion: SCHEMA_VERSION,
      id: newId("message"),
      type,
      source,
      destination,
      taskId,
      correlationId: correlationId ?? newCorrelationId(),
      payload,
      createdAt: this.#registry.now(),
    };
    return assertSchema(agentMessageSchema, message, "agent message");
  }

  #store(tenantId, m) {
    this.#registry.db.prepare(`INSERT INTO agent_messages (tenant_id, id, type, source, destination, task_id, correlation_id, schema_version, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tenantId, m.id, m.type, m.source, m.destination, m.taskId, m.correlationId, m.schemaVersion, JSON.stringify(m.payload), m.createdAt);
  }

  /**
   * @returns {{delivered: true, message} | {delivered: false, message, deadLetterId, escalation}}
   */
  sendMessage({ tenantId, ...fields }) {
    if (typeof tenantId !== "string" || !tenantId) throw new FamilyError("TENANT_REQUIRED", "A tenantId is required.");
    const message = this.#build(fields);
    const reg = this.#registry;
    if (message.source !== SYSTEM_SOURCE && !reg.getAgent(tenantId, message.source)) {
      throw new FamilyError("UNKNOWN_SOURCE", `Source agent '${message.source}' does not exist in this tenant.`);
    }
    return reg.transaction(() => {
      const destination = reg.getAgent(tenantId, message.destination);
      if (reg.isLive(destination)) {
        this.#store(tenantId, message);
        return { delivered: true, message };
      }
      const reason = destination ? `destination is ${destination.state}` : "destination unknown";
      const deadLetterId = newId("message");
      let escalation = null;
      // Escalate to a live agent that can act: the sender's parent, else the sender.
      const sender = message.source === SYSTEM_SOURCE ? null : reg.getAgent(tenantId, message.source);
      const parent = sender?.parentId ? reg.getAgent(tenantId, sender.parentId) : null;
      const escalateTo = reg.isLive(parent) ? parent : reg.isLive(sender) ? sender : null;
      if (escalateTo && message.type !== "ESCALATION") {
        escalation = this.#build({
          type: "ESCALATION",
          source: SYSTEM_SOURCE,
          destination: escalateTo.id,
          taskId: message.taskId,
          correlationId: message.correlationId,
          payload: { reason: "DEAD_LETTER", detail: reason, deadLetterId, originalMessageId: message.id, originalType: message.type, originalDestination: message.destination },
        });
        this.#store(tenantId, escalation);
      }
      reg.db.prepare("INSERT INTO dead_letters (tenant_id, id, message, reason, escalation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tenantId, deadLetterId, JSON.stringify(message), reason, escalation?.id ?? null, reg.now());
      return { delivered: false, message, deadLetterId, escalation };
    });
  }

  listMessages(tenantId, { taskId, agentId, type } = {}) {
    if (typeof tenantId !== "string" || !tenantId) throw new FamilyError("TENANT_REQUIRED", "A tenantId is required.");
    return this.#registry.db.prepare("SELECT * FROM agent_messages WHERE tenant_id = ? ORDER BY seq").all(tenantId)
      .filter((r) => (!taskId || r.task_id === taskId) && (!agentId || r.source === agentId || r.destination === agentId) && (!type || r.type === type))
      .map((r) => ({
        schemaVersion: r.schema_version, id: r.id, type: r.type, source: r.source, destination: r.destination,
        taskId: r.task_id, correlationId: r.correlation_id, payload: JSON.parse(r.payload), createdAt: r.created_at,
      }));
  }

  listDeadLetters(tenantId) {
    if (typeof tenantId !== "string" || !tenantId) throw new FamilyError("TENANT_REQUIRED", "A tenantId is required.");
    return this.#registry.db.prepare("SELECT * FROM dead_letters WHERE tenant_id = ? ORDER BY seq").all(tenantId)
      .map((r) => ({ id: r.id, reason: r.reason, escalationId: r.escalation_id, message: JSON.parse(r.message), createdAt: r.created_at }));
  }
}
