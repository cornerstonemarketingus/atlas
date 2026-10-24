/**
 * The Ollama server the local coder talks to.
 *
 * The coder speaks Ollama's native API, so it needs a server origin rather
 * than an OpenAI `/v1` base. Before this, the daemon's coder ignored
 * ATLAS_MODEL_ENDPOINT: chat and model discovery used the configured server
 * while every coding run still went to http://127.0.0.1:11434, so an owner who
 * pointed Atlas at their model server got coding runs against a different one
 * (or none). Precedence:
 *
 *   1. ATLAS_OLLAMA_URL      Atlas's explicit setting for the coder
 *   2. OLLAMA_HOST           Ollama's own variable (host:port or a URL); a
 *                            server bound to 0.0.0.0 is reached on 127.0.0.1
 *   3. ATLAS_MODEL_ENDPOINT  the endpoint the rest of Atlas uses, as an origin,
 *                            when it is on this machine (loopback)
 *   4. null                  the coder's default, http://127.0.0.1:11434
 */
export function resolveCoderOllamaUrl(env = process.env) {
  const explicit = env.ATLAS_OLLAMA_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  const host = env.OLLAMA_HOST?.trim();
  if (host) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(host) ? host : `http://${host}`);
      if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
      if (!url.port && !/:\d+$/u.test(host)) url.port = "11434";
      return url.origin;
    } catch { /* fall through to the next source */ }
  }
  // Only a server on this machine: the coder sends repository content, and a
  // remote ATLAS_MODEL_ENDPOINT (an opt-in for chat) must not quietly become
  // where every coding run goes. A remote coder needs ATLAS_OLLAMA_URL.
  const endpoint = env.ATLAS_MODEL_ENDPOINT?.trim();
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (LOOPBACK.test(url.hostname)) return url.origin;
    } catch { /* fall through */ }
  }
  return null;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/iu;
