import { posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";

/**
 * The data a repository stores and the interfaces it exposes, from the files
 * that define them (docs/PROGRAM.md 2.3: schemas; TODO.md: database schemas
 * and migration systems, API schemas such as OpenAPI, GraphQL, protobuf and
 * AsyncAPI).
 *
 * Lexical: SQL migrations are read for CREATE/ALTER/DROP TABLE in order, ORM
 * schemas (Drizzle, Prisma, SQLAlchemy) for their table names, and API
 * schema files for their kind, title and size. Nothing is connected to or
 * executed. Every table and schema names its file and line.
 */

export interface SchemaEvidence {
  readonly file: string;
  readonly line: number;
}

export interface MigrationSet {
  readonly system: string;
  readonly directory: string;
  readonly files: readonly string[];
  /** Sequence prefixes used by more than one migration (a merge conflict waiting to happen). */
  readonly duplicateSequences: readonly string[];
  /**
   * Tables these migrations leave in place compared with the ORM schema in
   * the same app (the migration directory's parent). Null when that app has
   * no ORM schema to compare with.
   */
  readonly drift: { readonly onlyInMigrations: readonly string[]; readonly onlyInSchema: readonly string[] } | null;
}

export interface TableDefinition {
  readonly name: string;
  /** "sql" (migrations), "drizzle", "prisma" or "sqlalchemy". */
  readonly source: string;
  readonly defined: SchemaEvidence;
  /** For SQL: dropped by a later migration (and not recreated). */
  readonly dropped: boolean;
}

export interface ApiSchema {
  readonly kind: "openapi" | "swagger" | "asyncapi" | "graphql" | "protobuf" | "json-schema";
  readonly file: string;
  readonly title: string | null;
  readonly version: string | null;
  /** Operations (OpenAPI paths x methods), channels (AsyncAPI), root fields (GraphQL), rpcs (protobuf). */
  readonly operations: number;
}

export interface SchemaMap {
  readonly migrations: readonly MigrationSet[];
  readonly tables: readonly TableDefinition[];
  readonly apis: readonly ApiSchema[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const DEFAULTS = { maxFiles: 20_000, maxDepth: 25, maxFileBytes: 2 * 1024 * 1024 };
const IDENT = "[`\"\\[]?([A-Za-z_][\\w$]*)[`\"\\]]?";
const QUALIFIED = `(?:${IDENT}\\s*\\.\\s*)?${IDENT}`;

/** Which migration system a directory of migrations belongs to, by where it is. */
function migrationSystem(path: string): { system: string; directory: string } | null {
  const directory = posix.dirname(path);
  const base = posix.basename(path);
  if (/(?:^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/u.test(path)) return { system: "Prisma", directory: posix.dirname(directory) };
  if (/(?:^|\/)supabase\/migrations$/u.test(directory) && base.endsWith(".sql")) return { system: "Supabase", directory };
  if (/(?:^|\/)(?:alembic|migrations)\/versions$/u.test(directory) && base.endsWith(".py")) return { system: "Alembic", directory };
  if (/(?:^|\/)migrations$/u.test(directory) && /^\d{4}_\w+\.py$/u.test(base)) return { system: "Django", directory };
  if (/(?:^|\/)db\/migrate$/u.test(directory) && /^\d+_\w+\.rb$/u.test(base)) return { system: "Rails", directory };
  if (/^V\d+(?:[._]\d+)*__\w+\.sql$/u.test(base)) return { system: "Flyway", directory };
  if (/\.(?:up|down)\.sql$/u.test(base)) return { system: "golang-migrate", directory };
  if (/(?:^|\/)drizzle(?:\/migrations)?$/u.test(directory) && base.endsWith(".sql")) return { system: "Drizzle", directory };
  if (/(?:^|\/)migrations$/u.test(directory) && base.endsWith(".sql")) return { system: "SQL migrations", directory };
  if (/(?:^|\/)migrations$/u.test(directory) && /^\d+[-_][\w-]+\.[cm]?[jt]s$/u.test(base)) return { system: "Knex/TypeORM-style migrations", directory };
  return null;
}

function apiKind(path: string): "graphql" | "protobuf" | "structured" | null {
  if (/\.(?:graphql|gql)$/u.test(path)) return "graphql";
  if (/\.proto$/u.test(path)) return "protobuf";
  if (/\.(?:ya?ml|json)$/u.test(path) && !/(?:^|\/)(?:package(?:-lock)?|tsconfig[\w.-]*|composer)\.json$/u.test(path) && !/^\.github\//u.test(path)) return "structured";
  return null;
}

function isOrmSchema(path: string): "drizzle" | "prisma" | "sqlalchemy" | null {
  // Tests, fixtures and examples declare tables too, but not the app's.
  if (/(?:^|\/)(?:tests?|__tests__|fixtures?|examples?)\//u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$/u.test(path)) return null;
  if (/\.prisma$/u.test(path)) return "prisma";
  if (/\.[cm]?[jt]sx?$/u.test(path)) return "drizzle";
  if (/\.py$/u.test(path)) return "sqlalchemy";
  return null;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

export class RepositorySchemaMap {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async build(repositoryPath: string, options: Partial<typeof DEFAULTS> = {}): Promise<SchemaMap> {
    const limits = { ...DEFAULTS, ...options };
    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => {
        const normalized = path.replaceAll("\\", "/");
        return normalized.endsWith(".sql") || migrationSystem(normalized) !== null || apiKind(normalized) !== null || isOrmSchema(normalized) !== null;
      },
    });
    const warnings: { code: string; message: string }[] = [...enumeration.warnings];
    const sets = new Map<string, { system: string; directory: string; files: string[] }>();
    const tables: TableDefinition[] = [];
    const apis: ApiSchema[] = [];
    const sqlFiles: { path: string; text: string }[] = [];
    const files = [...enumeration.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en", { numeric: true }));
    for (const file of files) {
      const path = file.relativePath.replaceAll("\\", "/");
      const migration = migrationSystem(path);
      if (migration) {
        const key = `${migration.system}\0${migration.directory}`;
        const set = sets.get(key) ?? { ...migration, files: [] };
        set.files.push(path);
        sets.set(key, set);
      }
      const sql = path.endsWith(".sql");
      const api = apiKind(path);
      const orm = isOrmSchema(path);
      if (!sql && !api && !orm) continue;
      if (file.size > limits.maxFileBytes) {
        if (sql || api === "graphql" || api === "protobuf") warnings.push({ code: "FILE_TOO_LARGE", message: `Skipped ${path}: larger than ${limits.maxFileBytes} bytes.` });
        continue;
      }
      let text: string;
      try {
        const buffer = await this.fileSystem.readFile(file.absolutePath);
        if (buffer.subarray(0, 8_192).includes(0)) continue;
        text = buffer.toString("utf8");
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${path}` });
        continue;
      }
      if (sql) {
        // Down migrations undo; only up/plain migrations describe the schema.
        if (!/\.down\.sql$/u.test(path)) sqlFiles.push({ path, text });
        continue;
      }
      if (api) {
        const schema = api === "graphql" ? graphqlSchema(path, text) : api === "protobuf" ? protobufSchema(path, text) : structuredSchema(path, text);
        if (schema) apis.push(schema);
      }
      if (orm) tables.push(...ormTables(orm, path, text));
    }
    const replayed = sqlTables(sqlFiles);
    tables.unshift(...replayed);
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Search stopped after ${limits.maxFiles} files.` });
    const migrations = [...sets.values()].map((set) => ({ ...set, duplicateSequences: duplicates(set.files), drift: drift(set, replayed, tables) }));
    for (const set of migrations) {
      for (const sequence of set.duplicateSequences) warnings.push({ code: "DUPLICATE_MIGRATION_SEQUENCE", message: `${set.directory}: more than one ${set.system} migration numbered ${sequence}.` });
    }
    return { migrations, tables, apis, warnings };
  }
}

function drift(set: { directory: string; files: readonly string[] }, replayed: readonly TableDefinition[], tables: readonly TableDefinition[]): MigrationSet["drift"] {
  const app = posix.dirname(set.directory);
  const inApp = (file: string) => app === "." || file.startsWith(`${app}/`);
  const own = new Set(set.files);
  const schema = new Set(tables.filter((table) => table.source !== "sql" && inApp(table.defined.file)).map((table) => table.name.toLowerCase()));
  if (schema.size === 0) return null;
  const migrated = new Set(replayed.filter((table) => !table.dropped && own.has(table.defined.file)).map((table) => table.name.toLowerCase()));
  return {
    onlyInMigrations: [...migrated].filter((name) => !schema.has(name)).sort(),
    onlyInSchema: [...schema].filter((name) => !migrated.has(name)).sort(),
  };
}

function duplicates(files: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const base = posix.basename(file.endsWith("/migration.sql") ? posix.dirname(file) : file);
    // golang-migrate pairs NNN_x.up.sql with NNN_x.down.sql: one sequence.
    if (/\.down\.sql$/u.test(base)) continue;
    const sequence = /^V?(\d+(?:[._]\d+)*)(?=[_-])/u.exec(base)?.[1];
    if (sequence) counts.set(sequence, (counts.get(sequence) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([sequence]) => sequence);
}

/** Replay CREATE/RENAME/DROP TABLE across migrations in order. */
function sqlTables(files: readonly { path: string; text: string }[]): TableDefinition[] {
  const live = new Map<string, TableDefinition>();
  const create = new RegExp(`\\bcreate\\s+(?:(?:global\\s+|local\\s+)?(?:temp|temporary)\\s+)?(?:virtual\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${QUALIFIED}`, "giu");
  const drop = new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${QUALIFIED}`, "giu");
  const rename = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?${QUALIFIED}\\s+rename\\s+to\\s+${QUALIFIED}`, "giu");
  for (const { path, text } of files) {
    const code = stripSqlComments(text);
    const events: { offset: number; apply: () => void }[] = [];
    for (const match of code.matchAll(create)) {
      const name = match[2]!;
      if (/\b(?:temp|temporary)\b/iu.test(match[0])) continue;
      events.push({ offset: match.index ?? 0, apply: () => live.set(name.toLowerCase(), { name, source: "sql", defined: { file: path, line: lineAt(code, match.index ?? 0) }, dropped: false }) });
    }
    for (const match of code.matchAll(drop)) {
      const name = match[2]!;
      events.push({ offset: match.index ?? 0, apply: () => {
        const existing = live.get(name.toLowerCase());
        if (existing) live.set(name.toLowerCase(), { ...existing, dropped: true });
      } });
    }
    for (const match of code.matchAll(rename)) {
      const from = match[2]!;
      const to = match[4]!;
      events.push({ offset: match.index ?? 0, apply: () => {
        const existing = live.get(from.toLowerCase());
        if (!existing) return;
        live.delete(from.toLowerCase());
        live.set(to.toLowerCase(), { ...existing, name: to, defined: { file: path, line: lineAt(code, match.index ?? 0) } });
      } });
    }
    for (const event of events.sort((a, b) => a.offset - b.offset)) event.apply();
  }
  return [...live.values()];
}

/** Blank out comments but keep offsets, so reported lines stay right. */
function stripSqlComments(text: string): string {
  return text
    .replace(/--[^\n]*/gu, (comment) => " ".repeat(comment.length))
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function ormTables(kind: "drizzle" | "prisma" | "sqlalchemy", path: string, text: string): TableDefinition[] {
  const found: TableDefinition[] = [];
  const add = (name: string, offset: number) => found.push({ name, source: kind, defined: { file: path, line: lineAt(text, offset) }, dropped: false });
  if (kind === "drizzle") {
    if (!/drizzle-orm/u.test(text)) return [];
    for (const match of text.matchAll(/\b(?:sqliteTable|pgTable|mysqlTable|singlestoreTable)\s*\(\s*["'`]([^"'`]+)["'`]/gu)) add(match[1]!, match.index ?? 0);
    // pgSchema("s").table("t")
    for (const match of text.matchAll(/\.table\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/gu)) add(match[1]!, match.index ?? 0);
  } else if (kind === "prisma") {
    for (const match of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gmu)) {
      const mapped = /@@map\(\s*"([^"]+)"\s*\)/u.exec(match[2]!)?.[1];
      add(mapped ?? match[1]!, match.index ?? 0);
    }
  } else {
    if (!/sqlalchemy|sqlmodel/u.test(text)) return [];
    for (const match of text.matchAll(/^\s+__tablename__\s*=\s*["']([^"']+)["']/gmu)) add(match[1]!, match.index ?? 0);
    for (const match of text.matchAll(/\bTable\(\s*["']([^"']+)["']\s*,\s*\w*metadata/gu)) add(match[1]!, match.index ?? 0);
  }
  return found;
}

function graphqlSchema(path: string, text: string): ApiSchema | null {
  const body = text.replace(/#[^\n]*/gu, "");
  if (!/\b(?:type|schema|extend\s+type|input|interface|enum|union|scalar)\s+\w/u.test(body)) return null;
  let operations = 0;
  for (const match of body.matchAll(/\b(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b[^{]*\{([^}]*)\}/gu)) {
    operations += match[2]!.split(/\n/u).filter((line) => /^\s*\w+\s*[(:]/u.test(line)).length;
  }
  return { kind: "graphql", file: path, title: null, version: null, operations };
}

function protobufSchema(path: string, text: string): ApiSchema {
  const body = text.replace(/\/\/[^\n]*/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  const pkg = /^\s*package\s+([\w.]+)\s*;/mu.exec(body)?.[1] ?? null;
  const syntax = /^\s*(?:syntax|edition)\s*=\s*"([^"]+)"/mu.exec(body)?.[1] ?? null;
  return { kind: "protobuf", file: path, title: pkg, version: syntax, operations: [...body.matchAll(/\brpc\s+\w+\s*\(/gu)].length };
}

/** OpenAPI, Swagger, AsyncAPI or JSON Schema, recognized by their top-level markers. */
function structuredSchema(path: string, text: string): ApiSchema | null {
  const json = path.endsWith(".json");
  let parsed: Record<string, unknown> | null = null;
  if (json) {
    try {
      const value: unknown = JSON.parse(text);
      parsed = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
    if (!parsed) return null;
  }
  const top = (key: string): string | null => {
    if (parsed) return typeof parsed[key] === "string" ? parsed[key] as string : null;
    const match = new RegExp(`^["']?${key}["']?\\s*:\\s*["']?([^"'\\s#]+)`, "mu").exec(text);
    return match?.[1] ?? null;
  };
  const kind = top("openapi") ? "openapi" : top("swagger") ? "swagger" : top("asyncapi") ? "asyncapi"
    : /json-schema\.org/u.test(top("$schema") ?? "") ? "json-schema" : null;
  if (!kind) return null;
  const version = top(kind === "json-schema" ? "$id" : kind);
  let title: string | null = null;
  let operations = 0;
  if (parsed) {
    const info = parsed["info"];
    if (info && typeof info === "object" && typeof (info as Record<string, unknown>)["title"] === "string") title = (info as Record<string, string>)["title"]!;
    if (kind === "json-schema" && typeof parsed["title"] === "string") title = parsed["title"] as string;
    const paths = parsed[kind === "asyncapi" ? "channels" : "paths"];
    if (paths && typeof paths === "object") {
      for (const item of Object.values(paths as Record<string, unknown>)) {
        operations += kind === "asyncapi" ? 1 : item && typeof item === "object" ? Object.keys(item).filter((method) => HTTP_METHODS.has(method.toLowerCase())).length : 0;
      }
    }
  } else {
    title = /^info:\s*\n(?:[ \t]+.*\n)*?[ \t]+title:\s*["']?(.+?)["']?\s*$/mu.exec(text)?.[1] ?? null;
    operations = kind === "asyncapi" ? yamlChildren(text, "channels", false) : yamlChildren(text, "paths", true);
  }
  return { kind, file: path, title, version: kind === "json-schema" ? null : version, operations };
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** Count entries under a top-level YAML key; with `methods`, count HTTP methods one level deeper. */
function yamlChildren(text: string, key: string, methods: boolean): number {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`, "u").test(line));
  if (start === -1) return 0;
  let childIndent = -1;
  let methodIndent = -1;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (childIndent === -1) childIndent = indent;
    const name = /^\s*["']?([^"':]+)["']?\s*:/u.exec(line)?.[1]?.trim().toLowerCase();
    if (!name) continue;
    if (indent === childIndent) {
      methodIndent = -1;
      if (!methods) count += 1;
      continue;
    }
    if (methodIndent === -1) methodIndent = indent;
    if (methods && indent === methodIndent && HTTP_METHODS.has(name)) count += 1;
  }
  return count;
}
