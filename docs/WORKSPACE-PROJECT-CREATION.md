# Workspace project creation repair (#444)

The deployment-owner restriction is intentional for the shared Genesis node:
it can execute code and publish repositories using deployment credentials.
It is not a requirement for the existing tenant-scoped hosted website builder.
Do not add customer logins to `ATLAS_OWNER_GITHUB_LOGINS` to enable websites.

Two defects reproduce the screenshot behavior:

* A signed-in workspace owner asking “Build a construction site.” can receive
  a model-selected `web-app` template. The hosted renderer rejects that template
  even though it recognizes the person's request as a website; the unavailable
  node then reports its deployment-owner restriction. The chat tool now selects
  `static-site` for that specific mismatch, using the original user's request.
  API/app requests and direct node authorization are unchanged.
* The customer event projection discarded `ready` and its preview URL, and
  replaced failure diagnostics with a success-like progress message. It now
  retains known states, accepts only a local hosted preview matching the
  operation ID, and uses fixed failure/preview copy. Raw backend messages,
  credentials and arbitrary URLs remain excluded.

The bridge's fixed owner-required copy now names the shared execution node,
rather than implying every hosted project requires deployment ownership.
No session verification, membership check, node token, allowlist, migration,
workflow or authorization policy was relaxed.

## Verification

`workspace-project-creation.test.mjs` invokes the built production Worker with
real signed GitHub-format session cookies and migrated SQLite through the D1
adapter. Model responses are scripted to reproduce the template mismatch.
It checks anonymous rejection, OAuth sign-in initiation/state cookie, foreign
workspace rejection without persistence, workspace-owner chat creation,
persisted project ownership, completed website output, rendered preview,
cross-account status isolation and continued denial of shared-node access.
Both non-streaming and streaming creation are exercised; streaming must expose
the real `ready` state and working preview.

The unchanged implementation fails persistence; the prior built projection
fails streaming completion. Focused projection tests reject unsafe links and
private sentinels. Removing each source correction with tests retained fails;
restoring passes. This is a local built-Worker end-to-end receipt, not a claim
that a real GitHub OAuth exchange or production customer session has passed.

## Deployment and release gate

1. Obtain configured review for the customer-visible projection change and
   require all exact-head CI checks. Reconcile PR437's completion-event authorship
   correction without overwriting it; it is independent of project events.
2. Confirm the existing Cloudflare `DB` binding points to the intended database.
   Existing migrations through `0015_tenancy` and `0016_project_genesis` must be
   applied using the normal authorized migration process. This PR adds none;
   do not apply unrelated held tenant migrations to unblock it.
3. Confirm existing `ATLAS_SESSION_SECRET` and GitHub OAuth client secrets reach
   the Worker through `deploy-cloudflare.yml`, and the GitHub OAuth callback
   matches the actual public origin at `/api/auth/github/callback`. Never print
   their values. Node URL/token are optional for a hosted static website.
4. Deploy the reviewed commit using **Deploy Atlas web to Cloudflare Workers**.
   No workflow edit or new provider key is required by this repair.
5. In a real signed-in non-deployment-owner workspace, request “Build a
   construction site.” Confirm a durable project record, streamed ready card,
   accessible rendered preview and reload/status recovery. Confirm another
   workspace cannot read it or create under a foreign tenant, and signed-out
   creation leads to the normal sign-in flow. Record deployed commit and evidence
   without customer content or credentials.

Do not declare the production failure fixed until that complete deployed flow
passes. Preview output is not a published website; enquiries are not delivered
and no repository publication or browser-layout qualification is implied.
