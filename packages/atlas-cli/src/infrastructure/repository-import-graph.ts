import { extname, posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";

/**
 * Who imports what, and which tests exercise a file (docs/PROGRAM.md 2.3).
 *
 * Deterministic and evidence-linked: every edge names the importing file,
 * the line and the specifier as written, so a conclusion ("these tests cover
 * auth/session.ts") can be checked by reading those lines. Lexical, like the
 * symbol indexer: it reads import statements, it does not execute or
 * type-check anything, and it says what it could not resolve.
 *
 * TypeScript/JavaScript: import/export-from, dynamic import(), require(),
 * with extension and index resolution, including ESM ".js" specifiers that
 * point at ".ts" sources. Python: import and from-import, relative (dots)
 * and repository-rooted modules.
 */

export interface ImportEdge {
  readonly from: string;
  readonly to: string | null;
  readonly specifier: string;
  readonly line: number;
  readonly kind: "file" | "package" | "unresolved";
}

export interface ImportGraph {
  readonly files: readonly string[];
  readonly edges: readonly ImportEdge[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export interface TestsForResult {
  readonly path: string;
  readonly tests: readonly { readonly test: string; readonly chain: readonly { readonly file: string; readonly line: number; readonly specifier: string }[] }[];
  readonly searchedDepth: number;
}

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ".py"]);
const DEFAULTS = { maxFiles: 20_000, maxFileBytes: 1024 * 1024, maxDepth: 25 };

// Matched over the whole file, not line by line: `import {\n a,\n b\n} from "x"`
// spans lines, and most real imports of more than one name do. The line
// reported is the one holding the specifier.
const SCRIPT_IMPORT = [
  /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:[\w*$\s,]+|\{[^}]*\})(?:\s*,\s*\{[^}]*\})?\s*from\s*["']([^"'\n]+)["']/gmu,
  /^[ \t]*import\s*["']([^"'\n]+)["']/gmu,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/gu,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/gu,
];
const PYTHON_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+/u;
const PYTHON_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/u;

export function isTestFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const name = posix.basename(normalized);
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name)
    || /^test_.*\.py$/u.test(name) || /_test\.py$/u.test(name)
    || /(?:^|\/)(?:__tests__|tests?)\//u.test(normalized);
}

export class RepositoryImportGraph {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async build(repositoryPath: string, options: Partial<typeof DEFAULTS> = {}): Promise<ImportGraph> {
    const limits = { ...DEFAULTS, ...options };
    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()),
    });
    const warnings: { code: string; message: string }[] = [...enumeration.warnings];
    const files = enumeration.files.map((file) => file.relativePath.replaceAll("\\", "/"));
    const known = new Set(files);
    const edges: ImportEdge[] = [];
    for (const file of enumeration.files) {
      if (file.size > limits.maxFileBytes) continue;
      let text: string;
      try {
        const buffer = await this.fileSystem.readFile(file.absolutePath);
        if (buffer.subarray(0, 8_192).includes(0)) continue;
        text = buffer.toString("utf8");
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${file.relativePath}` });
        continue;
      }
      const from = file.relativePath.replaceAll("\\", "/");
      const python = extname(from).toLowerCase() === ".py";
      const found = python ? pythonSpecifiers(text) : scriptSpecifiers(text);
      for (const { specifier, line } of found) {
        const to = python ? resolvePython(from, specifier, known) : resolveScript(from, specifier, known);
        const kind = to !== null ? "file" : isRelative(specifier, python) ? "unresolved" : "package";
        edges.push({ from, to, specifier, line, kind });
      }
    }
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Import graph stopped after ${limits.maxFiles} files.` });
    return { files, edges, warnings };
  }
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function scriptSpecifiers(text: string): { specifier: string; line: number }[] {
  const found = new Map<string, { specifier: string; line: number }>();
  for (const pattern of SCRIPT_IMPORT) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const line = lineAt(text, (match.index ?? 0) + match[0].lastIndexOf(specifier));
      found.set(`${line}:${specifier}`, { specifier, line });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function pythonSpecifiers(text: string): { specifier: string; line: number }[] {
  const found: { specifier: string; line: number }[] = [];
  text.split(/\r?\n/u).forEach((lineText, index) => {
    const from = PYTHON_FROM.exec(lineText);
    if (from?.[1]) { found.push({ specifier: from[1], line: index + 1 }); return; }
    const plain = PYTHON_IMPORT.exec(lineText);
    if (plain?.[1]) for (const part of plain[1].split(",")) {
      const specifier = part.trim().split(/\s+/u)[0];
      if (specifier) found.push({ specifier, line: index + 1 });
    }
  });
  return found;
}

function isRelative(specifier: string, python: boolean): boolean {
  return python ? specifier.startsWith(".") : specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveScript(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!isRelative(specifier, false)) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base];
  // ESM TypeScript writes "./x.js" for a source file "./x.ts".
  const withoutJs = base.replace(/\.(?:m|c)?js$/u, "");
  if (withoutJs !== base) candidates.push(...SCRIPT_EXTENSIONS.map((extension) => withoutJs + extension));
  candidates.push(...SCRIPT_EXTENSIONS.map((extension) => base + extension));
  candidates.push(...SCRIPT_EXTENSIONS.map((extension) => `${base}/index${extension}`));
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

function resolvePython(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  const dots = /^\.*/u.exec(specifier)?.[0].length ?? 0;
  const module = specifier.slice(dots).split(".").filter(Boolean);
  const roots: string[] = [];
  if (dots > 0) {
    let directory = posix.dirname(from);
    for (let level = 1; level < dots; level += 1) directory = posix.dirname(directory);
    roots.push(directory === "." ? "" : directory);
  } else {
    roots.push("", "src");
  }
  for (const root of roots) {
    const path = [root, ...module].filter(Boolean).join("/");
    for (const candidate of [`${path}.py`, `${path}/__init__.py`]) if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Tests that reach `path` through imports, with the chain that proves it.
 * Breadth-first over reversed edges, so each test's chain is a shortest one.
 */
export function testsFor(graph: ImportGraph, path: string, maxDepth = 4): TestsForResult {
  const target = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const importers = new Map<string, ImportEdge[]>();
  for (const edge of graph.edges) {
    if (edge.to === null) continue;
    const list = importers.get(edge.to) ?? [];
    list.push(edge);
    importers.set(edge.to, list);
  }
  const chains = new Map<string, { file: string; line: number; specifier: string }[]>([[target, []]]);
  let frontier = [target];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const edge of importers.get(file) ?? []) {
        if (chains.has(edge.from)) continue;
        chains.set(edge.from, [{ file: edge.from, line: edge.line, specifier: edge.specifier }, ...chains.get(file)!]);
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  const tests = [...chains.entries()]
    .filter(([file]) => file !== target || isTestFile(target))
    .filter(([file]) => isTestFile(file))
    .map(([test, chain]) => ({ test, chain }))
    .sort((a, b) => a.chain.length - b.chain.length || a.test.localeCompare(b.test));
  return { path: target, tests, searchedDepth: maxDepth };
}
