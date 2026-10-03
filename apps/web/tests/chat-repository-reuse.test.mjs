import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runInstantTool } from "../app/api/chat/instant-tools.mjs";
import { createRepositoryContentCache } from "../app/api/chat/repository-content-cache.mjs";

const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const TOKEN = "ghs_TOKENSENTINEL0123456789abcdef";
const SOURCE = "export const SECRET_SOURCE_SENTINEL = 1;\n";
const BIG = SOURCE + "const filler = 'x';\n".repeat(900); // several 3,000-character pages

/** A counting fake GitHub whose branch can move and whose files differ per commit. */
function github({ commits = { main: COMMIT_A }, files = { [COMMIT_A]: { "src/big.mjs": BIG, "src/other.mjs": "export const other = 1;\n" } }, respond } = {}) {
  const state = { commits, files, requests: [], contents: 0, commitLookups: 0 };
  state.fetcher = async (url, init = {}) => {
    state.requests.push({ url, authorization: init.headers?.authorization });
    const forced = respond?.(url, state);
    if (forced) return forced;
    const { pathname, searchParams } = new URL(url);
    const commitMatch = pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/(.+)$/u);
    if (commitMatch) {
      state.commitLookups++;
      const ref = decodeURIComponent(commitMatch[1]);
      const sha = state.commits[ref === "HEAD" ? "main" : ref];
      return sha ? new Response(sha, { status: 200 }) : new Response("{}", { status: 404 });
    }
    state.contents++;
    const ref = searchParams.get("ref");
    const tree = state.files[ref] ?? state.files[state.commits.main] ?? {};
    const path = decodeURIComponent(pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//u, ""));
    if (path === "src") return Response.json(Object.keys(tree).map((name) => ({ type: "file", path: name })));
    if (!(path in tree)) return new Response("{}", { status: 404 });
    return Response.json({ type: "file", sha: sha1(tree[path]), encoding: "base64", content: Buffer.from(tree[path]).toString("base64") });
  };
  return state;
}

function agent(upstream, { cache, allowlist = ["owner/repo"], events } = {}) {
  return { fetcher: upstream.fetcher, allowlist: new Set(allowlist), githubToken: async () => TOKEN, repositoryCache: cache, observe: (event) => events?.push(event) };
}
const call = (args, name = "read_repository_file") => ({ id: "c", function: { name, arguments: JSON.stringify({ repository: "owner/repo", path: "src/big.mjs", ...args }) } });
const read = (context, args) => runInstantTool(call(args), context);

test("A-C: one retrieval serves the first page, every continuation page and a reread", async () => {
  const upstream = github();
  const context = agent(upstream, { cache: createRepositoryContentCache({ observe() {} }) });
  const first = await read(context, {});
  assert.equal(first.ok, true);
  assert.equal(upstream.contents, 1);
  const pages = [first.preview.content];
  let page = first.page;
  while (page.nextOffset !== null) {
    const next = await read(context, { offset: page.nextOffset, fileSha: page.fileSha });
    assert.equal(next.ok, true);
    pages.push(next.preview.content);
    page = next.page;
  }
  assert.ok(pages.length > 3);
  assert.equal(pages.join(""), BIG, "pages cut from the cached file reconstruct it exactly");
  assert.equal((await read(context, {})).preview.content, first.preview.content);
  assert.equal(upstream.contents, 1, "pagination and rereads caused no further Contents requests");
  assert.equal(upstream.commitLookups, 1);
  for (const result of [first]) assert.ok(result.preview.content.length <= 3000, "model context stays bounded");
});

test("D: concurrent identical reads from several agents share one upstream retrieval", async () => {
  const upstream = github();
  const cache = createRepositoryContentCache({ observe() {} });
  const results = await Promise.all(Array.from({ length: 6 }, () => read(agent(upstream, { cache }), {})));
  assert.ok(results.every((result) => result.ok && result.page.fileSha === results[0].page.fileSha));
  assert.equal(upstream.contents, 1);
  assert.equal(upstream.commitLookups, 1);
});

test("directory listings and other files at the same commit are fetched once each", async () => {
  const upstream = github();
  const context = agent(upstream, { cache: createRepositoryContentCache({ observe() {} }) });
  for (let round = 0; round < 3; round++) {
    assert.equal((await read(context, { path: "src" })).ok, true);
    assert.equal((await read(context, { path: "src/other.mjs" })).ok, true);
  }
  assert.equal(upstream.contents, 2);
  assert.equal(upstream.commitLookups, 1, "one branch resolution covers every path");
});

test("E: a different commit is a different object and is retrieved fresh", async () => {
  const upstream = github({ files: { [COMMIT_A]: { "src/big.mjs": "old\n" }, [COMMIT_B]: { "src/big.mjs": "new\n" } } });
  const context = agent(upstream, { cache: createRepositoryContentCache({ observe() {} }) });
  assert.match((await read(context, { ref: COMMIT_A })).preview.content, /old/u);
  assert.match((await read(context, { ref: COMMIT_B })).preview.content, /new/u);
  assert.match((await read(context, { ref: COMMIT_A })).preview.content, /old/u);
  assert.equal(upstream.contents, 2);
  assert.equal(upstream.commitLookups, 0, "an explicit commit needs no resolution");
});

test("F-G: a branch that moves is re-resolved; old content is not returned for the new head and file changes are still detected", async () => {
  let clock = 1_000_000;
  const cache = createRepositoryContentCache({ now: () => clock, refTtlMs: 60_000, observe() {} });
  const upstream = github({ files: { [COMMIT_A]: { "src/big.mjs": "version A\n".repeat(500) }, [COMMIT_B]: { "src/big.mjs": "version B\n".repeat(500) } } });
  const context = agent(upstream, { cache });
  const first = await read(context, {});
  assert.match(first.preview.content, /version A/u);

  upstream.commits.main = COMMIT_B;
  const within = await read(context, { offset: first.page.nextOffset, fileSha: first.page.fileSha });
  assert.equal(within.ok, true, "inside the resolution window the reader keeps one consistent snapshot");
  assert.match(within.preview.content, /version A/u);

  clock += 61_000;
  const after = await read(context, {});
  assert.match(after.preview.content, /version B/u, "after the window the new head is read, not main@old");
  assert.notEqual(after.page.fileSha, first.page.fileSha);

  const stale = await read(context, { offset: first.page.nextOffset, fileSha: first.page.fileSha });
  assert.equal(stale.ok, false);
  assert.match(stale.content, /file changed/iu);
});

test("H: a cached file is never returned to a workspace that is not authorized for the repository", async () => {
  const upstream = github();
  const cache = createRepositoryContentCache({ observe() {} });
  assert.equal((await read(agent(upstream, { cache }), {})).ok, true);
  const before = upstream.requests.length;
  const outsider = await read(agent(upstream, { cache, allowlist: ["someone/else"] }), {});
  assert.equal(outsider.ok, false);
  assert.doesNotMatch(JSON.stringify(outsider), /SECRET_SOURCE_SENTINEL/u);
  const noCredential = await read({ ...agent(upstream, { cache }), githubToken: async () => undefined }, {});
  assert.equal(noCredential.ok, false);
  assert.doesNotMatch(JSON.stringify(noCredential), /SECRET_SOURCE_SENTINEL/u);
  assert.equal(upstream.requests.length, before, "refused calls neither fetched nor touched the cache");
});

test("I: telemetry records counts and categories, never source, paths, repositories or credentials", async () => {
  const upstream = github();
  const events = [];
  const cacheEvents = [];
  const cache = createRepositoryContentCache({ observe: (event) => cacheEvents.push(event) });
  const context = agent(upstream, { cache, events });
  const first = await read(context, {});
  await read(context, { offset: first.page.nextOffset, fileSha: first.page.fileSha });
  await runInstantTool(call({ query: "SECRET_SOURCE_SENTINEL" }, "search_repository_code"), context);

  assert.deepEqual(events.map((event) => event.category), ["commits", "contents", "search"]);
  assert.deepEqual(events.map((event) => event.source), ["chat_repository_read", "chat_repository_read", "chat_repository_search"]);
  assert.ok(cacheEvents.some((event) => event.outcome === "hit" && event.upstreamRequestsAvoided === 1));
  assert.ok(cacheEvents.some((event) => event.outcome === "miss"));
  const logged = JSON.stringify([...events, ...cacheEvents]);
  assert.doesNotMatch(logged, /SECRET_SOURCE_SENTINEL|ghs_|TOKENSENTINEL|Bearer|owner\/repo|src\/big|api\.github\.com/u);
});

test("L-M: authentication and permission failures make one request, say which problem it is, and are not cached", async () => {
  for (const [status, pattern] of [[401, /credential was rejected.*not a rate limit/su], [403, /permission problem, not a rate limit/u]]) {
    const upstream = github({ respond: () => new Response("PRIVATE_BODY", { status }) });
    const cache = createRepositoryContentCache({ observe() {} });
    const result = await read(agent(upstream, { cache }), {});
    assert.equal(result.ok, false);
    assert.match(result.content, pattern);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY/u);
    assert.equal(upstream.requests.length, 1, `HTTP ${status} is not retried`);
    assert.equal(cache.stats().entries, 0);
  }
});

test("N: a secondary rate limit pauses uncached reads for a bounded time, still serves cached files, then probes again", async () => {
  let clock = 5_000_000;
  const cache = createRepositoryContentCache({ now: () => clock, observe() {} });
  let limited = false;
  const upstream = github({ respond: (url) => (limited && !url.includes("/commits/") ? new Response("{}", { status: 403, headers: { "retry-after": "3600" } }) : null) });
  const context = agent(upstream, { cache });
  assert.equal((await read(context, { path: "src/big.mjs" })).ok, true);

  limited = true;
  const refused = await read(context, { path: "src/other.mjs" });
  assert.equal(refused.ok, false);
  assert.match(refused.content, /rate limit.*exhausted/isu);
  const afterRefusal = upstream.requests.length;

  const paused = await read(context, { path: "src/other.mjs" });
  assert.equal(paused.ok, false);
  assert.match(paused.content, /Do not retry in a loop/u);
  assert.equal(upstream.requests.length, afterRefusal, "no upstream request while paused");
  assert.equal((await read(context, { path: "src/big.mjs" })).ok, true, "cached content stays readable");
  assert.equal(upstream.requests.length, afterRefusal);

  clock += 61_000; // a huge Retry-After is capped: the next call is allowed one probe
  limited = false;
  assert.equal((await read(context, { path: "src/other.mjs" })).ok, true);
});

test("a missing path or ref is reported as missing, not as a GitHub failure, and is not cached", async () => {
  const upstream = github();
  const cache = createRepositoryContentCache({ observe() {} });
  const context = agent(upstream, { cache });
  const path = await read(context, { path: "src/nope.mjs" });
  assert.equal(path.ok, false);
  assert.match(path.label, /^No /u);
  const ref = await read(context, { ref: "no-such-branch" });
  assert.equal(ref.ok, false);
  assert.match(ref.content, /does not exist/u);
  assert.equal(cache.stats().entries, 0);
});

test("the cache is byte-bounded and evicts the least recently used file", async () => {
  const cache = createRepositoryContentCache({ maxBytes: 3_000, observe() {} });
  const upstream = github({ files: { [COMMIT_A]: { "src/a.mjs": "a".repeat(600), "src/b.mjs": "b".repeat(600), "src/c.mjs": "c".repeat(600) } }, commits: { main: COMMIT_A } });
  const context = agent(upstream, { cache });
  for (const name of ["a", "b", "c"]) await read(context, { path: `src/${name}.mjs` });
  assert.ok(cache.stats().bytes <= 3_000);
  assert.ok(cache.stats().entries < 3, "the oldest entry was evicted");
  const before = upstream.contents;
  await read(context, { path: "src/c.mjs" });
  assert.equal(upstream.contents, before, "the newest entry is still cached");
  await read(context, { path: "src/a.mjs" });
  assert.equal(upstream.contents, before + 1, "the evicted entry is fetched again");
});
