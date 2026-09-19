import { runCommand } from "../agent/tools/process.mjs";

/**
 * What the installer looks for, and deliberately does not install.
 *
 * Silently installing Node, Git, a browser or a model server on someone's
 * machine is the kind of thing an installer gets distrusted for — and on a
 * managed machine it is the kind of thing that gets the product banned. Atlas
 * reports what is present, what is missing, and where to get it. The operator
 * decides.
 */
export const REQUIREMENTS = [
  {
    id: "node",
    name: "Node.js 22 or newer",
    required: true,
    probe: ["node", ["--version"]],
    parse: (output) => output.trim().replace(/^v/u, ""),
    satisfied: (version) => Number.parseInt(version.split(".")[0], 10) >= 22,
    obtain: "https://nodejs.org/en/download",
    why: "Atlas runs on Node; the local control plane cannot start without it.",
  },
  {
    id: "git",
    name: "Git",
    required: true,
    probe: ["git", ["--version"]],
    parse: (output) => (/(\d+\.\d+\.\d+)/u.exec(output)?.[1] ?? "").trim(),
    satisfied: (version) => version.length > 0,
    obtain: "https://git-scm.com/download/win",
    why: "Coding sessions run in isolated Git worktrees.",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    required: false,
    probe: ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item (Get-Command msedge).Source).VersionInfo.ProductVersion"]],
    parse: (output) => output.trim(),
    satisfied: (version) => version.length > 0,
    obtain: "https://www.microsoft.com/edge",
    why: "The computer operator drives Edge. Without it, browser tasks are unavailable.",
  },
  {
    id: "ollama",
    name: "Ollama",
    required: false,
    probe: ["ollama", ["--version"]],
    parse: (output) => (/(\d+\.\d+\.\d+)/u.exec(output)?.[1] ?? output.trim()),
    satisfied: (version) => version.length > 0,
    obtain: "https://ollama.com/download",
    why: "Runs models on this machine. Without it, Atlas needs another OpenAI-compatible server.",
  },
];

export async function discoverDependencies({ requirements = REQUIREMENTS, runCommandImpl = runCommand } = {}) {
  const results = await Promise.all(requirements.map(async (requirement) => {
    const [command, args] = requirement.probe;
    const result = await runCommandImpl(command, args, { timeoutMs: 10_000 }).catch(() => null);
    if (!result?.ok) {
      return { id: requirement.id, name: requirement.name, required: requirement.required, present: false, version: null, satisfied: false, obtain: requirement.obtain, why: requirement.why };
    }
    const version = requirement.parse(`${result.stdout}${result.stderr}`);
    return {
      id: requirement.id,
      name: requirement.name,
      required: requirement.required,
      present: true,
      version,
      satisfied: requirement.satisfied(version),
      obtain: requirement.obtain,
      why: requirement.why,
    };
  }));

  const blocking = results.filter((result) => result.required && !result.satisfied);
  return {
    results,
    // Installation may proceed with optional pieces missing; the features that
    // need them simply report that they are unavailable.
    canInstall: blocking.length === 0,
    blocking,
    // Nothing here installs anything. Stated in the report so a reviewer of
    // the installer does not have to take it on trust.
    installsNothing: true,
  };
}

export function describeDependencies(report) {
  const lines = [];
  for (const result of report.results) {
    const status = result.satisfied
      ? `found ${result.version}`
      : result.present
        ? `found ${result.version}, which is too old`
        : "not found";
    lines.push(`${result.required ? "Required" : "Optional"}: ${result.name} — ${status}.`);
    if (!result.satisfied) lines.push(`  ${result.why}\n  Get it from ${result.obtain}. Atlas will not install it for you.`);
  }
  lines.push(report.canInstall
    ? "Atlas can be installed on this machine."
    : `Atlas cannot run until these are installed: ${report.blocking.map((entry) => entry.name).join(", ")}.`);
  return lines.join("\n");
}
