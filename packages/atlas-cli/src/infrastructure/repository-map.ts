import { posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryConfigReferences, type ConfigReferenceResult } from "./repository-config-references.js";
import { RepositoryDeliveryMap, type DeliveryMap } from "./repository-delivery-map.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";
import { RepositoryImportGraph, isTestFile, type ImportGraph } from "./repository-import-graph.js";
import { RepositoryPackageGraph, type PackageGraph } from "./repository-package-graph.js";
import { RepositorySchemaMap, type SchemaMap } from "./repository-schema-map.js";

/**
 * One evidence-linked picture of a repository (docs/PROGRAM.md 2.3; TODO.md:
 * deterministic architecture maps, entrypoints and runtime boundaries,
 * evidence-linked summaries with confidence levels).
 *
 * It composes the package graph, import graph, env/config references,
 * CI/deploy map and schema map, and adds what only the combination shows:
 * which package owns each file, how much of each package tests reach
 * through imports, which files everything depends on, and which entry
 * points resolve to source. Every section says what it is based on, so a
 * reader (or the coder) knows how far to trust it.
 */

export interface MapEvidence {
  readonly file: string;
  readonly line: number;
}

export interface PackageSummary {
  readonly directory: string;
  readonly name: string | null;
  readonly ecosystem: string;
  readonly sourceFiles: number;
  readonly testFiles: number;
  /** Non-test source files that some test imports, directly or transitively. */
  readonly reachedByTests: number;
  readonly scripts: readonly string[];
  readonly entries: readonly { readonly field: string; readonly path: string; readonly source: string | null }[];
  readonly dependsOn: readonly string[];
}

export interface RepositoryMapResult {
  readonly packages: readonly PackageSummary[];
  /** Files imported by the most other files: change these with care. */
  readonly hubs: readonly { readonly file: string; readonly importers: number; readonly evidence: readonly MapEvidence[] }[];
  readonly configuration: {
    readonly variables: number;
    readonly undeclared: readonly string[];
    readonly secrets: readonly string[];
    readonly declarationFiles: readonly string[];
  };
  readonly delivery: {
    readonly ci: readonly string[];
    readonly targets: readonly { readonly target: string; readonly evidence: readonly MapEvidence[]; readonly triggeredBy: readonly string[] }[];
  };
  readonly data: {
    readonly migrations: readonly { readonly system: string; readonly directory: string; readonly files: number; readonly drift: SchemaMap["migrations"][number]["drift"] }[];
    readonly tables: number;
    readonly apis: readonly { readonly kind: string; readonly file: string; readonly operations: number }[];
  };
  /** What each section rests on. */
  readonly basis: Readonly<Record<"packages" | "hubs" | "configuration" | "delivery" | "data", string>>;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export interface RepositoryMapSources {
  readonly packages: (root: string) => Promise<PackageGraph>;
  readonly imports: (root: string) => Promise<ImportGraph>;
  readonly configuration: (root: string) => Promise<ConfigReferenceResult>;
  readonly delivery: (root: string) => Promise<DeliveryMap>;
  readonly schemas: (root: string) => Promise<SchemaMap>;
}

const HUB_LIMIT = 10;
const TEST_REACH_DEPTH = 4;

export class RepositoryMap {
  readonly #sources: RepositoryMapSources;

  public constructor(
    gitClient: GitClient = new GitClient(),
    fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
    sources?: Partial<RepositoryMapSources>,
  ) {
    this.#sources = {
      packages: (root) => new RepositoryPackageGraph(gitClient, fileSystem).build(root),
      imports: (root) => new RepositoryImportGraph(gitClient, fileSystem).build(root),
      configuration: (root) => new RepositoryConfigReferences(gitClient, fileSystem).find(root),
      delivery: (root) => new RepositoryDeliveryMap(gitClient, fileSystem).build(root),
      schemas: (root) => new RepositorySchemaMap(gitClient, fileSystem).build(root),
      ...sources,
    };
  }

  public async build(repositoryPath: string): Promise<RepositoryMapResult> {
    const [packages, imports, configuration, delivery, schemas] = await Promise.all([
      this.#sources.packages(repositoryPath),
      this.#sources.imports(repositoryPath),
      this.#sources.configuration(repositoryPath),
      this.#sources.delivery(repositoryPath),
      this.#sources.schemas(repositoryPath),
    ]);
    return summarize({ packages, imports, configuration, delivery, schemas });
  }
}

export function summarize(input: {
  packages: PackageGraph;
  imports: ImportGraph;
  configuration: ConfigReferenceResult;
  delivery: DeliveryMap;
  schemas: SchemaMap;
}): RepositoryMapResult {
  const { packages, imports, configuration, delivery, schemas } = input;
  const known = new Set(imports.files);
  const reached = reachedByTests(imports);
  const directories = [...new Set(packages.packages.map((item) => item.directory))].sort((a, b) => b.length - a.length);
  const owner = (file: string) => directories.find((directory) => directory === "." || file.startsWith(`${directory}/`)) ?? null;
  const counts = new Map<string, { sources: number; tests: number; reached: number }>();
  for (const file of imports.files) {
    const directory = owner(file);
    if (directory === null) continue;
    const count = counts.get(directory) ?? { sources: 0, tests: 0, reached: 0 };
    if (isTestFile(file)) count.tests += 1;
    else {
      count.sources += 1;
      if (reached.has(file)) count.reached += 1;
    }
    counts.set(directory, count);
  }

  const packageSummaries: PackageSummary[] = packages.packages.map((item) => {
    const count = counts.get(item.directory) ?? { sources: 0, tests: 0, reached: 0 };
    return {
      directory: item.directory,
      name: item.name,
      ecosystem: item.ecosystem,
      sourceFiles: count.sources,
      testFiles: count.tests,
      reachedByTests: count.reached,
      scripts: item.scripts,
      entries: item.entries.map((entry) => ({ field: entry.field, path: entry.path, source: item.ecosystem === "npm" ? entrySource(item.directory, entry.path, known) : null })),
      dependsOn: [...new Set(item.dependencies.flatMap((dependency) => dependency.internal ? [dependency.internal] : []))].sort(),
    };
  });

  const importers = new Map<string, MapEvidence[]>();
  for (const edge of imports.edges) {
    if (edge.kind !== "file" || edge.to === null || edge.to === edge.from) continue;
    const list = importers.get(edge.to) ?? [];
    if (!list.some((item) => item.file === edge.from)) list.push({ file: edge.from, line: edge.line });
    importers.set(edge.to, list);
  }
  const hubs = [...importers.entries()]
    .filter(([file]) => !isTestFile(file))
    .map(([file, list]) => ({ file, importers: list.length, evidence: list.slice(0, 3) }))
    .sort((a, b) => b.importers - a.importers || a.file.localeCompare(b.file))
    .slice(0, HUB_LIMIT);

  const triggersByFile = new Map(delivery.workflows.map((workflow) => [workflow.file, workflow.triggers.map((trigger) => trigger === "push" || trigger === "pull_request" ? `${trigger}${workflow.branches.length ? ` [${workflow.branches.join(", ")}]` : ""}` : trigger)]));

  return {
    packages: packageSummaries,
    hubs,
    configuration: {
      variables: configuration.variables.length,
      // Reads that only tests make (fixtures, fakes) are not configuration.
      undeclared: configuration.variables
        .filter((variable) => variable.undeclared && variable.references.some((reference) => reference.kind === "read" && !isTestFile(reference.file)))
        .map((variable) => variable.name),
      secrets: configuration.variables.filter((variable) => variable.references.some((reference) => reference.kind === "secret")).map((variable) => variable.name),
      declarationFiles: configuration.declarationFiles,
    },
    delivery: {
      ci: delivery.ci.map((item) => item.system === "GitHub Actions" ? `GitHub Actions (${delivery.workflows.length} workflow${delivery.workflows.length === 1 ? "" : "s"})` : `${item.system} (${item.file})`),
      targets: delivery.targets.map((target) => ({
        target: target.target,
        evidence: target.evidence.map((item) => ({ file: item.file, line: item.line })),
        triggeredBy: [...new Set(target.evidence.flatMap((item) => triggersByFile.get(item.file) ?? []))],
      })),
    },
    data: {
      migrations: schemas.migrations.map((set) => ({ system: set.system, directory: set.directory, files: set.files.length, drift: set.drift })),
      tables: schemas.tables.filter((table) => !table.dropped && table.source === "sql").length || schemas.tables.filter((table) => table.source !== "sql").length,
      apis: schemas.apis.map((api) => ({ kind: api.kind, file: api.file, operations: api.operations })),
    },
    basis: {
      packages: "Manifests (package.json, pyproject.toml) for packages and entries; import statements for file counts and test reach (lexical, depth " + TEST_REACH_DEPTH + ").",
      hubs: "Resolved import statements; dynamic or computed imports are not seen.",
      configuration: "Literal environment reads in code, example env files, workflow env and wrangler vars; \"undeclared\" counts only reads outside tests. Values are never read.",
      delivery: "GitHub Actions steps and platform config files, matched lexically.",
      data: "SQL migrations replayed in order and ORM schema declarations; API schema files by their markers.",
    },
    warnings: [...packages.warnings, ...imports.warnings, ...configuration.warnings, ...delivery.warnings, ...schemas.warnings],
  };
}

/** Files some test reaches through imports within TEST_REACH_DEPTH hops. */
function reachedByTests(graph: ImportGraph): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "file" || edge.to === null) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const reached = new Set<string>();
  let frontier = graph.files.filter(isTestFile);
  for (let depth = 0; depth < TEST_REACH_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of outgoing.get(file) ?? []) {
        if (reached.has(target)) continue;
        reached.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return reached;
}

/** The source file an npm entry point stands for, mapping built output (dist/, build/, lib/) back to src/. */
function entrySource(directory: string, entry: string, known: ReadonlySet<string>): string | null {
  const inside = (path: string) => directory === "." ? posix.normalize(path) : posix.normalize(posix.join(directory, path));
  const path = entry.replace(/^\.\//u, "");
  const built = /^(?:dist|build|lib|out)\/(.+?)(?:\.d)?\.(?:[cm]?js|[cm]?ts)$/u.exec(path)?.[1];
  const stems = [path.replace(/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/u, ""), ...(built ? [`src/${built}`, built] : [])];
  for (const stem of stems) {
    if (known.has(inside(path))) return inside(path);
    for (const extension of [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".jsx"]) {
      if (known.has(inside(stem + extension))) return inside(stem + extension);
    }
  }
  return null;
}
