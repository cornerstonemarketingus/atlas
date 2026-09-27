import { posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";
import { isTestFile } from "./repository-import-graph.js";

/**
 * Where untrusted input enters a repository and where code does something
 * with consequences (docs/PROGRAM.md 2.3; TODO.md: security-sensitive
 * surfaces and trust boundaries).
 *
 * Entry points: file-routed HTTP handlers (app/.../route.ts exporting GET,
 * POST, ...), Express-style routes and `url.pathname` checks in plain Node
 * servers, each with whether an authentication guard is called in the same
 * file. Sinks: command execution, dynamic code, raw SQL built with
 * interpolation, outbound requests to computed URLs, and reads of
 * sensitive-looking environment names.
 *
 * This is a map for review, not a verdict: "no guard found" means no known
 * guard name appears in the file, which a reviewer confirms; a sink is a
 * place to look, not a vulnerability. Every entry has a file and line.
 * Test files are left out. Lexical; nothing is executed.
 */

export type SinkKind = "command-execution" | "dynamic-code" | "raw-sql" | "computed-url-request" | "sensitive-env";

export interface SurfaceEvidence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface HttpEntryPoint {
  /** Route as written or derived from the file path, e.g. /api/tasks/[id]. */
  readonly route: string;
  readonly methods: readonly string[];
  readonly style: "file-route" | "express" | "node-pathname";
  readonly evidence: SurfaceEvidence;
  /** The first authentication/authorization guard call in the same file, if any. */
  readonly guard: SurfaceEvidence | null;
}

export interface SecuritySurfaces {
  readonly entryPoints: readonly HttpEntryPoint[];
  readonly sinks: readonly { readonly kind: SinkKind; readonly evidence: SurfaceEvidence }[];
  readonly summary: {
    readonly entryPoints: number;
    readonly withoutGuard: number;
    readonly sinks: Readonly<Record<SinkKind, number>>;
  };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/u;
const DEFAULTS = { maxFiles: 20_000, maxDepth: 25, maxFileBytes: 1024 * 1024 };

// Names that authenticate or authorize a request. Deliberately broad: a
// miss shows up as "no guard found" and is checked by a person.
const GUARD = /\b(?:authenticated\w*|authenticate\w*|authorize\w*|require(?:Auth|User|Operator|Session|Account|Admin|Owner|Signature|Tenant)\w*|verify\w*(?:Identity|Session|Token|Signature|Webhook|Jwt|JWT|Operator|Device|Companion|Request|Credential|Auth)\w*|check(?:Auth|Permission|Access)\w*|getSession|getServerSession|currentUser|isAuthenticated|withAuth|assert(?:Operator|Authenticated|Owner|Admin|Tenant)\w*)\s*\(/u;

const SINKS: readonly (readonly [SinkKind, RegExp, "script" | "python" | "both"])[] = [
  // Bare or child_process-qualified; `pattern.exec(` (RegExp) is not a process.
  ["command-execution", /(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\b(?:child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/u, "script"],
  ["command-execution", /\bshell\s*:\s*true\b/u, "script"],
  ["command-execution", /\b(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.(?:system|popen))\s*\(/u, "python"],
  ["dynamic-code", /(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w+|compileFunction)\s*\(/u, "script"],
  ["dynamic-code", /(?<![.\w])(?:eval|exec)\s*\(/u, "python"],
  ["raw-sql", /\bsql\.raw\s*\(|\.(?:run|exec|execute|query|prepare|all|get)\s*\(\s*`[^`]*\$\{/u, "script"],
  ["raw-sql", /\.(?:execute|executemany|executescript)\s*\(\s*(?:f["']|["'][^"']*["']\s*%)/u, "python"],
  ["computed-url-request", /\bfetch\s*\(\s*(?!["'`]|`[^`$]*`)[\w$.[\]()]+/u, "script"],
  ["computed-url-request", /\brequests\.(?:get|post|put|patch|delete|request)\s*\(\s*(?!["'])/u, "python"],
  ["sensitive-env", /\bprocess\.env(?:\.|\[\s*["'])\w*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE_KEY|API_KEY|CREDENTIAL)\w*/u, "script"],
  ["sensitive-env", /\bos\.(?:environ(?:\.get)?|getenv)\s*[[(]\s*["']\w*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE_KEY|API_KEY|CREDENTIAL)\w*/u, "python"],
];

export class RepositorySecuritySurfaces {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async find(repositoryPath: string, options: Partial<typeof DEFAULTS> = {}): Promise<SecuritySurfaces> {
    const limits = { ...DEFAULTS, ...options };
    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => {
        const normalized = path.replaceAll("\\", "/");
        return SOURCE.test(normalized) && !isTestFile(normalized) && !/\.d\.[cm]?ts$/u.test(normalized) && !/(?:^|\/)(?:fixtures?|examples?)\//u.test(normalized);
      },
    });
    const warnings: { code: string; message: string }[] = [...enumeration.warnings];
    const entryPoints: HttpEntryPoint[] = [];
    const sinks: { kind: SinkKind; evidence: SurfaceEvidence }[] = [];
    for (const file of [...enumeration.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      if (file.size > limits.maxFileBytes) continue;
      const path = file.relativePath.replaceAll("\\", "/");
      let text: string;
      try {
        const buffer = await this.fileSystem.readFile(file.absolutePath);
        if (buffer.subarray(0, 8_192).includes(0)) continue;
        text = buffer.toString("utf8");
      } catch {
        warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${path}` });
        continue;
      }
      const python = path.endsWith(".py");
      const lines = text.split(/\r?\n/u);
      const evidence = (index: number): SurfaceEvidence => ({ file: path, line: index + 1, text: lines[index]!.trim().slice(0, 200) });
      const commented = (line: string) => /^\s*(?:\/\/|\*|\/\*|#)/u.test(line);
      const guardIndex = lines.findIndex((line) => !commented(line) && GUARD.test(line) && !/^\s*(?:export\s+)?(?:async\s+)?function\s/u.test(line) && !/^\s*import\s/u.test(line));
      const guard = guardIndex === -1 ? null : evidence(guardIndex);

      if (!python) {
        const methods: { method: string; index: number }[] = [];
        lines.forEach((line, index) => {
          const match = /^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|^\s*export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/u.exec(line);
          if (match) methods.push({ method: (match[1] ?? match[2])!, index });
        });
        if (methods.length > 0 && /(?:^|\/)route\.[cm]?[jt]s$/u.test(path)) {
          entryPoints.push({ route: fileRoute(path), methods: methods.map((item) => item.method), style: "file-route", evidence: evidence(methods[0]!.index), guard });
        }
        lines.forEach((line, index) => {
          if (commented(line)) return;
          const express = /\b(?:app|router|server|api)\.(get|post|put|patch|delete|all|use)\s*\(\s*["'`](\/[^"'`]*)["'`]/u.exec(line);
          if (express) entryPoints.push({ route: express[2]!, methods: [express[1]!.toUpperCase()], style: "express", evidence: evidence(index), guard });
          for (const match of line.matchAll(/\b(?:url\.)?pathname\s*(?:===|==)\s*["'`](\/[^"'`]*)["'`]|\b(?:url\.)?pathname\.startsWith\(\s*["'`](\/[^"'`]*)["'`]/gu)) {
            const method = /\bmethod\s*===?\s*["'](GET|POST|PUT|PATCH|DELETE)["']/u.exec(line)?.[1];
            entryPoints.push({ route: (match[1] ?? `${match[2]}*`)!, methods: method ? [method] : [], style: "node-pathname", evidence: evidence(index), guard });
          }
        });
      }

      lines.forEach((line, index) => {
        if (commented(line)) return;
        for (const [kind, pattern, language] of SINKS) {
          if ((language === "python") !== python && language !== "both") continue;
          if (pattern.test(line)) {
            sinks.push({ kind, evidence: evidence(index) });
            break;
          }
        }
      });
    }
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Search stopped after ${limits.maxFiles} files.` });
    const counts = Object.fromEntries((["command-execution", "dynamic-code", "raw-sql", "computed-url-request", "sensitive-env"] as const).map((kind) => [kind, sinks.filter((sink) => sink.kind === kind).length])) as Record<SinkKind, number>;
    return {
      entryPoints,
      sinks,
      summary: { entryPoints: entryPoints.length, withoutGuard: entryPoints.filter((entry) => entry.guard === null).length, sinks: counts },
      warnings,
    };
  }
}

/** app/api/tasks/[id]/route.ts -> /api/tasks/[id]; route groups "(name)" are dropped. */
function fileRoute(path: string): string {
  const parts = posix.dirname(path).split("/");
  const app = parts.lastIndexOf("app");
  const segments = (app === -1 ? parts : parts.slice(app + 1)).filter((part) => !/^\(.*\)$/u.test(part));
  return `/${segments.join("/")}`;
}

