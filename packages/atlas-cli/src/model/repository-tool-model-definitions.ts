import type { ModelToolDefinition } from "./model-provider.js";

const noAdditionalProperties = { additionalProperties: false } as const;

export const REPOSITORY_READ_ONLY_MODEL_TOOLS: readonly ModelToolDefinition[] = [
  {
    name: "repository.inspect",
    description: "Inspect bounded repository metadata, Git state, languages, manifests, frameworks, and architecture hints.",
    inputSchema: { type: "object", properties: {}, ...noAdditionalProperties },
  },
  {
    name: "repository.search",
    description: "Search repository-relative paths and bounded source previews using a literal query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        scope: { type: "string", enum: ["all", "content", "files"] },
        maxResults: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["query"],
      ...noAdditionalProperties,
    },
  },
  {
    name: "repository.symbols",
    description: "List bounded named declarations, optionally filtered by a symbol-name substring.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        maxResults: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ...noAdditionalProperties,
    },
  },
  {
    name: "repository.references",
    description: "Find bounded exact identifier declarations and lexical references.",
    inputSchema: {
      type: "object",
      properties: {
        symbolName: { type: "string", minLength: 1, maxLength: 1000 },
        maxResults: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["symbolName"],
      ...noAdditionalProperties,
    },
  },
  {
    name: "repository.read_source",
    description: "Read a bounded UTF-8 source range using a repository-relative path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        maxLines: { type: "integer", minimum: 1, maximum: 10000 },
        maxBytes: { type: "integer", minimum: 1, maximum: 4194304 },
      },
      required: ["path"],
      ...noAdditionalProperties,
    },
  },
  {
    name: "repository.tests_for",
    description: "List tests that import a source file (directly or via other files), with the import chain.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        depth: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["path"],
      ...noAdditionalProperties,
    },
  }
];

export const REPOSITORY_WRITE_MODEL_TOOLS: readonly ModelToolDefinition[] = [
  {
    name: "repository.propose_file_edit",
    description: "Create a new file or overwrite an existing one with exact full file content, using a repository-relative path. Read the file first if it already exists — this always replaces the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        content: { type: "string" },
      },
      required: ["path", "content"],
      ...noAdditionalProperties,
    },
  },
  {
    name: "repository.propose_change_set",
    description: [
      "Apply several file edits as one atomic change set: every edit lands, or none does.",
      "Use this whenever a change touches more than one file, and for every rename, move, or deletion — repository.propose_file_edit cannot delete or move anything.",
      "Each edit object names one operation and the fields that operation requires:",
      "create — path + content, and the file must not already exist;",
      "update — path + content, replacing the whole file, which must already exist;",
      "delete — path only, and the file must already exist;",
      "rename — path (the existing source) + toPath (the destination, which must not already exist) and no content; the file's bytes are moved unchanged.",
      "Never send content on a delete or rename, and never send toPath on anything but a rename.",
      "Every path is repository-relative, and no path may be named twice in one change set.",
      "Each edit is checked against the repository as it is before the change set runs, so do not edit a path that another edit in the same set creates or renames — use a second change set for that.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          description: "Ordered edits applied as one transaction.",
          items: {
            type: "object",
            properties: {
              operation: {
                type: "string",
                enum: ["create", "update", "delete", "rename"],
                description: "Which edit this is. Determines which other fields are required.",
              },
              path: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description: "Repository-relative path of the file to create, update, delete, or move from.",
              },
              content: {
                type: "string",
                description: "Exact full new file contents. Required for create and update; must be omitted for delete and rename.",
              },
              toPath: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description: "Repository-relative destination path. Required for rename; must be omitted for every other operation.",
              },
            },
            required: ["operation", "path"],
            oneOf: [
              { properties: { operation: { const: "create" } }, required: ["operation", "path", "content"] },
              { properties: { operation: { const: "update" } }, required: ["operation", "path", "content"] },
              { properties: { operation: { const: "delete" } }, required: ["operation", "path"] },
              { properties: { operation: { const: "rename" } }, required: ["operation", "path", "toPath"] },
            ],
            ...noAdditionalProperties,
          },
        },
      },
      required: ["edits"],
      ...noAdditionalProperties,
    },
  },
];

/**
 * Minimal tool contract for rate-limited hosted coding models. Groq counts the
 * tool grammar toward TPM, so advertising every convenience tool can reject a
 * request before the model gets a turn. These three still support discovery,
 * exact reads, and atomic multi-file edits; the full registry remains behind
 * the policy boundary.
 */
export const COMPACT_CODER_MODEL_TOOLS: readonly ModelToolDefinition[] = [
  REPOSITORY_READ_ONLY_MODEL_TOOLS[1]!,
  REPOSITORY_READ_ONLY_MODEL_TOOLS[4]!,
  REPOSITORY_READ_ONLY_MODEL_TOOLS.find((tool) => tool.name === "repository.tests_for")!,
  REPOSITORY_WRITE_MODEL_TOOLS[1]!,
];
