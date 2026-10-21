/**
 * "Your websites": the hosted sites this workspace has built, so a site made
 * in chat can be found again after its chat message has scrolled away.
 *
 * Reads the tenant-scoped GET /api/genesis/projects and keeps only what the
 * list shows: the name, a status, when it last changed and its preview link.
 * The prompt, requirements and evidence the API also returns stay out of the
 * page's state.
 */

/** Matches the hosted preview id (`PREVIEW_ID` in api/genesis/hosted-site.mjs); anything else gets no link. */
export const SITE_ID = /^gen_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const MAX_NAME = 120;

const STATUS_LABELS = Object.freeze({
  ready: "Preview ready",
  planned: "Planned",
  building: "Building",
  failed: "Build failed",
  published: "Published",
});

/** A project status as a short label; unknown statuses read as "In progress". */
export function siteStatusLabel(status) {
  return typeof status === "string" && Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : "In progress";
}

/**
 * When a site last changed, relative to now for the recent past and as a UTC
 * date otherwise. Null when the stored time cannot be read.
 */
export function updatedLabel(iso, now = new Date()) {
  const at = typeof iso === "string" ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 60) return "Updated just now";
  if (seconds < 3600) { const minutes = Math.floor(seconds / 60); return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`; }
  if (seconds < 86400) { const hours = Math.floor(seconds / 3600); return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`; }
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getUTCMonth()];
  return `Updated ${month} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;
}

/**
 * One project row as the list shows it, or null when the row is unusable.
 * The preview link exists only for a hosted site whose stored preview is its
 * own `/preview/<id>`; a planned project has nothing to open yet.
 * @returns {{ id: string, name: string, status: string, statusLabel: string, updatedAt: string | null, previewHref: string | null } | null}
 */
export function toSite(project) {
  if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id) return null;
  const name = typeof project.name === "string" && project.name.trim() ? project.name.trim().slice(0, MAX_NAME) : "Untitled website";
  const status = typeof project.status === "string" ? project.status : "unknown";
  const previewHref = SITE_ID.test(project.id) && project.previewUrl === `/preview/${project.id}` ? `/preview/${project.id}` : null;
  return { id: project.id, name, status, statusLabel: siteStatusLabel(status), updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : null, previewHref };
}

/**
 * The workspace's websites, newest change first, as the API orders them.
 * Throws a customer-safe Error on any failure; a 401 is reported as
 * `signedOut` so the page can send the person to sign in.
 * @param {{ fetcher?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function readHostedSites({ fetcher = fetch, signal } = {}) {
  const response = await fetcher("/api/genesis/projects", { method: "GET", cache: "no-store", signal });
  if (response.status === 401) return { signedOut: true, sites: [] };
  if (!response.ok) throw new Error("Your websites could not be loaded. Try again shortly.");
  const body = await response.json();
  if (!body || !Array.isArray(body.projects)) throw new Error("Your websites could not be loaded. Try again shortly.");
  return { signedOut: false, sites: body.projects.map(toSite).filter(Boolean) };
}
