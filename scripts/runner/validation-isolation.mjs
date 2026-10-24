import { isAbsolute } from "node:path";

/** Operator configuration only, never repository/model-provided arguments. */
export function coderValidationArguments(environment = process.env) {
  const runtime = environment.ATLAS_VERIFY_CONTAINER;
  if (!runtime) {
    if (environment.GITHUB_ACTIONS === "true") throw new Error("Hosted coder tasks require ATLAS_VERIFY_CONTAINER; host validation is refused.");
    return [];
  }
  if (!isAbsolute(runtime)) throw new Error("ATLAS_VERIFY_CONTAINER must name an absolute container runtime path.");
  return ["--verify-container", runtime];
}
