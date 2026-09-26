/**
 * Desktop control (blueprint §5): an adapter-independent safety layer
 * (enrollment, approved short-lived sessions, active-control indicator,
 * emergency stop, scope, policy hook, audit) over the companion's desktop
 * runtime and drivers (apps/windows-companion/src/desktop), plus two extra
 * drivers for that interface: a deterministic simulated desktop and a
 * private Xvfb virtual display.
 */
export { DesktopError, TERMINAL_CODES, RECOVERABLE_CODES } from "./errors.mjs";
export { DesktopSafetyStore, normalizeScope, DEFAULT_SESSION_TTL_MS, MAX_SESSION_TTL_MS } from "./safety-store.mjs";
export { DesktopController, DRIVER_METHODS, assertDriver, redactParams, desktopActionDigest } from "./desktop-controller.mjs";
export { runControlLoop, findElement } from "./control-loop.mjs";
export { desktopToolDefinitions } from "./tools.mjs";
export { encodePng, pngSize, parseXwdHeader, xwdToPng } from "./png.mjs";
export { SimulatedDesktop, SAMPLE_APPS } from "./adapters/simulated-desktop.mjs";
export { XvfbDisplay, createXvfbDriver, detectXTools, findExecutable } from "./adapters/xvfb-desktop.mjs";
