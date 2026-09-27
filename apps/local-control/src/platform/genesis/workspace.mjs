import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { commitConfig, git } from "../engineering/git.mjs";
import { getTemplate, templateFiles } from "./templates/index.mjs";

/**
 * A Genesis project lives in its own folder on this machine, with its own git
 * repository. No GitHub, no remote and no network are involved: publishing is
 * a later, optional step. The folder is created from a curated template and
 * the template's configuration is written from the specification, then
 * everything is committed so every later change (by the coder or a repair)
 * is a reviewable diff.
 *
 * Paths are confined: a project folder is always a direct child of the
 * Genesis projects root, and template files are only ever written inside it.
 */

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export function projectFolderName(name, projectId) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "project";
  const suffix = String(projectId).replace(/^gen_/u, "").replace(/[^a-z0-9]/giu, "").slice(0, 8).toLowerCase();
  return `${slug}-${suffix}`;
}

function inside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Creates the project folder from `templateId`, writes the configuration for
 * `spec`, initialises git on `main` and commits. Returns the folder, the
 * template and the initial commit, which Genesis records as evidence.
 */
export async function createWorkspace({ root, projectId, spec, templateId, now = () => new Date() }) {
  const template = getTemplate(templateId);
  mkdirSync(root, { recursive: true });
  const folder = join(root, projectFolderName(spec.name, projectId));
  if (!inside(root, folder)) throw new WorkspaceError("UNSAFE_PATH", "The project folder must be inside the Genesis projects folder.");
  if (existsSync(folder) && readdirSync(folder).length) throw new WorkspaceError("EXISTS", `${folder} already exists and is not empty.`);
  mkdirSync(folder, { recursive: true });

  const written = [];
  const write = (relativePath, content) => {
    const target = join(folder, relativePath);
    if (!inside(folder, target)) throw new WorkspaceError("UNSAFE_PATH", `Template file ${relativePath} would land outside the project.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(relativePath);
  };
  for (const { source, target } of templateFiles(templateId)) write(target, readFileSync(source));
  for (const [relativePath, content] of Object.entries(template.configure(spec))) write(relativePath, content);
  const specDigest = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
  write(".atlas/genesis.json", `${JSON.stringify({ projectId, template: template.id, templateVersion: template.version, specVersion: spec.version ?? 1, specDigest, createdAt: now().toISOString() }, null, 2)}\n`);

  await git(folder, ["init", "-q", "-b", "main"]);
  await git(folder, ["add", "-A"]);
  await git(folder, [...commitConfig(), "commit", "-q", "-m", `Create ${spec.name} from the ${template.id} template (v${template.version})`]);
  const commit = (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
  return { folder, template: { id: template.id, version: template.version }, commit, files: written.sort() };
}

/** Commits everything in the workspace (after a template task, the coder or a repair); returns the new commit or null when nothing changed. */
export async function commitWorkspace(folder, message) {
  await git(folder, ["add", "-A"]);
  const status = await git(folder, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return null;
  await git(folder, [...commitConfig(), "commit", "-q", "-m", String(message).slice(0, 200)]);
  return (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
}
