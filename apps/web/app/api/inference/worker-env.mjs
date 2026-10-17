import { env } from "cloudflare:workers";

/** The Worker's bindings for route code, kept out of plain modules so those stay testable in Node. */
export const workerEnv = env;
