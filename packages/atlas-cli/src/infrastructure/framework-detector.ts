import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  FrameworkSummary,
  InspectionWarning,
} from "../domain/repository-summary.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

const DEPENDENCY_FRAMEWORKS: Readonly<Record<string, string>> = {
  "@angular/core": "Angular",
  "@nestjs/core": "NestJS",
  express: "Express",
  fastify: "Fastify",
  next: "Next.js",
  react: "React",
  svelte: "Svelte",
  vue: "Vue",
};

const CONFIG_FRAMEWORKS: Readonly<Record<string, string>> = {
  "angular.json": "Angular",
  "next.config.js": "Next.js",
  "next.config.mjs": "Next.js",
  "next.config.ts": "Next.js",
  "svelte.config.js": "Svelte",
  "svelte.config.ts": "Svelte",
  "vite.config.js": "Vite",
  "vite.config.mjs": "Vite",
  "vite.config.ts": "Vite",
};

interface PackageManifest {
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
}

function dependencyNames(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value);
}

export class FrameworkDetector {
  public async detect(
    manifestPaths: readonly string[],
    configPaths: readonly string[],
    warnings: InspectionWarning[],
  ): Promise<FrameworkSummary[]> {
    const evidence = new Map<string, Set<string>>();
    const record = (framework: string, path: string): void => {
      const paths = evidence.get(framework) ?? new Set<string>();
      paths.add(path);
      evidence.set(framework, paths);
    };

    for (const configPath of configPaths) {
      const framework = CONFIG_FRAMEWORKS[basename(configPath).toLowerCase()];
      if (framework !== undefined) record(framework, configPath);
    }

    for (const manifestPath of manifestPaths) {
      try {
        const manifestStat = await stat(manifestPath);
        if (manifestStat.size > MAX_MANIFEST_BYTES) {
          warnings.push({
            code: "MANIFEST_PARSE_FAILED",
            message: `Skipped oversized manifest: ${manifestPath}`,
          });
          continue;
        }
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
        const dependencies = [
          ...dependencyNames(manifest.dependencies),
          ...dependencyNames(manifest.devDependencies),
          ...dependencyNames(manifest.optionalDependencies),
          ...dependencyNames(manifest.peerDependencies),
        ];
        for (const dependency of dependencies) {
          const framework = DEPENDENCY_FRAMEWORKS[dependency];
          if (framework !== undefined) record(framework, manifestPath);
        }
      } catch {
        warnings.push({
          code: "MANIFEST_PARSE_FAILED",
          message: `Could not parse manifest: ${manifestPath}`,
        });
      }
    }

    return [...evidence]
      .map(([name, paths]) => ({ name, evidence: [...paths].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
