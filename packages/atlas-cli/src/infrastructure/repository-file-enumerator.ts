import { relative, resolve, sep } from "node:path";
import { GitClient } from "./git-client.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".next", ".venv", "__pycache__", "build", "coverage", "dist",
  "node_modules", "target", "venv",
]);

export interface EnumeratedRepositoryFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
}

export interface RepositoryFileEnumerationWarning {
  readonly code: "GIT_ENUMERATION_FAILED" | "PATH_UNREADABLE";
  readonly message: string;
}

export interface RepositoryFileEnumerationOptions {
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly include?: (relativePath: string) => boolean;
}

export interface RepositoryFileEnumerationResult {
  readonly root: string;
  readonly files: readonly EnumeratedRepositoryFile[];
  readonly limitReached: boolean;
  readonly warnings: readonly RepositoryFileEnumerationWarning[];
}

function isInsideRoot(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

export class RepositoryFileEnumerator {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async enumerate(
    repositoryPath: string,
    options: RepositoryFileEnumerationOptions,
  ): Promise<RepositoryFileEnumerationResult> {
    if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1) {
      throw new Error("File enumeration maxFiles must be a positive integer.");
    }
    if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0) {
      throw new Error("File enumeration maxDepth must be a non-negative integer.");
    }

    const root = await this.fileSystem.realPath(repositoryPath);
    if (!(await this.fileSystem.getStats(root)).isDirectory()) {
      throw new Error(`Repository path is not a directory: ${repositoryPath}`);
    }

    const warnings: RepositoryFileEnumerationWarning[] = [];
    const candidatePaths: string[] = [];
    const git = await this.gitClient.inspect(root);
    const gitFiles = git.isRepository
      ? await this.gitClient.listInspectableFiles(root)
      : null;

    if (git.isRepository && gitFiles !== null) {
      for (const repositoryPathValue of gitFiles) {
        const parts = repositoryPathValue.split(/[\\/]/u);
        if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) continue;
        if (parts.length - 1 > options.maxDepth) continue;
        const fullPath = resolve(root, repositoryPathValue);
        if (isInsideRoot(root, fullPath)) candidatePaths.push(fullPath);
      }
    } else {
      if (git.isRepository) {
        warnings.push({
          code: "GIT_ENUMERATION_FAILED",
          message: "Git file enumeration failed; ignore rules may not be applied.",
        });
      }
      const collect = async (directory: string, depth: number): Promise<void> => {
        let entries;
        try {
          entries = await this.fileSystem.readDirectory(directory);
        } catch {
          warnings.push({
            code: "PATH_UNREADABLE",
            message: `Could not read repository path: ${relative(root, directory) || "."}`,
          });
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const fullPath = resolve(directory, entry.name);
          if (!isInsideRoot(root, fullPath)) continue;
          if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name) && depth < options.maxDepth) {
              await collect(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            candidatePaths.push(fullPath);
          }
        }
      };
      await collect(root, 0);
    }

    const files: EnumeratedRepositoryFile[] = [];
    let limitReached = false;
    for (const absolutePath of candidatePaths) {
      const relativePath = relative(root, absolutePath);
      if (options.include !== undefined && !options.include(relativePath)) continue;
      if (files.length >= options.maxFiles) {
        limitReached = true;
        break;
      }
      try {
        const stats = await this.fileSystem.getLinkStats(absolutePath);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        files.push({ absolutePath, relativePath, size: stats.size });
      } catch {
        warnings.push({
          code: "PATH_UNREADABLE",
          message: `Could not read repository path: ${relativePath}`,
        });
      }
    }

    return { root, files, limitReached, warnings };
  }
}
