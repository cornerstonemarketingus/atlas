/**
 * Business workflows.
 *
 * These are preparation tools. Each produces a structured brief the operator
 * reads and acts on; none of them sends, submits, or applies. That split is
 * the point: the useful and time-consuming part of this work is the research
 * and the draft, and the part that needs a human is the moment it goes out.
 *
 * Each one writes its brief through the filesystem workspace so the result is
 * a durable artifact rather than a wall of chat text.
 */
const SECTIONS = {
  job_application: [
    "Role and employer, with the source URL",
    "What the posting actually asks for, as a list",
    "Where the applicant's experience matches, with evidence",
    "Gaps, stated plainly",
    "Draft cover letter",
    "Fields the application form needs, and the value to enter in each",
    "What still needs a human decision before submitting",
  ],
  crm_research: [
    "Organization, sector, size, and location",
    "Recent public developments, with sources and dates",
    "Named contacts and their public roles",
    "Existing relationship history supplied by the operator",
    "Open questions to resolve before outreach",
  ],
  sales_prospect: [
    "Prospect and the problem they are likely to have",
    "Evidence for that from public sources, with links",
    "How the operator's offering maps to it",
    "Likely objections, and an honest answer to each",
    "Suggested first message, as a draft only",
  ],
  marketing_campaign: [
    "Audience and the single claim being made",
    "Channels, with a reason for each",
    "Draft copy per channel",
    "What would make this measurably successful",
    "Claims that need substantiation before publication",
  ],
};

export function registerWorkflowTools(registry) {
  for (const [kind, sections] of Object.entries(SECTIONS)) {
    registry.register({
      name: `workflow.${kind}`,
      description: `Prepare a ${kind.replaceAll("_", " ")} brief. Preparation only — this never sends, submits, or applies.`,
      capability: "workflow.prepare",
      risk: "low",
      timeoutMs: 20_000,
      maxOutputCharacters: 20_000,
      requiresApproval: false,
      inputSchema: {
        type: "object",
        required: ["subject", "findings"],
        properties: {
          subject: { type: "string", minLength: 1, maxLength: 300 },
          findings: {
            type: "array",
            maxItems: 40,
            items: {
              type: "object",
              required: ["section", "content"],
              properties: {
                section: { type: "string", minLength: 1, maxLength: 200 },
                content: { type: "string", minLength: 1, maxLength: 8_000 },
                source: { type: "string", maxLength: 2_000, default: "" },
              },
            },
          },
        },
      },
      async execute({ input, context }) {
        const lines = [`# ${titleFor(kind)}: ${input.subject}`, ""];
        for (const finding of input.findings) {
          lines.push(`## ${finding.section}`, finding.content);
          // A claim with no source is marked as one. The operator is going to
          // act on this, and an unsourced assertion should look different from
          // a sourced one.
          lines.push(finding.source ? `Source: ${finding.source}` : "Source: none supplied — verify before relying on this.", "");
        }
        const missing = sections.filter((section) => !input.findings.some((finding) => finding.section.toLowerCase().includes(section.toLowerCase().slice(0, 12))));
        if (missing.length > 0) lines.push("## Not covered", ...missing.map((section) => `- ${section}`), "");
        lines.push("## Status", "Prepared, not sent. Nothing here has been submitted, applied for, or published.");
        const document = lines.join("\n");
        context.recordBrief?.({ kind, subject: input.subject, document });
        return document;
      },
    });
  }
  return registry;
}

export function expectedSections(kind) {
  return SECTIONS[kind] ?? [];
}

function titleFor(kind) {
  return kind.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}
