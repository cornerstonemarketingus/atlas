import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalControlServer } from "./server.mjs";
import { runIsolatedLocalCoder } from "./runner.mjs";
import { LocalTaskStore } from "./store.mjs";

const dataDirectory = process.env.ATLAS_LOCAL_DATA_DIR || join(homedir(), ".atlas");
const tokenFile = join(dataDirectory, "local-token");
mkdirSync(dataDirectory, { recursive: true });
let token = process.env.ATLAS_LOCAL_TOKEN;
if (!token) {
  try { token = readFileSync(tokenFile, "utf8").trim(); }
  catch {
    token = randomBytes(32).toString("base64url");
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    console.log(`Local access token (saved to ${tokenFile}):\n${token}`);
  }
}

const store = new LocalTaskStore(join(dataDirectory, "atlas.sqlite"));
const server = createLocalControlServer({
  store,
  token,
  runTask: (task) => runIsolatedLocalCoder(task, { dataDirectory }),
});
const host = process.env.ATLAS_LOCAL_HOST || "127.0.0.1";
const port = Number(process.env.ATLAS_LOCAL_PORT || 4317);
server.listen(port, host, () => console.log(`Atlas sovereign control plane: http://${host}:${port}`));

function shutdown() { server.close(() => { store.close(); process.exit(0); }); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
