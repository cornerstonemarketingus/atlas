import { arch, availableParallelism, cpus, freemem, platform, release, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
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

/**
 * What this machine can give a local model.
 * - NVIDIA (nvidia-smi) and AMD (rocm-smi) GPUs: the largest card's memory.
 * - Apple Silicon: memory is unified, and macOS lets the GPU wire about three
 *   quarters of it by default, so that share is what a model can use.
 * - Otherwise the CPU runs the model from system memory.
 * `freeMemoryGiB` is reported so the UI can warn when other programs already
 * hold the memory a model would need.
 */
export async function detectHardware({ runCommandImpl = runCommand, diskPath = process.cwd(), os = { platform: platform(), arch: arch(), totalmem: totalmem(), freemem: freemem() } } = {}) {
  const cpuCount = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  const totalMemoryGiB = roundGiB(os.totalmem);
  const unifiedMemory = os.platform === "darwin" && os.arch === "arm64";
  let gpus = [];
  if (!unifiedMemory) {
    const nvidia = await runCommandImpl("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    gpus = nvidia.ok ? parseNvidia(nvidia.stdout) : [];
    if (!gpus.length) {
      const amd = await runCommandImpl("rocm-smi", ["--showmeminfo", "vram", "--showproductname", "--json"]);
      gpus = amd.ok ? parseRocm(amd.stdout) : [];
    }
  }
  const discreteMemory = gpus.reduce((largest, gpu) => Math.max(largest, gpu.memoryGiB), 0);
  let freeDiskGiB = null;
  try { const disk = await statfs(diskPath); freeDiskGiB = Math.floor(disk.bavail * disk.bsize / 1024 ** 3); } catch { /* unknown is not permission to install */ }
  return {
    platform: os.platform,
    arch: os.arch,
    osVersion: release(),
    cpuName: cpus()[0]?.model ?? "Unknown CPU",
    freeDiskGiB,
    cpuCount: Math.max(1, cpuCount),
    totalMemoryGiB,
    freeMemoryGiB: Math.max(0, Math.floor(os.freemem / 1024 ** 3 * 10) / 10),
    gpus,
    unifiedMemory,
    accelerator: discreteMemory ? gpus[0].vendor : unifiedMemory ? "apple" : "cpu",
    usableModelMemoryGiB: discreteMemory || (unifiedMemory ? Math.max(1, Math.round(totalMemoryGiB * 0.75)) : totalMemoryGiB),
  };
}

function parseNvidia(output) {
  return String(output).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(.*),\s*([\d.]+)\s*$/u);
    if (!match) return null;
    return { vendor: "nvidia", name: match[1].trim(), memoryGiB: Math.round(Number(match[2]) / 1024) };
  }).filter(Boolean);
}

/** rocm-smi --json: { card0: { "VRAM Total Memory (B)": "...", "Card series": "..." }, … } */
export function parseRocm(output) {
  let parsed;
  try { parsed = JSON.parse(String(output)); } catch { return []; }
  return Object.entries(parsed ?? {}).filter(([key]) => key.startsWith("card")).map(([, card]) => {
    const bytes = Number(card?.["VRAM Total Memory (B)"]);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return { vendor: "amd", name: String(card["Card series"] ?? card["Card model"] ?? "AMD GPU"), memoryGiB: Math.round(bytes / 1024 ** 3) };
  }).filter(Boolean);
}

function roundGiB(bytes) {
  return Math.max(1, Math.round(bytes / 1024 ** 3));
}
