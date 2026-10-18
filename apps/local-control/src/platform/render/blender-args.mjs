import {
  BLENDER_ENGINES, BLENDER_FORMATS, RENDER_WORKDIR, RenderPolicyError, blenderFramePath, normalizeWorkspacePath, validateRenderJob,
} from "./render-policy.mjs";

export const MAX_BLENDER_FRAMES = 1000;

/**
 * Builds a validated headless Blender render job:
 *
 *   blender -b <scene.blend> --disable-autoexec [-E engine] -o /workspace/<prefix> -F <format> [-t threads] -f <N>
 *   blender -b <scene.blend> --disable-autoexec ... -s <start> -e <end> -a
 *
 * Autoexec is always disabled (a .blend can embed Python that would otherwise
 * run on load). The declared outputs are the exact frame files Blender will
 * write, so the runner can hash them and refuse anything else.
 *
 * @param input.scene   workspace-relative .blend file
 * @param input.output  workspace-relative output prefix, e.g. "renders/shot_####"
 * @param input.frame   one frame number, or
 * @param input.frames  { start, end } (inclusive) for an animation range
 * @returns a job ready for RenderRunner.run (already validated)
 */
export function buildBlenderJob({ scene, output, frame, frames, engine, format = "PNG", threads, timeoutMs, maxOutputBytes, image } = {}) {
  const scenePath = normalizeWorkspacePath(scene, "scene");
  if (!scenePath.endsWith(".blend")) throw new RenderPolicyError("INVALID_JOB", "scene must be a .blend file.");
  const prefix = normalizeWorkspacePath(output, "output");
  if (!Object.hasOwn(BLENDER_FORMATS, format)) throw new RenderPolicyError("INVALID_JOB", `format must be one of ${Object.keys(BLENDER_FORMATS).join(", ")}.`);
  if (engine !== undefined && !BLENDER_ENGINES.includes(engine)) throw new RenderPolicyError("INVALID_JOB", `engine must be one of ${BLENDER_ENGINES.join(", ")}.`);
  if (threads !== undefined && !(Number.isInteger(threads) && threads >= 0 && threads <= 1024)) throw new RenderPolicyError("INVALID_JOB", "threads must be an integer between 0 and 1024.");

  const isFrame = (n) => Number.isInteger(n) && n >= 0 && n <= 1_048_574;
  let frameList;
  let renderArgs;
  if (frame !== undefined && frames !== undefined) throw new RenderPolicyError("INVALID_JOB", "Give frame or frames, not both.");
  if (frame !== undefined) {
    if (!isFrame(frame)) throw new RenderPolicyError("INVALID_JOB", "frame must be a non-negative integer.");
    frameList = [frame];
    renderArgs = ["-f", String(frame)];
  } else if (frames && typeof frames === "object") {
    const { start, end } = frames;
    if (!isFrame(start) || !isFrame(end) || end < start) throw new RenderPolicyError("INVALID_JOB", "frames must be { start, end } with 0 <= start <= end.");
    if (end - start + 1 > MAX_BLENDER_FRAMES) throw new RenderPolicyError("INVALID_JOB", `At most ${MAX_BLENDER_FRAMES} frames per job; split the range.`);
    frameList = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    renderArgs = ["-s", String(start), "-e", String(end), "-a"];
  } else {
    throw new RenderPolicyError("INVALID_JOB", "frame or frames is required.");
  }

  const args = ["-b", scenePath, "--disable-autoexec"];
  if (engine) args.push("-E", engine);
  args.push("-o", `${RENDER_WORKDIR}/${prefix}`, "-F", format);
  if (threads !== undefined) args.push("-t", String(threads));
  args.push(...renderArgs);

  const extension = BLENDER_FORMATS[format];
  const job = { tool: "blender", args, inputs: [scenePath], outputs: frameList.map((n) => blenderFramePath(prefix, n, extension)) };
  if (timeoutMs !== undefined) job.timeoutMs = timeoutMs;
  if (maxOutputBytes !== undefined) job.maxOutputBytes = maxOutputBytes;
  if (image !== undefined) job.image = image;
  return validateRenderJob(job);
}
