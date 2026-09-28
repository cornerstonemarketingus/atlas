import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAtlas } from "./atlas.mjs";

// A real local background job: durable record counts, runnable without the HTTP server.
const config = JSON.parse(readFileSync(new URL("../app.config.json", import.meta.url), "utf8"));
const atlas = createAtlas({ entities: config.entities, dataFile: fileURLToPath(new URL("../data/app.sqlite", import.meta.url)) });
try {
  const job = atlas.jobs.enqueue("database.summary", {}, { key: `summary:${new Date().toISOString().slice(0, 10)}` });
  await atlas.jobs.runNext({ "database.summary": () => atlas.database.stats() });
  const result = atlas.jobs.get(job.id);
  console.log(JSON.stringify(result, null, 2));
  if (result.state === "failed") process.exitCode = 1;
} finally { atlas.close(); }
