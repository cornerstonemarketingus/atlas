import { cp, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SafeCommandRequest, SafeCommandRunner } from "../domain/safe-command-runner.js";
import { SafeCommandError } from "../domain/safe-command-runner.js";
import type { ValidationProfileRunRequest, ValidationProfileRunner } from "../domain/validation-profile.js";
import { BoundedCommandRunner } from "./bounded-command-runner.js";
import { SafeValidationProfileRunner } from "./validation-profile-runner.js";

// Reuse Atlas's container policy; this mode requires the complete Atlas checkout.
// The URL is relative to the compiled dist/src/infrastructure module.
export interface ContainerAdapter {
  resolveContainerSandbox(options: { runtime: string; image: string }): { runtime: string };
  containerRunArguments(options: {
    sandbox: { runtime: string }; name: string; workspaceRoot: string; cwd: string;
    argv: string[]; env: Record<string, string>; network: boolean;
  }): string[];
  killContainer(sandbox: { runtime: string }, name: string): boolean;
}

export interface ContainerValidationOptions {
  readonly repositoryRoot: string;
  readonly runtime: string;
  readonly image?: string;
  readonly packageManager: string;
  readonly timeoutMs: number;
  /** Trusted orchestration opts into network solely for fixed npm ci --ignore-scripts. */
  readonly installDependencies?: boolean;
}

export interface ContainerValidationDependencies {
  readonly adapter?: ContainerAdapter;
  readonly runner?: (workspace: string, timeoutMs: number) => SafeCommandRunner;
}

/** Each validation pass gets a disposable copy, never the coder's writable tree. */
export class ContainerValidationProfileRunner implements ValidationProfileRunner {
  private cleanupBlocked = false;
  private constructor(
    private readonly options: ContainerValidationOptions,
    private readonly adapter: ContainerAdapter,
    private readonly sandbox: { runtime: string },
    private readonly dependencies: ContainerValidationDependencies,
  ) {}

  public static async create(options: ContainerValidationOptions, dependencies: ContainerValidationDependencies = {}): Promise<ContainerValidationProfileRunner> {
    if (!isAbsolute(options.runtime)) throw new SafeCommandError("invalid-request", "Container runtime must be an absolute path.");
    if (!/^[a-z][a-z0-9-]*$/u.test(options.packageManager)) throw new SafeCommandError("invalid-request", "Container package manager must be a bare executable name.");
    const moduleUrl = new URL("../../../../../apps/local-control/src/platform/terminal/container-sandbox.mjs", import.meta.url);
    const adapter = dependencies.adapter ?? await import(moduleUrl.href) as ContainerAdapter;
    const sandbox = adapter.resolveContainerSandbox({ runtime: options.runtime, image: options.image ?? "node:22-bookworm-slim" });
    return new ContainerValidationProfileRunner(options, adapter, sandbox, dependencies);
  }

  public async run(request: ValidationProfileRunRequest) {
    if (this.cleanupBlocked) throw new Error("Validation stopped because container cleanup could not be confirmed.");
    const source = await realpath(resolve(this.options.repositoryRoot));
    const temporary = await mkdtemp(join(tmpdir(), "atlas-validation-"));
    const workspace = join(temporary, "workspace");
    try {
      await snapshotRepository(source, workspace, request.signal);
      await mkdir(join(workspace, ".tmp"), { recursive: true });
      if (this.options.installDependencies) {
        if (this.options.packageManager !== "npm") throw new Error("Container dependency provisioning currently supports npm only.");
        for (const directory of new Set(request.profiles.map((profile) => profile.cwd ?? "."))) {
          const cwd = await confinedCwd(workspace, directory);
          const installation = await this.runContainer(workspace, cwd, { executable: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], ...(request.signal ? { signal: request.signal } : {}) }, true);
          if (installation.exitCode !== 0 || installation.timedOut || installation.cancelled) throw new Error("Container validation dependency provisioning failed.");
        }
      }
      const commandRunner: SafeCommandRunner = {
        run: async (command) => {
          if (this.cleanupBlocked) throw new Error("Validation stopped because container cleanup could not be confirmed.");
          const cwd = await confinedCwd(workspace, command.cwd);
          if (command.executable !== this.options.packageManager) throw new SafeCommandError("executable-not-allowed", "Validation executable is not allowlisted.");
          if (Object.keys(command.environment ?? {}).length !== 0) throw new SafeCommandError("environment-not-allowed", "Container validation does not accept caller environment variables.");
          return this.runContainer(workspace, cwd, command);
        },
      };
      const snapshot = await new SafeValidationProfileRunner(commandRunner).run(request);
      if (this.cleanupBlocked) throw new Error("Validation stopped because container cleanup could not be confirmed.");
      return snapshot;
    } finally {
      // Only Atlas-created scratch paths are removed. Test-created links are
      // unlinked by rm, never traversed, and no files are copied back.
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async runContainer(workspace: string, cwd: string, command: SafeCommandRequest, network = false) {
    const name = `atlas-validation-${randomUUID()}`;
    const runner = this.dependencies.runner?.(workspace, this.options.timeoutMs) ?? new BoundedCommandRunner({
      repositoryRoot: workspace,
      allowedExecutables: [this.options.runtime],
      // For the trusted Docker client only; none of these enter the sandbox.
      inheritedEnvironmentVariables: ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"],
      timeoutMs: this.options.timeoutMs,
    });
    const args = this.adapter.containerRunArguments({
      sandbox: this.sandbox, name, workspaceRoot: workspace, cwd,
      argv: [command.executable, ...(command.args ?? [])],
      env: { CI: "true", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, network,
    });
    try {
      const result = await runner.run({ executable: this.options.runtime, args, ...(command.signal ? { signal: command.signal } : {}) });
      // Docker reserves these for daemon/image/startup errors, not a test
      // verdict. Treating them as baseline test failures could "verify" a run
      // whose baseline and post-change checks never actually executed.
      if ([125, 126, 127].includes(result.exitCode ?? -1)) throw new SafeCommandError("spawn-failed", "Validation container could not start its command.");
      return result;
    } finally {
      // Killing the Docker client alone does not kill its container. Also
      // remove successful commands that left children running in their PID namespace.
      if (!this.adapter.killContainer(this.sandbox, name)) {
        this.cleanupBlocked = true;
        // --rm may already have removed it. A read-only inspect distinguishes
        // that normal case from a daemon failure; never silently leak compute.
        const inspector = this.dependencies.runner?.(workspace, 15_000) ?? new BoundedCommandRunner({
          repositoryRoot: workspace, allowedExecutables: [this.options.runtime], timeoutMs: 15_000,
          inheritedEnvironmentVariables: ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_RUNTIME_DIR", "TEMP", "TMP"],
        });
        const inspection = await inspector.run({ executable: this.options.runtime, args: ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"] });
        if (inspection.exitCode !== 0 || inspection.stdout.trim() !== "") {
          throw new Error("Validation container cleanup could not be confirmed.");
        }
        this.cleanupBlocked = false;
      }
    }
  }
}

export async function snapshotRepository(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const deadline = Date.now() + 60_000;
  await cp(source, destination, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: async (path) => {
      if (signal?.aborted || Date.now() > deadline) throw new Error("Validation snapshot cancelled or timed out.");
      if ([".git", ".atlas"].includes(basename(path))) return false;
      if (++entries > 100_000) throw new Error("Validation snapshot file quota exceeded.");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        // Preserve internal dependency links (node_modules/.bin), but do not
        // import content outside this repository or leak its host path.
        const target = await realpath(path).catch(() => null);
        return target !== null && contained(source, target);
      }
      if (!metadata.isDirectory() && !metadata.isFile()) return false;
      bytes += metadata.isFile() ? metadata.size : 0;
      if (bytes > 512 * 1024 ** 2) throw new Error("Validation snapshot byte quota exceeded.");
      return true;
    },
  });
}

async function confinedCwd(root: string, requested = "."): Promise<string> {
  if (isAbsolute(requested) || requested.split(/[\\/]+/u).includes("..")) throw new SafeCommandError("cwd-outside-repository", "Validation cwd must be repository-relative.");
  let cwd = root;
  for (const segment of requested.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".")) {
    cwd = join(cwd, segment);
    if ((await lstat(cwd)).isSymbolicLink()) throw new SafeCommandError("cwd-is-symlink", "Validation cwd cannot be a symlink.");
  }
  const canonical = await realpath(cwd);
  if (!contained(root, canonical)) throw new SafeCommandError("cwd-outside-repository", "Validation cwd escaped the snapshot.");
  return canonical;
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
