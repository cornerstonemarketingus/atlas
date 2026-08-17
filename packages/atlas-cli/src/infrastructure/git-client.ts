import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitSummary } from "../domain/repository-summary.js";

const execFileAsync = promisify(execFile);

export class GitClient {
  public constructor(private readonly executable = "git") {}

  public async inspect(root: string): Promise<GitSummary> {
    try {
      await this.run(root, ["rev-parse", "--is-inside-work-tree"]);
      const [branch, head, status] = await Promise.all([
        this.runOptional(root, ["branch", "--show-current"]),
        this.runOptional(root, ["rev-parse", "HEAD"]),
        this.run(root, ["status", "--porcelain"]),
      ]);
      return {
        isAvailable: true,
        isRepository: true,
        branch: branch || null,
        headCommit: head || null,
        isDirty: status.length > 0,
      };
    } catch (error: unknown) {
      return {
        isAvailable: !this.isExecutableUnavailable(error),
        isRepository: false,
        branch: null,
        headCommit: null,
        isDirty: false,
      };
    }
  }

  public async listInspectableFiles(root: string): Promise<readonly string[] | null> {
    try {
      const output = await this.runRaw(
        root,
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        8 * 1024 * 1024,
      );
      return output.split("\0").filter((path) => path.length > 0);
    } catch {
      return null;
    }
  }

  private async run(root: string, args: readonly string[]): Promise<string> {
    return (await this.runRaw(root, args, 1024 * 1024)).trim();
  }

  private async runOptional(root: string, args: readonly string[]): Promise<string> {
    try {
      return await this.run(root, args);
    } catch {
      return "";
    }
  }

  private async runRaw(
    root: string,
    args: readonly string[],
    maxBuffer: number,
  ): Promise<string> {
    const result = await execFileAsync(this.executable, ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer,
    });
    return result.stdout;
  }

  private isExecutableUnavailable(error: unknown): boolean {
    return error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
