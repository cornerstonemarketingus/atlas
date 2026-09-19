import { createHash } from "node:crypto";

/**
 * Communications.
 *
 * Drafting is free; sending is not. A draft is stored and shown, the operator
 * approves the exact content, and only then can it be sent — the approval is
 * bound to a digest over the recipients and the body, so editing either after
 * approval invalidates it.
 *
 * Bulk unsolicited outreach is refused outright rather than gated: a limit an
 * agent can ask permission to exceed is not a limit.
 */
const MAX_RECIPIENTS = 5;

export class CommunicationsToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommunicationsToolError";
    this.code = code;
  }
}

export function messageDigest({ channel, recipients, subject, body }) {
  return createHash("sha256")
    .update(JSON.stringify({ channel, recipients: [...recipients].sort(), subject: subject ?? "", body }))
    .digest("hex");
}

export function registerCommunicationsTools(registry, { drafts = new Map(), send = null } = {}) {
  registry.register({
    name: "communications.draft",
    description: "Write a draft message. Drafting never sends anything.",
    capability: "communications.draft",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 8_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["channel", "recipients", "body"],
      properties: {
        channel: { type: "string", enum: ["email", "message"] },
        recipients: { type: "array", maxItems: MAX_RECIPIENTS, items: { type: "string", minLength: 1, maxLength: 320 } },
        subject: { type: "string", maxLength: 300, default: "" },
        body: { type: "string", minLength: 1, maxLength: 20_000 },
      },
    },
    async execute({ input, context }) {
      if (input.recipients.length === 0) throw new CommunicationsToolError("NO_RECIPIENTS", "A draft needs at least one recipient.");
      const digest = messageDigest(input);
      drafts.set(digest, { ...input, sessionId: context?.sessionId ?? null, createdAt: new Date().toISOString() });
      return [
        `Draft ready (${digest.slice(0, 12)}).`,
        `To: ${input.recipients.join(", ")}`,
        input.subject ? `Subject: ${input.subject}` : null,
        "",
        input.body,
        "",
        "This has not been sent. Use communications.send with the same content, which the operator must approve.",
      ].filter((line) => line !== null).join("\n");
    },
  });

  registry.register({
    name: "communications.request_approval",
    description: "Ask the operator to decide something before continuing.",
    capability: "communications.draft",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2_000 },
        options: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
      },
    },
    async execute({ input, context }) {
      context.requestDecision?.({ question: input.question, options: input.options ?? [] });
      return `Asked the operator: ${input.question}`;
    },
  });

  registry.register({
    name: "communications.send",
    description: "Send a message that was drafted and approved. Requires approval of the exact content.",
    capability: "communications.send",
    risk: "critical",
    timeoutMs: 60_000,
    maxOutputCharacters: 4_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["channel", "recipients", "body"],
      properties: {
        channel: { type: "string", enum: ["email", "message"] },
        recipients: { type: "array", maxItems: MAX_RECIPIENTS, items: { type: "string", minLength: 1, maxLength: 320 } },
        subject: { type: "string", maxLength: 300, default: "" },
        body: { type: "string", minLength: 1, maxLength: 20_000 },
      },
    },
    async execute({ input }) {
      if (input.recipients.length === 0) throw new CommunicationsToolError("NO_RECIPIENTS", "There is nobody to send to.");
      if (input.recipients.length > MAX_RECIPIENTS) {
        throw new CommunicationsToolError("BULK_REFUSED", `Atlas does not send to more than ${MAX_RECIPIENTS} recipients at once.`);
      }
      const digest = messageDigest(input);
      // The approval the registry checked covers these exact arguments; this
      // check catches the other direction — a send whose content was never
      // drafted and shown to the operator at all.
      if (!drafts.has(digest)) {
        throw new CommunicationsToolError("NOT_DRAFTED", "This exact message was never drafted. Draft it first so the operator can read what would be sent.");
      }
      if (!send) throw new CommunicationsToolError("NO_TRANSPORT", "No message transport is configured on this machine.");
      const receipt = await send(input);
      drafts.delete(digest);
      return `Sent to ${input.recipients.length} recipient(s). Receipt: ${receipt?.id ?? "(none supplied)"}.`;
    },
  });

  return registry;
}
