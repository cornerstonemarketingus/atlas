import { DesktopError } from "./actions.mjs";
import { createLinuxDriver } from "./drivers/linux.mjs";
import { createWindowsDriver } from "./drivers/windows.mjs";

/**
 * Picks the desktop driver for this machine. An unsupported platform is a
 * structured capability block, not a crash: browser work keeps running.
 */
export function createDesktopDriver({ platform = process.platform, env = process.env } = {}) {
  if (env.ATLAS_DESKTOP_CONTROL === "off") {
    throw new DesktopError("DESKTOP_DISABLED", "Desktop control is turned off on this computer.", { blocked: "BLOCKED_BY_POLICY", unblock: "Unset ATLAS_DESKTOP_CONTROL=off to allow desktop actions." });
  }
  if (platform === "win32") return createWindowsDriver();
  if (platform === "linux") return createLinuxDriver({ env });
  throw new DesktopError("PLATFORM_UNSUPPORTED", `Desktop control is not available on ${platform} yet.`, { blocked: "BLOCKED_BY_CAPABILITY", unblock: "Use a Windows or Linux (X11) computer for desktop tasks; browser tasks still work." });
}
