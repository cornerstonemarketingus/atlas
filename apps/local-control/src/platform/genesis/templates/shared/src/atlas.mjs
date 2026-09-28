import { RecordStore } from "./store.mjs";
import { JobStore } from "./jobs.mjs";

/** Atlas Runtime v1: one local data boundary per generated application. */
export function createAtlas({ entities, dataFile = ":memory:" }) {
  const database = new RecordStore(entities, dataFile);
  let jobs;
  try { jobs = new JobStore(dataFile === ":memory:" ? dataFile : `${dataFile}.jobs`); }
  catch (error) { database.close(); throw error; }
  return { version: 1, database, jobs, close() { jobs.close(); database.close(); } };
}
