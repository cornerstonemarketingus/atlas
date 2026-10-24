/**
 * Where `atlas code` sends a model request, and the local-only guarantee.
 *
 * Pure so it can be tested without a network: every function here decides
 * whether a customer's repository content leaves the machine.
 *
 * - A route is local when its endpoint is a loopback address (Ollama on
 *   127.0.0.1:11434 by default, or a loopback --base-url). A hosted vendor
 *   route with no --base-url is remote.
 * - `--local-only` or ATLAS_LOCAL_ONLY=1 refuses every remote route,
 *   primary, fallback and escalation alike, before anything is sent.
 * - Without it, a remote route is used only when the operator chose it
 *   (`--provider`, a vendor-only model name, `--fallback`, `--escalate`), and
 *   the run says so on stderr before the first request.
 */
import type { CoderProviderId } from "./coder-provider-selection.js";
import { isHostedCoderProvider } from "./coder-provider-selection.js";

export const DEFAULT_OLLAMA_ORIGIN = "http://127.0.0.1:11434";

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

export function isLocalOnlyRequested(args: readonly string[], environment: Readonly<Record<string, string | undefined>>): boolean {
  return args.includes("--local-only") || /^(?:1|true|yes|on)$/iu.test(environment["ATLAS_LOCAL_ONLY"]?.trim() ?? "");
}

/**
 * The Ollama server to use when no --base-url is given: ATLAS_OLLAMA_URL,
 * else OLLAMA_HOST (which Ollama itself reads, as "host", "host:port" or a URL;
 * a wildcard bind address means this machine), else 127.0.0.1:11434.
 */
export function resolveOllamaOrigin(environment: Readonly<Record<string, string | undefined>>): string {
  const explicit = environment["ATLAS_OLLAMA_URL"]?.trim();
  if (explicit) return explicit;
  const host = environment["OLLAMA_HOST"]?.trim();
  if (!host) return DEFAULT_OLLAMA_ORIGIN;
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(host) ? host : `http://${host}`);
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  if (url.port === "" && url.protocol === "http:") url.port = "11434";
  return url.origin;
}

export interface CoderRouteDescription {
  readonly providerId: CoderProviderId;
  readonly displayName: string;
  readonly model: string;
  readonly endpoint: URL | undefined;
}

/** True when this route's requests leave the machine. */
export function isRemoteRoute(route: Pick<CoderRouteDescription, "providerId" | "endpoint">): boolean {
  if (route.endpoint !== undefined) return !isLoopbackHostname(route.endpoint.hostname);
  return isHostedCoderProvider(route.providerId);
}

export function routeLocation(route: CoderRouteDescription): string {
  return route.endpoint === undefined ? `${route.displayName}'s hosted API` : `${route.endpoint.host}`;
}

export function localOnlyRefusal(route: CoderRouteDescription, role: string): string {
  return `Local-only mode (--local-only or ATLAS_LOCAL_ONLY) refuses the ${role} route ${route.providerId}/${route.model} at ${routeLocation(route)}: it is not on this machine. Use --provider ollama (or a loopback --base-url), or drop local-only mode to opt in to a remote provider.`;
}

/** The stderr notice printed before a remote route can receive anything. */
export function remoteRouteNotice(route: CoderRouteDescription, role: string, inferred: boolean): string {
  const how = inferred ? "chosen from the model name; pass --provider to choose explicitly" : "explicitly configured";
  return `Atlas: the ${role} model route ${route.providerId}/${route.model} sends requests off this machine, to ${routeLocation(route)} (${how}).`;
}
