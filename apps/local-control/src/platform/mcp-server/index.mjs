/**
 * Atlas as an MCP server (blueprint §8): status lookup, task / artifact
 * listing, and proposing tasks, over stdio or loopback streamable HTTP.
 */
export { AtlasMcpServer, SUPPORTED_PROTOCOL_VERSIONS } from "./server.mjs";
export { atlasMcpTools } from "./tools.mjs";
export { serveStdio } from "./stdio.mjs";
export { createAtlasMcpHttpServer, createTokenResolver } from "./http.mjs";
