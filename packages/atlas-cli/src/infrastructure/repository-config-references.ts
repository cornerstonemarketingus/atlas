import { posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";

/**
 * Where each environment variable is read and where it is declared
 * (docs/PROGRAM.md 2.3: env/config refs; TODO.md: configuration and
 * environment-variable reference discovery).
 *
 * Reads: process.env / import.meta.env / Deno.env / Bun.env in TS/JS,
 * os.environ / os.getenv in Python, and ${{ secrets.X }} / ${{ vars.X }} in
 * GitHub workflows. Declarations: keys in example env files (.env.example,
 * .dev.vars.example, ...), `env:` keys in workflows, and [vars] in
 * wrangler.toml. Every entry names a file and line.
 *
 * Never reads a real .env or .dev.vars file, and never records a value:
 * names only, so the result is safe to show a model or a person.
 */

export type ReferenceKind = "read" | "declared" | "secret" | "variable";

export interface ConfigReference {
  readonly file: string;
  readonly line: number;
  /** read: code reads it; declared: an example file or env: block names it; secret/variable: a workflow takes it from GitHub secrets/vars. */
  readonly kind: ReferenceKind;
  /** How it was found, e.g. "process.env", "os.getenv", "workflow env", ".env.example". */
  readonly via: string;
}

export interface ConfigVariable {
  readonly name: string;
  readonly references: readonly ConfigReference[];
  /** Read in code, but not declared in any example file, workflow env or wrangler vars. */
  readonly undeclared: boolean;
}

export interface ConfigReferenceResult {
  readonly variables: readonly ConfigVariable[];
  /** Files that supplied declarations; `undeclared` means nothing when this is empty. */
  readonly declarationFiles: readonly string[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const KIND_ORDER: readonly ReferenceKind[] = ["declared", "secret", "variable", "read"];
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/u;
const PYTHON = /\.py$/u;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const ACTION = /(?:^|\/)action\.ya?ml$/u;
const EXAMPLE_ENV = /^(?:\.env|\.dev\.vars|env)(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults)$|^\.env\.(?:example|sample|template)(?:\.[\w-]+)*$/u;
const WRANGLER = /^wrangler\.toml$/u;
const DEFAULTS = { maxFiles: 20_000, maxDepth: 25, maxFileBytes: 1024 * 1024 };
const NAME = "[A-Za-z_][A-Za-z0-9_]*";

const SCRIPT_READS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`\\bprocess\\.env\\.(${NAME})`, "gu"), "process.env"],
  [new RegExp(`\\bprocess\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "gu"), "process.env"],
  [new RegExp(`\\bimport\\.meta\\.env\\.(${NAME})`, "gu"), "import.meta.env"],
  [new RegExp(`\\bDeno\\.env\\.get\\(\\s*["'](${NAME})["']`, "gu"), "Deno.env"],
  [new RegExp(`\\bBun\\.env\\.(${NAME})`, "gu"), "Bun.env"],
];
const PYTHON_READS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`\\bos\\.environ\\[\\s*["'](${NAME})["']\\s*\\]`, "gu"), "os.environ"],
  [new RegExp(`\\bos\\.environ\\.(?:get|setdefault|pop)\\(\\s*["'](${NAME})["']`, "gu"), "os.environ"],
  [new RegExp(`\\bos\\.getenv\\(\\s*["'](${NAME})["']`, "gu"), "os.getenv"],
];
const WORKFLOW_CONTEXT = new RegExp(`\\b(secrets|vars)\\.(${NAME})`, "gu");
// Names every process (or GitHub runner) provides; reading them says nothing
// about the repository's configuration.
const AMBIENT_NAMES = new Set(["NODE_ENV", "HOME", "PATH", "PWD", "CI", "TMPDIR", "TEMP", "TMP", "USER", "SHELL", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]);
const isAmbient = (name: string) => AMBIENT_NAMES.has(name) || /^(?:GITHUB|RUNNER|ACTIONS)_/u.test(name);

export class RepositoryConfigReferences {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async find(repositoryPath: string, options: Partial<typeof DEFAULTS> = {}): Promise<ConfigReferenceResult> {
    const limits = { ...DEFAULTS, ...options };
    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => classify(path.replaceAll("\\", "/")) !== null,
    });
    const warnings: { code: string; message: string }[] = [...enumeration.warnings];
    const references = new Map<string, ConfigReference[]>();
    const declarationFiles = new Set<string>();
    const add = (name: string, reference: ConfigReference) => {
      const list = references.get(name) ?? [];
      if (!list.some((item) => item.file === reference.file && item.line === reference.line && item.kind === reference.kind)) list.push(reference);
      references.set(name, list);
    };
    for (const file of enumeration.files) {
      const path = file.relativePath.replaceAll("\\", "/");
      const type = classify(path);
      if (type === null || file.size > limits.maxFileBytes) continue;
      let text: string;
      try {
        const buffer = await this.fileSystem.readFile(file.absolutePath);
        if (buffer.subarray(0, 8_192).includes(0)) continue;
        text = buffer.toString("utf8");
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${path}` });
        continue;
      }
      if (type === "script" || type === "python") {
        for (const [pattern, via] of type === "script" ? SCRIPT_READS : PYTHON_READS) {
          for (const match of text.matchAll(pattern)) {
            if (!isAmbient(match[1]!)) add(match[1]!, { file: path, line: lineAt(text, match.index ?? 0), kind: "read", via });
          }
        }
      } else if (type === "workflow") {
        for (const match of text.matchAll(WORKFLOW_CONTEXT)) {
          if (isAmbient(match[2]!)) continue;
          add(match[2]!, { file: path, line: lineAt(text, match.index ?? 0), kind: match[1] === "secrets" ? "secret" : "variable", via: `workflow ${match[1]}` });
        }
        const declared = workflowEnvKeys(text);
        if (declared.length > 0) declarationFiles.add(path);
        for (const { name, line } of declared) if (!isAmbient(name)) add(name, { file: path, line, kind: "declared", via: "workflow env" });
      } else if (type === "example") {
        declarationFiles.add(path);
        text.split(/\r?\n/u).forEach((lineText, index) => {
          const match = new RegExp(`^\\s*(?:export\\s+)?#?\\s*(${NAME})\\s*=`, "u").exec(lineText);
          if (match?.[1] && !/^\s*#\s*[a-z]/u.test(lineText)) add(match[1], { file: path, line: index + 1, kind: "declared", via: posix.basename(path) });
        });
      } else if (type === "wrangler") {
        const vars = wranglerVars(text);
        if (vars.length > 0) declarationFiles.add(path);
        for (const { name, line } of vars) add(name, { file: path, line, kind: "declared", via: "wrangler vars" });
      }
    }
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Search stopped after ${limits.maxFiles} files.` });
    const variables = [...references.entries()]
      .map(([name, list]) => {
        const sorted = [...list].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
        const read = sorted.some((item) => item.kind === "read");
        const declared = sorted.some((item) => item.kind !== "read");
        return { name, references: sorted, undeclared: declarationFiles.size > 0 && read && !declared };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { variables, declarationFiles: [...declarationFiles].sort(), warnings };
  }
}

type FileType = "script" | "python" | "workflow" | "example" | "wrangler";

function classify(path: string): FileType | null {
  const base = posix.basename(path);
  // A real .env/.dev.vars holds secret values: never opened.
  if (EXAMPLE_ENV.test(base)) return "example";
  if (WORKFLOW.test(path) || ACTION.test(path)) return "workflow";
  if (WRANGLER.test(base)) return "wrangler";
  if (/\.d\.[cm]?ts$/u.test(base)) return null;
  if (SCRIPT.test(base)) return "script";
  if (PYTHON.test(base)) return "python";
  return null;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

/** Keys of every `env:` mapping in a workflow (top level, job or step), by indentation. */
function workflowEnvKeys(text: string): { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\s*)(?:-\s+)?env:\s*(?:#.*)?$/u.exec(lines[index]!);
    if (!header) continue;
    const indent = header[0].indexOf("env:");
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      if (/^\s*(?:#.*)?$/u.test(line)) continue;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      const key = new RegExp(`^\\s*(${NAME})\\s*:`, "u").exec(line);
      if (key?.[1]) found.push({ name: key[1], line: next + 1 });
    }
  }
  return found;
}

/** Keys under [vars] (and [env.<name>.vars]) in wrangler.toml; values are not kept. */
function wranglerVars(text: string): { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  let inVars = false;
  text.split(/\r?\n/u).forEach((line, index) => {
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (header) { inVars = /^(?:env\.[\w-]+\.)?vars$/u.test(header[1]!.trim()); return; }
    if (!inVars) return;
    const key = new RegExp(`^\\s*(${NAME})\\s*=`, "u").exec(line);
    if (key?.[1]) found.push({ name: key[1], line: index + 1 });
  });
  return found;
}
