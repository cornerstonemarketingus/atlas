import { posix } from "node:path";
import { GitClient } from "./git-client.js";
import { RepositoryFileEnumerator } from "./repository-file-enumerator.js";
import { nodeRepositoryFileSystem, type RepositoryFileSystem } from "./repository-file-system.js";

/**
 * How a repository is built, checked and shipped (docs/PROGRAM.md 2.3:
 * CI/deploy targets; TODO.md: detect CI/CD workflows and deployment
 * targets).
 *
 * GitHub Actions workflows are read for their triggers, jobs and the steps
 * that deploy or publish somewhere; other CI systems and platform config
 * files (wrangler, Vercel, Netlify, Fly, Docker, ...) are recognized by
 * name. Every target carries the file, line and text that shows it, so
 * "this deploys to Cloudflare Workers on push to main" can be checked.
 * Lexical: nothing is executed or contacted.
 */

export interface DeliveryEvidence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface DeployStep {
  readonly target: string;
  readonly job: string | null;
  readonly evidence: DeliveryEvidence;
}

export interface WorkflowSummary {
  readonly file: string;
  readonly name: string | null;
  readonly triggers: readonly string[];
  /** Branches named under push/pull_request, when the workflow lists any. */
  readonly branches: readonly string[];
  readonly jobs: readonly { readonly id: string; readonly name: string | null; readonly line: number }[];
  readonly deploys: readonly DeployStep[];
}

export interface DeliveryMap {
  /** CI systems in use, with the file that shows each. */
  readonly ci: readonly { readonly system: string; readonly file: string }[];
  readonly workflows: readonly WorkflowSummary[];
  /** Every deployment or publishing target, from workflows and platform config files. */
  readonly targets: readonly { readonly target: string; readonly evidence: readonly DeliveryEvidence[] }[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const OTHER_CI: readonly (readonly [RegExp, string])[] = [
  [/^\.gitlab-ci\.ya?ml$/u, "GitLab CI"],
  [/^\.circleci\/config\.ya?ml$/u, "CircleCI"],
  [/^azure-pipelines\.ya?ml$/u, "Azure Pipelines"],
  [/^Jenkinsfile$/u, "Jenkins"],
  [/^\.travis\.ya?ml$/u, "Travis CI"],
  [/^bitbucket-pipelines\.ya?ml$/u, "Bitbucket Pipelines"],
  [/^\.buildkite\/pipeline\.ya?ml$/u, "Buildkite"],
];

/** Platform config files: their presence names a deployment target. */
const PLATFORM_FILES: readonly (readonly [RegExp, string])[] = [
  [/(?:^|\/)wrangler\.(?:toml|jsonc?)$/u, "Cloudflare Workers"],
  [/(?:^|\/)vercel\.json$/u, "Vercel"],
  [/(?:^|\/)netlify\.toml$/u, "Netlify"],
  [/(?:^|\/)fly\.toml$/u, "Fly.io"],
  [/(?:^|\/)render\.ya?ml$/u, "Render"],
  [/(?:^|\/)railway\.(?:json|toml)$/u, "Railway"],
  [/(?:^|\/)Procfile$/u, "Heroku (Procfile)"],
  [/(?:^|\/)app\.ya?ml$/u, "Google App Engine"],
  [/(?:^|\/)serverless\.ya?ml$/u, "Serverless Framework"],
  [/(?:^|\/)(?:Dockerfile|[\w.-]+\.Dockerfile|Dockerfile\.[\w.-]+)$/u, "Container image (Dockerfile)"],
  [/(?:^|\/)(?:docker-)?compose\.ya?ml$|(?:^|\/)docker-compose\.[\w-]+\.ya?ml$/u, "Docker Compose"],
  [/(?:^|\/)Chart\.yaml$/u, "Kubernetes (Helm chart)"],
  [/(?:^|\/)firebase\.json$/u, "Firebase"],
  [/(?:^|\/)capacitor\.config\.(?:ts|json)$/u, "Mobile app (Capacitor)"],
];

/** Deploy/publish commands and actions inside workflow steps. */
const DEPLOY_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bwrangler(?:@[\w.^~-]+)?\s+(?:deploy|publish|pages\s+deploy|versions\s+upload)\b|cloudflare\/wrangler-action@/u, "Cloudflare Workers"],
  [/\bvercel(?:@[\w.^~-]+)?\s+(?:deploy|--prod)\b|amondnet\/vercel-action@/u, "Vercel"],
  [/\bnetlify\s+deploy\b|nwtgck\/actions-netlify@/u, "Netlify"],
  [/\bflyctl\s+deploy\b|\bfly\s+deploy\b/u, "Fly.io"],
  [/\bdocker\s+push\b|\bdocker\s+buildx\s+build\b.*--push\b/u, "Container registry"],
  [/docker\/build-push-action@/u, "Container registry (if push: true)"],
  [/\b(?:npm|pnpm|yarn(?:\s+npm)?|bun)\s+publish\b|changesets\/action@/u, "npm registry"],
  [/\btwine\s+upload\b|pypa\/gh-action-pypi-publish@|\buv\s+publish\b|\bpoetry\s+publish\b/u, "PyPI"],
  [/actions\/deploy-pages@|peaceiris\/actions-gh-pages@|JamesIves\/github-pages-deploy-action@/u, "GitHub Pages"],
  [/softprops\/action-gh-release@|\bgh\s+release\s+(?:create|upload)\b|actions\/create-release@/u, "GitHub Releases"],
  [/\baws\s+s3\s+(?:sync|cp)\b|aws-actions\/amazon-ecs-deploy|\bsam\s+deploy\b|\bcdk\s+deploy\b|\bserverless\s+deploy\b|\bsls\s+deploy\b/u, "AWS"],
  [/\bgcloud\s+(?:app|run|functions)\s+deploy\b|google-github-actions\/deploy-/u, "Google Cloud"],
  [/\baz\s+(?:webapp|functionapp)\s+deploy\b|azure\/webapps-deploy@/u, "Azure"],
  [/\bgit\s+push\s+heroku\b|akhileshns\/heroku-deploy@/u, "Heroku"],
  [/\bkubectl\s+(?:apply|rollout)\b|\bhelm\s+(?:upgrade|install)\b/u, "Kubernetes"],
  [/\bterraform\s+apply\b/u, "Terraform"],
  [/\bwrangler\s+d1\s+(?:migrations\s+apply\b(?!.*--local)|execute\b.*--remote\b)/u, "Cloudflare D1 (remote database changes)"],
];

const DEFAULTS = { maxFiles: 20_000, maxDepth: 25, maxFileBytes: 512 * 1024 };

export class RepositoryDeliveryMap {
  public constructor(
    private readonly gitClient: GitClient = new GitClient(),
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async build(repositoryPath: string, options: Partial<typeof DEFAULTS> = {}): Promise<DeliveryMap> {
    const limits = { ...DEFAULTS, ...options };
    const enumeration = await new RepositoryFileEnumerator(this.gitClient, this.fileSystem).enumerate(repositoryPath, {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth,
      include: (path) => relevant(path.replaceAll("\\", "/")),
    });
    const warnings: { code: string; message: string }[] = [...enumeration.warnings];
    const ci: { system: string; file: string }[] = [];
    const workflows: WorkflowSummary[] = [];
    const targets = new Map<string, DeliveryEvidence[]>();
    const addTarget = (target: string, evidence: DeliveryEvidence) => targets.set(target, [...(targets.get(target) ?? []), evidence]);
    for (const file of [...enumeration.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      const path = file.relativePath.replaceAll("\\", "/");
      if (isWorkflow(path)) {
        if (file.size > limits.maxFileBytes) {
          warnings.push({ code: "FILE_TOO_LARGE", message: `Skipped ${path}: larger than ${limits.maxFileBytes} bytes.` });
          continue;
        }
        let text: string;
        try {
          text = (await this.fileSystem.readFile(file.absolutePath)).toString("utf8");
        } catch {
          warnings.push({ code: "PATH_UNREADABLE", message: `Could not read repository path: ${path}` });
          continue;
        }
        if (!ci.some((item) => item.system === "GitHub Actions")) ci.push({ system: "GitHub Actions", file: path });
        const workflow = summarizeWorkflow(path, text);
        workflows.push(workflow);
        for (const step of workflow.deploys) addTarget(step.target, step.evidence);
        continue;
      }
      const other = OTHER_CI.find(([pattern]) => pattern.test(path));
      if (other) ci.push({ system: other[1], file: path });
      const platform = PLATFORM_FILES.find(([pattern]) => pattern.test(path));
      if (platform) addTarget(platform[1], { file: path, line: 1, text: posix.basename(path) });
    }
    if (enumeration.limitReached) warnings.push({ code: "FILE_LIMIT_REACHED", message: `Search stopped after ${limits.maxFiles} files.` });
    return {
      ci,
      workflows,
      targets: [...targets.entries()].map(([target, evidence]) => ({ target, evidence })).sort((a, b) => a.target.localeCompare(b.target)),
      warnings,
    };
  }
}

function isWorkflow(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path);
}

function relevant(path: string): boolean {
  return isWorkflow(path) || OTHER_CI.some(([pattern]) => pattern.test(path)) || PLATFORM_FILES.some(([pattern]) => pattern.test(path));
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const unquote = (value: string) => value.trim().replace(/^["']|["']$/gu, "");
const meaningful = (line: string) => !/^\s*(?:#.*)?$/u.test(line);

/**
 * Triggers, branches, jobs and deploy steps of one workflow, by indentation
 * (no YAML library: workflows are regular enough, and anything unrecognized
 * is simply not reported).
 */
export function summarizeWorkflow(file: string, text: string): WorkflowSummary {
  const lines = text.split(/\r?\n/u);
  const name = lines.map((line) => /^name:\s*(.+?)\s*(?:#.*)?$/u.exec(line)?.[1]).find(Boolean);
  const triggers: string[] = [];
  const branches: string[] = [];
  const onIndex = lines.findIndex((line) => /^(?:on|"on"|'on'|true):/u.test(line));
  if (onIndex !== -1) {
    const inline = /^[^:]+:\s*(.+?)\s*(?:#.*)?$/u.exec(lines[onIndex]!)?.[1];
    if (inline) {
      triggers.push(...inline.replace(/^\[|\]$/gu, "").split(",").map(unquote).filter(Boolean));
    } else {
      let triggerIndent = -1;
      let current: string | null = null;
      for (let index = onIndex + 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!meaningful(line)) continue;
        const indent = indentOf(line);
        if (indent === 0) break;
        if (triggerIndent === -1) triggerIndent = indent;
        if (indent === triggerIndent) {
          const key = /^\s*-?\s*([\w-]+)\s*:?/u.exec(line)?.[1];
          if (key) { triggers.push(key); current = key; }
          continue;
        }
        if ((current === "push" || current === "pull_request" || current === "pull_request_target") && /^\s*branches\s*:/u.test(line)) {
          const flow = /branches\s*:\s*\[(.*)\]/u.exec(line)?.[1];
          if (flow) branches.push(...flow.split(",").map(unquote).filter(Boolean));
          else {
            for (let next = index + 1; next < lines.length && (indentOf(lines[next]!) > indent || !meaningful(lines[next]!)); next += 1) {
              const item = /^\s*-\s*(.+?)\s*(?:#.*)?$/u.exec(lines[next]!)?.[1];
              if (item) branches.push(unquote(item));
            }
          }
        }
      }
    }
  }
  const jobs: { id: string; name: string | null; line: number }[] = [];
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsIndex !== -1) {
    let jobIndent = -1;
    for (let index = jobsIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!meaningful(line)) continue;
      const indent = indentOf(line);
      if (indent === 0) break;
      if (jobIndent === -1) jobIndent = indent;
      if (indent === jobIndent) {
        const id = /^\s*([\w-]+)\s*:/u.exec(line)?.[1];
        if (id) jobs.push({ id, name: null, line: index + 1 });
      } else if (indent === jobIndent + 2 && jobs.length > 0 && jobs.at(-1)!.name === null) {
        const jobName = /^\s*name:\s*(.+?)\s*(?:#.*)?$/u.exec(line)?.[1];
        if (jobName) jobs[jobs.length - 1] = { ...jobs.at(-1)!, name: unquote(jobName) };
      }
    }
  }
  const deploys: DeployStep[] = [];
  lines.forEach((line, index) => {
    if (/^\s*#/u.test(line)) return;
    for (const [pattern, target] of DEPLOY_PATTERNS) {
      if (!pattern.test(line)) continue;
      const job = [...jobs].reverse().find((item) => item.line <= index + 1)?.id ?? null;
      deploys.push({ target, job, evidence: { file, line: index + 1, text: line.trim().slice(0, 200) } });
    }
  });
  return { file, name: name ? unquote(name) : null, triggers: [...new Set(triggers)], branches: [...new Set(branches)], jobs, deploys };
}
