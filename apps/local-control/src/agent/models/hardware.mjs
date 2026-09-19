import { availableParallelism, cpus, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 3_000, windowsHide: true });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

export async function detectHardware({ runCommandImpl = runCommand } = {}) {
  const cpuCount = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  const totalMemoryGiB = roundGiB(totalmem());
  const result = await runCommandImpl("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  const gpus = result.ok ? parseNvidia(result.stdout) : [];
  const discreteMemory = gpus.reduce((largest, gpu) => Math.max(largest, gpu.memoryGiB), 0);
  return {
    cpuCount: Math.max(1, cpuCount),
    totalMemoryGiB,
    gpus,
    usableModelMemoryGiB: discreteMemory || totalMemoryGiB,
  };
}

function parseNvidia(output) {
  return String(output).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(.*),\s*([\d.]+)\s*$/u);
    if (!match) return null;
    return { vendor: "nvidia", name: match[1].trim(), memoryGiB: Math.round(Number(match[2]) / 1024) };
  }).filter(Boolean);
}

function roundGiB(bytes) {
  return Math.max(1, Math.round(bytes / 1024 ** 3));
}
