/**
 * What a job needs from a GPU, decided before anything is rented.
 *
 * A job is { id, kind, vramGb?, modelParamsB?, precisionBytes?, estMinutes?,
 * maxMinutes? }. Kinds that need a GPU get a VRAM floor; an explicit
 * `vramGb` always wins. When the local machine (agent/models/hardware.mjs
 * `detectHardware()`) already has a GPU with enough memory, the job runs
 * locally and nothing is rented.
 */

export const GPU_JOB_KINDS = Object.freeze({
  render: { minVramGb: 12 },
  inference: { minVramGb: 8 },
  training: { minVramGb: 24 },
  transcode: { minVramGb: 0, gpuOptional: true },
});

export class ComputeRequirementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComputeRequirementError";
    this.code = code;
  }
}

/** Approximate VRAM for running a model: weights plus ~20% for activations and cache. */
export function inferenceVramGb(modelParamsB, precisionBytes = 2) {
  return Math.ceil(modelParamsB * precisionBytes * 1.2);
}

export function detectRequirements(job, { localHardware = null } = {}) {
  if (!job || typeof job !== "object") throw new ComputeRequirementError("INVALID_JOB", "A compute job must be an object.");
  if (typeof job.id !== "string" || !job.id) throw new ComputeRequirementError("INVALID_JOB", "A compute job needs an id.");
  const profile = GPU_JOB_KINDS[job.kind];
  if (!profile) throw new ComputeRequirementError("UNKNOWN_JOB_KIND", `Unknown compute job kind '${job.kind}'.`);
  let minVramGb = profile.minVramGb;
  if (job.kind === "inference" && Number.isFinite(job.modelParamsB) && job.modelParamsB > 0) {
    minVramGb = Math.max(minVramGb, inferenceVramGb(job.modelParamsB, job.precisionBytes ?? 2));
  }
  if (job.vramGb !== undefined) {
    if (!Number.isFinite(job.vramGb) || job.vramGb < 0) throw new ComputeRequirementError("INVALID_JOB", "vramGb must be a non-negative number.");
    minVramGb = job.vramGb;
  }
  const estMinutes = job.estMinutes ?? 10;
  if (!Number.isFinite(estMinutes) || estMinutes <= 0) throw new ComputeRequirementError("INVALID_JOB", "estMinutes must be positive.");
  if (job.maxMinutes !== undefined && (!Number.isFinite(job.maxMinutes) || job.maxMinutes <= 0)) throw new ComputeRequirementError("INVALID_JOB", "maxMinutes must be positive.");
  const needsGpu = !(profile.gpuOptional && minVramGb === 0);
  const localVram = (localHardware?.gpus ?? []).reduce((largest, gpu) => Math.max(largest, gpu.memoryGiB ?? 0), 0);
  const runLocally = !needsGpu || (localVram > 0 && localVram >= minVramGb);
  return { jobId: job.id, kind: job.kind, needsGpu, minVramGb, estMinutes, maxMinutes: job.maxMinutes ?? null, runLocally };
}
