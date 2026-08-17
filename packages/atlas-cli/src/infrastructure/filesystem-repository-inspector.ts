import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { RepositoryInspector } from "../domain/repository-inspector.js";
import type {
  ArchitectureHint,
  ArchitectureRole,
  InspectionWarning,
  LanguageSummary,
  ManifestSummary,
  RepositorySummary,
} from "../domain/repository-summary.js";
import { FrameworkDetector } from "./framework-detector.js";
import { GitClient } from "./git-client.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next",
  ".venv", "venv", "__pycache__", "target",
]);

const LANGUAGES: Readonly<Record<string, string>> = {
  ".c": "C", ".cpp": "C++", ".cs": "C#", ".go": "Go",
  ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".rb": "Ruby", ".rs": "Rust", ".ts": "TypeScript",
  ".tsx": "TypeScript",
};

const MANIFESTS: Readonly<Record<string, string>> = {
  "package.json": "Node.js", "pyproject.toml": "Python", "Cargo.toml": "Rust",
  "go.mod": "Go", "pom.xml": "Maven", "build.gradle": "Gradle",
};

const ARCHITECTURE_DIRECTORIES: Readonly<Record<string, ArchitectureRole>> = {
  "__tests__": "tests",
  app: "applications",
  apps: "applications",
  lib: "source",
  packages: "packages",
  services: "services",
  src: "source",
  test: "tests",
  tests: "tests",
};

const FRAMEWORK_CONFIG_PATTERN = /^(angular\.json|next\.config\.(js|mjs|ts)|svelte\.config\.(js|ts)|vite\.config\.(js|mjs|ts))$/i;

export interface InspectionLimits {
  readonly maxFiles: number;
  readonly maxDepth: number;
}

const DEFAULT_LIMITS: InspectionLimits = { maxFiles: 20_000, maxDepth: 25 };

export class FilesystemRepositoryInspector implements RepositoryInspector {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly limits: InspectionLimits = DEFAULT_LIMITS,
    private readonly frameworkDetector: FrameworkDetector = new FrameworkDetector(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async inspect(repositoryPath: string): Promise<RepositorySummary> {
    const root = await this.fileSystem.realPath(repositoryPath);
    if (!(await this.fileSystem.getStats(root)).isDirectory()) {
      throw new Error(`Repository path is not a directory: ${repositoryPath}`);
    }

    const languageCounts = new Map<string, number>();
    const manifests: ManifestSummary[] = [];
    const topLevelDirectories = new Set<string>();
    const architecture = new Map<string, ArchitectureHint>();
    const packageManifestPaths: string[] = [];
    const frameworkConfigPaths: string[] = [];
    const warnings: InspectionWarning[] = [];
    let fileCount = 0;
    let limitReached = false;
    let depthLimitReached = false;
    const unreadablePaths = new Set<string>();

    const recordUnreadablePath = (path: string): void => {
      const displayPath = relative(root, path) || ".";
      if (unreadablePaths.has(displayPath)) return;
      unreadablePaths.add(displayPath);
      warnings.push({
        code: "PATH_UNREADABLE",
        message: `Could not read repository path: ${displayPath}`,
      });
    };

    const recordDirectory = (directory: string): void => {
      const directoryPath = relative(root, directory);
      if (!directoryPath) return;
      const parts = directoryPath.split(sep);
      const topLevel = parts[0];
      if (topLevel !== undefined) topLevelDirectories.add(topLevel);
      const role = ARCHITECTURE_DIRECTORIES[basename(directory).toLowerCase()];
      if (role !== undefined) architecture.set(directoryPath, { path: directoryPath, role });
    };

    const recordFile = (fullPath: string): void => {
      fileCount += 1;
      const filename = basename(fullPath);
      const language = LANGUAGES[extname(filename).toLowerCase()];
      if (language !== undefined) {
        languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
      }
      const manifestKind = MANIFESTS[filename];
      if (manifestKind !== undefined) {
        manifests.push({ path: relative(root, fullPath), kind: manifestKind });
        if (filename === "package.json") packageManifestPaths.push(fullPath);
      }
      if (FRAMEWORK_CONFIG_PATTERN.test(filename)) frameworkConfigPaths.push(fullPath);
    };

    const scan = async (directory: string, depth: number): Promise<void> => {
      if (depth > this.limits.maxDepth || limitReached) return;
      let entries;
      try {
        entries = await this.fileSystem.readDirectory(directory);
      } catch {
        recordUnreadablePath(directory);
        return;
      }
      for (const entry of entries) {
        if (limitReached) break;
        if (entry.isSymbolicLink()) continue;
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;
          recordDirectory(fullPath);
          if (depth >= this.limits.maxDepth) {
            depthLimitReached = true;
            continue;
          }
          await scan(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (fileCount >= this.limits.maxFiles) {
          limitReached = true;
          break;
        }
        recordFile(fullPath);
      }
    };

    const git = await this.gitClient.inspect(root);
    const gitFiles = git.isRepository
      ? await this.gitClient.listInspectableFiles(root)
      : null;
    if (!git.isAvailable) {
      warnings.push({
        code: "GIT_UNAVAILABLE",
        message: "Git is unavailable; repository state and ignore rules could not be inspected.",
      });
    }
    if (git.isRepository && gitFiles !== null) {
      for (const repositoryPath of gitFiles) {
        if (fileCount >= this.limits.maxFiles) {
          limitReached = true;
          break;
        }
        const pathParts = repositoryPath.split(/[\\/]/u);
        if (pathParts.some((part) => IGNORED_DIRECTORIES.has(part))) continue;
        if (pathParts.length - 1 > this.limits.maxDepth) {
          depthLimitReached = true;
          continue;
        }
        const fullPath = resolve(root, repositoryPath);
        if (!fullPath.startsWith(`${root}${sep}`)) continue;
        try {
          const fileStat = await this.fileSystem.getLinkStats(fullPath);
          if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
        } catch {
          recordUnreadablePath(fullPath);
          continue;
        }
        let directory = dirname(fullPath);
        while (directory !== root && directory.startsWith(`${root}${sep}`)) {
          recordDirectory(directory);
          directory = dirname(directory);
        }
        recordFile(fullPath);
      }
    } else {
      if (git.isRepository) {
        warnings.push({
          code: "GIT_ENUMERATION_FAILED",
          message: "Could not enumerate Git files; ignore rules may not be applied.",
        });
      }
      await scan(root, 0);
    }
    if (limitReached) {
      warnings.push({
        code: "SCAN_LIMIT_REACHED",
        message: `Inspection stopped after ${this.limits.maxFiles} files.`,
      });
    }
    if (depthLimitReached) {
      warnings.push({
        code: "DEPTH_LIMIT_REACHED",
        message: `Inspection skipped content deeper than ${this.limits.maxDepth} directories.`,
      });
    }

    const languages: LanguageSummary[] = [...languageCounts]
      .map(([name, count]) => ({ name, fileCount: count }))
      .sort((left, right) => right.fileCount - left.fileCount || left.name.localeCompare(right.name));
    const frameworks = await this.frameworkDetector.detect(
      packageManifestPaths,
      frameworkConfigPaths,
      warnings,
    );

    return {
      schemaVersion: 1,
      root,
      repositoryName: basename(root),
      git,
      fileCount,
      languages,
      manifests: manifests.sort((left, right) => left.path.localeCompare(right.path)),
      frameworks: frameworks.map((framework) => ({
        ...framework,
        evidence: framework.evidence.map((path) => relative(root, path)),
      })),
      architecture: [...architecture.values()].sort((left, right) => left.path.localeCompare(right.path)),
      topLevelDirectories: [...topLevelDirectories].sort(),
      warnings,
    };
  }
}
