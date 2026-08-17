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
];
