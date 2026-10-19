import { posix } from "node:path";

/**
 * Render job validation (issue #352): the pure half of the render capability.
 *
 * A render job names a tool (ffmpeg or Blender), an argv with no shell, the
 * workspace files it reads and the workspace files it may produce. Nothing
 * here touches the filesystem or a process, so every rule is testable on its
 * own. The runner (render-runner.mjs) executes a validated job only inside
 * the container sandbox, against a staging copy that holds nothing but the
 * declared inputs; these checks are the first of two layers, not the only one.
 *
 * Rules, in short:
 * - argv is an array of plain strings: no NUL or control characters, bounded
 *   in count and length. It is passed to the runtime as argv, never a shell.
 * - No network: any URL, `scheme:` prefix or ffmpeg protocol name (http, tcp,
 *   rtmp, concat, subfile, data, pipe, file, ...) anywhere in any token is
 *   refused, as are options that change which protocols are allowed.
 * - Paths: workspace-relative or under /workspace; `..` segments and other
 *   absolute paths are refused anywhere in a token, including inside filter
 *   graphs. Declared inputs and outputs must be workspace-relative, normal,
 *   and distinct.
 * - ffmpeg: every `-i` names a declared input (or, after `-f lavfi`, a
 *   generated source graph); every positional argument is a declared output,
 *   and every declared output appears. Options that read or write files the
 *   job did not declare (`-/opt`, `-filter_script`, `-passlogfile`,
 *   `-dump_attachment`, presets, ...) and filters that open files, sockets or
 *   plugins (`movie`, `sendcmd`, `zmq`, `frei0r`, `ladspa`, ...) are refused.
 * - Blender: an allowlist. `-b <scene>` first, autoexec always disabled, and
 *   only the render options the argv builder emits.
 */

export class RenderPolicyError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RenderPolicyError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const RENDER_TOOLS = Object.freeze(["ffmpeg", "blender"]);
export const RENDER_WORKDIR = "/workspace";

export const RENDER_LIMITS = Object.freeze({
  maxArgs: 512,
  maxArgLength: 8192,
  maxPaths: 1000,
  maxPathLength: 1024,
  defaultTimeoutMs: 10 * 60_000,
  maxTimeoutMs: 6 * 60 * 60_000,
  defaultMaxOutputBytes: 2 * 1024 ** 3,
  maxMaxOutputBytes: 200 * 1024 ** 3,
});

// Same grammar the container sandbox accepts for images.
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f]/u;

/**
 * ffmpeg protocols (`ffmpeg -protocols`) plus generic URL schemes. A token
 * containing `<name>:` (or the filter-escaped `<name>\:`) after a non-word
 * character is refused wherever it appears.
 */
const NETWORK_OR_INDIRECT_PROTOCOLS = [
  "async", "bluray", "cache", "concat", "concatf", "crypto", "data", "dtls", "fd", "ffrtmpcrypt", "ffrtmphttp", "file",
  "ftp", "ftps", "gopher", "gophers", "hls", "http", "httpproxy", "https", "icecast", "ipfs", "ipns", "librist", "librtmp",
  "librtmpe", "librtmps", "librtmpt", "librtmpte", "libsmbclient", "libsrt", "libssh", "libzmq", "md5", "mmsh", "mmst",
  "pipe", "prompeg", "rist", "rtmp", "rtmpe", "rtmps", "rtmpt", "rtmpte", "rtmpts", "rtp", "rtsp", "rtsps", "sctp", "sftp",
  "smb", "srt", "srtp", "subfile", "tcp", "tee", "tls", "udp", "udplite", "unix", "ws", "wss", "zmq", "mailto", "ssh",
  "javascript", "s3", "gs", "dav", "webdav", "nfs", "sap",
];
const PROTOCOL_PATTERN = new RegExp(`(?:^|[^a-z0-9_])(?:${NETWORK_OR_INDIRECT_PROTOCOLS.join("|")})\\\\?:`, "iu");
/** A leading `scheme:` the way ffmpeg's URL parser would read it (two or more letters, so `C:` is caught by the path rule). */
const LEADING_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+\\?:/iu;
const ABSOLUTE_PATH_IN_TOKEN = /(?<pre>^|[=:,;'"\s[|(])(?<abs>\/|\\|[a-z]:[\\/])/giu;
const DOTDOT_IN_TOKEN = /(?:^|[/\\=:,;'"\s[|(])\.\.(?:[/\\]|$|[,;:'"\s\]|)])/u;

/** ffmpeg options that read or write a file the job did not declare, or change the protocol rules. */
const FFMPEG_REFUSED_OPTIONS = new Set([
  "-protocol_whitelist", "-protocol_blacklist", "-filter_script", "-filter_complex_script", "-passlogfile", "-pass",
  "-dump_attachment", "-attach", "-vstats", "-vstats_file", "-sdp_file", "-progress", "-report", "-fpre", "-pre", "-vpre",
  "-apre", "-spre", "-stats_enc_pre", "-stats_enc_post", "-stats_mux_pre", "-stats_enc_pre_fmt", "-stats_enc_post_fmt",
  "-stats_mux_pre_fmt", "-init_hw_device", "-filter_hw_device", "-hwaccel_device", "-loglevel_file", "-cookies", "-headers",
  "-user_agent", "-method", "-listen", "-reconnect", "-http_proxy", "-dumpgraph", "-print_graphs_file", "-max_error_rate",
]);
/** Formats that are devices, network transports or fan-out muxers: none belong in a sandboxed render. */
const FFMPEG_REFUSED_FORMATS = new Set([
  "tee", "fifo", "fifo_test", "rtp", "rtp_mpegts", "rtsp", "sap", "rtmp", "flv_rtmp", "srt", "rist", "sdl", "sdl2", "opengl",
  "alsa", "pulse", "oss", "jack", "openal", "sndio", "v4l2", "video4linux2", "x11grab", "fbdev", "xv", "kmsgrab", "decklink",
  "libcdio", "dshow", "gdigrab", "vfwcap", "avfoundation", "android_camera", "lavfi_device", "caca", "audiotoolbox", "iec61883",
  "dv1394", "bktr", "libdc1394", "ladspa", "pipe", "concat", "hls", "dash", "smoothstreaming", "segment", "stream_segment", "ssegment",
]);
/** Filters that open files, sockets or plugins on their own. */
const FFMPEG_REFUSED_FILTERS = ["movie", "amovie", "sendcmd", "asendcmd", "zmq", "azmq", "frei0r", "frei0r_src", "ladspa", "lv2", "lut3d", "lut1d", "haldclutsrc", "subtitles", "ass", "ocr", "dnn_processing", "dnn_classify", "dnn_detect", "sr", "derain","vidstabdetect", "vidstabtransform", "libvmaf", "whisper"];
const FILTER_PATTERN = new RegExp(`(?:^|[^a-z0-9_])(?:${FFMPEG_REFUSED_FILTERS.join("|")})(?:@[a-z0-9_]+)?(?:=|$|[,;\\[\\]\\s'"])`, "iu");
/** Filter options that name a file (drawtext fontfile/textfile, etc.). */
const FILE_FILTER_OPTION = /(?:^|[^a-z0-9_])(?:fontfile|textfile|filename|file|stats_file|log_fn|model|psnr_stats|ssim_stats)\s*=/iu;
const FILTERGRAPH_OPTIONS = new Set(["-vf", "-af", "-filter", "-filter_complex", "-lavfi"]);

/** ffmpeg options that take no value. Everything else that starts with '-' consumes the next token. */
const FFMPEG_FLAGS = new Set([
  "-y", "-n", "-nostdin", "-stdin", "-hide_banner", "-nostats", "-stats", "-an", "-vn", "-sn", "-dn", "-shortest", "-copyts",
  "-start_at_zero", "-re", "-benchmark", "-benchmark_all", "-ignore_unknown", "-accurate_seek", "-noaccurate_seek",
  "-autorotate", "-noautorotate", "-autoscale", "-noautoscale", "-xerror", "-copyinkf", "-nocopyinkf", "-debug_ts",
  "-intra", "-reinit_filter", "-noreinit_filter", "-seek_timestamp", "-dump", "-hex", "-qphist", "-bitexact", "-fix_sub_duration",
  "-copypriorss", "-print_graphs", "-ignore_chapters",
]);

/**
 * Normalizes one declared workspace path. Accepts "a/b.mp4" or
 * "/workspace/a/b.mp4" and returns the workspace-relative form.
 */
export function normalizeWorkspacePath(value, field = "path") {
  if (typeof value !== "string" || value.length === 0 || value.length > RENDER_LIMITS.maxPathLength) {
    throw new RenderPolicyError("INVALID_PATH", `${field} must be a non-empty string of at most ${RENDER_LIMITS.maxPathLength} characters.`);
  }
  if (CONTROL_CHARACTERS.test(value) || value.includes("\t") || value.includes("\\") || value.includes(",")) {
    throw new RenderPolicyError("INVALID_PATH", `${field} '${printable(value)}' contains a control character, backslash or comma.`);
  }
  if (LEADING_SCHEME_PATTERN.test(value) || value.includes("://") || PROTOCOL_PATTERN.test(value)) {
    throw new RenderPolicyError("NETWORK_REFUSED", `${field} '${printable(value)}' is a URL or protocol; renders have no network.`);
  }
  let rel = value;
  if (value.startsWith("/")) {
    if (value !== RENDER_WORKDIR && !value.startsWith(`${RENDER_WORKDIR}/`)) {
      throw new RenderPolicyError("PATH_OUTSIDE_WORKSPACE", `${field} '${printable(value)}' is outside ${RENDER_WORKDIR}.`);
    }
    rel = value.slice(RENDER_WORKDIR.length + 1);
  }
  const segments = rel.split("/");
  if (rel === "" || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new RenderPolicyError("PATH_TRAVERSAL", `${field} '${printable(value)}' must be a normal workspace-relative file path (no '.', '..' or empty segments).`);
  }
  if (segments[0] === ".atlas-render" || segments[0] === ".tmp") {
    throw new RenderPolicyError("INVALID_PATH", `${field} '${printable(value)}' uses a reserved directory.`);
  }
  return posix.normalize(rel);
}

function printable(value) {
  return String(value).replace(CONTROL_CHARACTERS, "?").slice(0, 200);
}

/** Checks applied to every token of every tool: shape, network, paths. */
export function assertSafeToken(token, index) {
  if (typeof token !== "string") throw new RenderPolicyError("INVALID_ARGV", `args[${index}] must be a string.`);
  if (token.length > RENDER_LIMITS.maxArgLength) throw new RenderPolicyError("INVALID_ARGV", `args[${index}] is longer than ${RENDER_LIMITS.maxArgLength} characters.`);
  if (CONTROL_CHARACTERS.test(token)) throw new RenderPolicyError("INVALID_ARGV", `args[${index}] contains a control character.`);
  if (token.includes("://") || LEADING_SCHEME_PATTERN.test(token) || PROTOCOL_PATTERN.test(token)) {
    throw new RenderPolicyError("NETWORK_REFUSED", `args[${index}] '${printable(token)}' names a URL or protocol; renders have no network.`);
  }
  if (DOTDOT_IN_TOKEN.test(token)) {
    throw new RenderPolicyError("PATH_TRAVERSAL", `args[${index}] '${printable(token)}' contains a '..' path segment.`);
  }
  // Absolute paths are allowed only under /workspace; check every occurrence.
  for (const match of token.matchAll(ABSOLUTE_PATH_IN_TOKEN)) {
    const rest = token.slice(match.index + match.groups.pre.length);
    const underWorkspace = match.groups.abs === "/" && (rest === RENDER_WORKDIR || rest.startsWith(`${RENDER_WORKDIR}/`));
    if (!underWorkspace) {
      throw new RenderPolicyError("PATH_OUTSIDE_WORKSPACE", `args[${index}] '${printable(token)}' names an absolute path outside ${RENDER_WORKDIR}.`);
    }
  }
}

function asWorkspacePathToken(token) {
  return token.startsWith(`${RENDER_WORKDIR}/`) ? token.slice(RENDER_WORKDIR.length + 1) : posix.normalize(token);
}

function validateArgvShape(args) {
  if (!Array.isArray(args) || args.length === 0) throw new RenderPolicyError("INVALID_ARGV", "args must be a non-empty array of strings.");
  if (args.length > RENDER_LIMITS.maxArgs) throw new RenderPolicyError("INVALID_ARGV", `args may hold at most ${RENDER_LIMITS.maxArgs} entries.`);
  args.forEach((token, index) => assertSafeToken(token, index));
}

function checkFiltergraph(value, index) {
  if (FILTER_PATTERN.test(value)) {
    throw new RenderPolicyError("FILTER_REFUSED", `args[${index}] uses a filter that opens files, sockets or plugins on its own.`);
  }
  if (FILE_FILTER_OPTION.test(value)) {
    throw new RenderPolicyError("FILTER_REFUSED", `args[${index}] passes a file to a filter; declare it as an input instead.`);
  }
}

/**
 * Validates ffmpeg arguments (without the program name) against the declared
 * inputs and outputs. Returns { inputsUsed, outputsUsed }.
 */
export function validateFfmpegArgs(args, { inputs, outputs }) {
  validateArgvShape(args);
  const inputSet = new Set(inputs);
  const outputSet = new Set(outputs);
  const inputsUsed = new Set();
  const outputsUsed = new Set();
  let pendingFormat = null;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith("-/")) throw new RenderPolicyError("OPTION_REFUSED", `args[${i}] '${token}' reads an option value from a file.`);
    if (token.startsWith("-") && token !== "-" && !/^-\d/u.test(token)) {
      const name = token.split(":")[0];
      if (FFMPEG_REFUSED_OPTIONS.has(name)) throw new RenderPolicyError("OPTION_REFUSED", `args[${i}] '${token}' is not allowed in a render job.`);
      if (FFMPEG_FLAGS.has(name)) continue;
      const value = args[i + 1];
      if (value === undefined) throw new RenderPolicyError("INVALID_ARGV", `args[${i}] '${token}' needs a value.`);
      i += 1;
      if (name === "-f") {
        if (FFMPEG_REFUSED_FORMATS.has(value.toLowerCase())) throw new RenderPolicyError("FORMAT_REFUSED", `Format '${value}' is a device, network transport or fan-out muxer.`);
        pendingFormat = value.toLowerCase();
        continue;
      }
      if (name === "-i") {
        if (pendingFormat === "lavfi") {
          checkFiltergraph(value, i);
        } else {
          if (value === "-" ) throw new RenderPolicyError("INPUT_UNDECLARED", "stdin is not an input; declare a workspace file.");
          const rel = asWorkspacePathToken(value);
          if (!inputSet.has(rel)) throw new RenderPolicyError("INPUT_UNDECLARED", `args[${i}] input '${printable(value)}' is not a declared input.`);
          inputsUsed.add(rel);
        }
        pendingFormat = null;
        continue;
      }
      if (FILTERGRAPH_OPTIONS.has(name) || name.startsWith("-filter")) checkFiltergraph(value, i);
      continue;
    }
    // Positional: an output file.
    if (pendingFormat === "lavfi") throw new RenderPolicyError("FORMAT_REFUSED", "lavfi is an input format only.");
    pendingFormat = null;
    if (token === "-") throw new RenderPolicyError("OUTPUT_UNDECLARED", "stdout is not an output; declare a workspace file.");
    const rel = asWorkspacePathToken(token);
    if (!outputSet.has(rel)) throw new RenderPolicyError("OUTPUT_UNDECLARED", `args[${i}] '${printable(token)}' is written but not a declared output.`);
    outputsUsed.add(rel);
  }
  const missing = outputs.filter((o) => !outputsUsed.has(o));
  if (missing.length) throw new RenderPolicyError("OUTPUT_NOT_IN_ARGV", `Declared outputs not written by args: ${missing.join(", ")}.`);
  return { inputsUsed: [...inputsUsed], outputsUsed: [...outputsUsed] };
}

/** Blender options a render job may use, and whether each takes a value. */
const BLENDER_OPTIONS = new Map([
  ["-E", 1], ["--engine", 1], ["-o", 1], ["--render-output", 1], ["-F", 1], ["--render-format", 1], ["-x", 1], ["--use-extension", 1],
  ["-f", 1], ["--render-frame", 1], ["-s", 1], ["--frame-start", 1], ["-e", 1], ["--frame-end", 1], ["-j", 1], ["--frame-jump", 1],
  ["-a", 0], ["--render-anim", 0], ["-t", 1], ["--threads", 1], ["-Y", 0], ["--disable-autoexec", 0], ["--factory-startup", 0],
  ["-noaudio", 0], ["--log-level", 1],
]);
export const BLENDER_ENGINES = Object.freeze(["CYCLES", "BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"]);
export const BLENDER_FORMATS = Object.freeze({ PNG: "png", JPEG: "jpg", OPEN_EXR: "exr", TIFF: "tif", BMP: "bmp", WEBP: "webp" });

/**
 * The file Blender writes for one frame: a run of '#' becomes the zero-padded
 * frame number (four digits appended when there is none), then the extension.
 */
export function blenderFramePath(prefix, frame, extension) {
  const padded = (width) => String(frame).padStart(width, "0");
  const name = /#+/u.test(prefix) ? prefix.replace(/#+/u, (run) => padded(run.length)) : `${prefix}${padded(4)}`;
  return `${name}.${extension}`;
}

function blenderOutputPattern(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const body = /#+/u.test(prefix) ? escaped.replace(/#+/u, "\\d+") : `${escaped}\\d{4,}`;
  return new RegExp(`^${body}\\.[a-z0-9]+$`, "u");
}

/** Validates Blender arguments (without the program name). */
export function validateBlenderArgs(args, { inputs, outputs }) {
  validateArgvShape(args);
  if (args[0] !== "-b" && args[0] !== "--background") throw new RenderPolicyError("INVALID_ARGV", "Blender must run headless: args must start with -b <scene.blend>.");
  const scene = args[1];
  if (typeof scene !== "string" || scene.startsWith("-")) throw new RenderPolicyError("INVALID_ARGV", "args[1] must be the .blend scene.");
  const sceneRel = asWorkspacePathToken(scene);
  if (!sceneRel.endsWith(".blend") || !inputs.includes(sceneRel)) throw new RenderPolicyError("INPUT_UNDECLARED", `Scene '${printable(scene)}' must be a declared .blend input.`);
  let autoexecDisabled = false;
  let renders = false;
  let outputPrefix = null;
  for (let i = 2; i < args.length; i += 1) {
    const token = args[i];
    if (!BLENDER_OPTIONS.has(token)) throw new RenderPolicyError("OPTION_REFUSED", `args[${i}] '${printable(token)}' is not an allowed Blender render option.`);
    if (token === "-Y" || token === "--disable-autoexec") autoexecDisabled = true;
    if (["-f", "--render-frame", "-a", "--render-anim"].includes(token)) {
      if (!autoexecDisabled) throw new RenderPolicyError("AUTOEXEC_REQUIRED", "--disable-autoexec must come before the render starts.");
      if (outputPrefix === null) throw new RenderPolicyError("OUTPUT_UNDECLARED", "-o <output prefix> must come before the render starts.");
      renders = true;
    }
    if (BLENDER_OPTIONS.get(token) === 1) {
      const value = args[i + 1];
      if (value === undefined) throw new RenderPolicyError("INVALID_ARGV", `args[${i}] '${token}' needs a value.`);
      i += 1;
      if ((token === "-o" || token === "--render-output")) {
        if (value.startsWith("//")) throw new RenderPolicyError("INVALID_ARGV", "Use a /workspace/... render output, not a blend-relative '//' path.");
        outputPrefix = normalizeWorkspacePath(value, "render output");
        const pattern = blenderOutputPattern(outputPrefix);
        const stray = outputs.filter((o) => !pattern.test(o));
        if (stray.length) throw new RenderPolicyError("OUTPUT_UNDECLARED", `Declared outputs ${stray.join(", ")} do not match render output '${printable(value)}'.`);
      }
      if ((token === "-E" || token === "--engine") && !BLENDER_ENGINES.includes(value)) throw new RenderPolicyError("INVALID_ARGV", `Unknown engine '${printable(value)}'.`);
      if ((token === "-F" || token === "--render-format") && !Object.hasOwn(BLENDER_FORMATS, value)) throw new RenderPolicyError("INVALID_ARGV", `Unknown format '${printable(value)}'.`);
    }
  }
  if (!autoexecDisabled) throw new RenderPolicyError("AUTOEXEC_REQUIRED", "Blender jobs must pass --disable-autoexec: scenes may embed scripts.");
  if (!renders) throw new RenderPolicyError("INVALID_ARGV", "Blender args render nothing (no -f or -a).");
  return { inputsUsed: [sceneRel], outputsUsed: [...outputs] };
}

function boundedInteger(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new RenderPolicyError("INVALID_JOB", `${field} must be an integer between ${min} and ${max}.`);
  return value;
}

function pathList(value, field, { required }) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) throw new RenderPolicyError("INVALID_JOB", `${field} must be ${required ? "a non-empty" : "an"} array of workspace paths.`);
  if (value.length > RENDER_LIMITS.maxPaths) throw new RenderPolicyError("INVALID_JOB", `${field} may list at most ${RENDER_LIMITS.maxPaths} paths.`);
  const list = value.map((p, i) => normalizeWorkspacePath(p, `${field}[${i}]`));
  if (new Set(list).size !== list.length) throw new RenderPolicyError("INVALID_JOB", `${field} lists a path twice.`);
  return list;
}

/**
 * Validates a whole job and returns its frozen, normalized form:
 * { tool, args, inputs, outputs, timeoutMs, maxOutputBytes, image }.
 */
export function validateRenderJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) throw new RenderPolicyError("INVALID_JOB", "A render job must be an object.");
  const known = new Set(["tool", "args", "inputs", "outputs", "timeoutMs", "maxOutputBytes", "image"]);
  for (const key of Object.keys(job)) if (!known.has(key)) throw new RenderPolicyError("INVALID_JOB", `Unknown job field '${key}'.`);
  if (!RENDER_TOOLS.includes(job.tool)) throw new RenderPolicyError("INVALID_JOB", `tool must be one of ${RENDER_TOOLS.join(", ")}.`);
  const inputs = pathList(job.inputs, "inputs", { required: false });
  const outputs = pathList(job.outputs, "outputs", { required: true });
  const overlap = outputs.filter((o) => inputs.includes(o));
  if (overlap.length) throw new RenderPolicyError("INVALID_JOB", `A path cannot be both input and output: ${overlap.join(", ")}.`);
  const args = Array.isArray(job.args) ? [...job.args] : job.args;
  if (job.tool === "ffmpeg") validateFfmpegArgs(args, { inputs, outputs });
  else validateBlenderArgs(args, { inputs, outputs });
  if (job.image !== undefined && job.image !== null && (typeof job.image !== "string" || !IMAGE_PATTERN.test(job.image))) {
    throw new RenderPolicyError("INVALID_JOB", "image must be a plain image reference.");
  }
  return Object.freeze({
    tool: job.tool,
    args: Object.freeze(args),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    timeoutMs: boundedInteger(job.timeoutMs, RENDER_LIMITS.defaultTimeoutMs, 1, RENDER_LIMITS.maxTimeoutMs, "timeoutMs"),
    maxOutputBytes: boundedInteger(job.maxOutputBytes, RENDER_LIMITS.defaultMaxOutputBytes, 1, RENDER_LIMITS.maxMaxOutputBytes, "maxOutputBytes"),
    image: job.image ?? null,
  });
}

export function isValidImageReference(image) {
  return typeof image === "string" && IMAGE_PATTERN.test(image);
}
