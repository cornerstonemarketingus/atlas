#!/usr/bin/env node
import { discoverDependencies, describeDependencies } from "../../apps/local-control/src/release/dependencies.mjs";

/**
 * Reports what this machine has. Installs nothing, downloads nothing, and
 * changes nothing — it is safe to run on a managed machine, and safe to read
 * before trusting the installer.
 */
const report = await discoverDependencies();
console.log(describeDependencies(report));
// A missing optional dependency is not a failure: Atlas runs without a
// browser or a local model server, with those features reporting unavailable.
process.exit(report.canInstall ? 0 : 1);
