import { biometricDecision } from "../../apps/local-control/src/mobile/biometric-policy.mjs";
import { canActOnCachedApproval, nextSessionState } from "../../apps/local-control/src/mobile/session-state.mjs";

function authorizationHeader(credential) {
  return /^Bearer\s+/iu.test(credential) ? credential : "Bearer " + credential;
}

function decisionBinding(approval) {
  return approval?.actionHash ?? approval?.actionDigest ?? approval?.summary ?? null;
}

function normalizeMission(mission, source) {
  return {
    ...mission,
    source,
    title: typeof mission?.title === "string" && mission.title.trim() ? mission.title : (typeof mission?.objective === "string" && mission.objective.trim() ? mission.objective : mission?.id ?? "Mission"),
  };
}

function normalizeApproval(approval, { source, cachedAtMs }) {
  const exactAction = typeof approval?.summary === "string" && approval.summary.trim() ? approval.summary.trim() : "Atlas requested an approval.";
  const actionBinding = decisionBinding(approval) ?? exactAction;
  return {
    ...approval,
    source,
    cachedAtMs,
    exactAction,
    actionBinding,
    // Hosted computer approvals are always consequential real-world actions.
    risk: approval?.risk ?? (source === "web" ? "critical" : "low"),
  };
}

function sectionStatus({ items, state, errors }) {
  if (state === "offline") return "offline";
  if (errors.length > 0 && items.length === 0) return "error";
  if (items.length === 0) return "empty";
  return "ready";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function createRemoteCompanion({
  fetch: fetchImpl,
  storage,
  verifyIdentity = async () => ({ verified: true, at: Date.now() }),
  daemonOrigin = "",
  webOrigin = "",
  pollIntervalMs = 15_000,
  now = Date.now,
  setInterval: setTimer = globalThis.setInterval,
  clearInterval: clearTimer = globalThis.clearInterval,
  onUpdate = () => {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createRemoteCompanion requires a fetch implementation.");
  if (!storage?.get) throw new TypeError("createRemoteCompanion requires secure storage.");

  const state = {
    sessions: {
      daemon: nextSessionState({ current: "connecting" }),
      web: nextSessionState({ current: "connecting" }),
    },
    overall: nextSessionState({ current: "connecting" }),
    missions: { status: "empty", items: [], errors: [] },
    approvals: { status: "empty", items: [], errors: [] },
    lastSyncedAtMs: null,
  };

  let lastVerifiedAtMs = null;
  let timer = null;
  const spentDecisionBindings = new Set();
  const approvalIndex = new Map();

  function updateOverall() {
    const statuses = [state.sessions.daemon.state, state.sessions.web.state];
    if (statuses.includes("ready")) {
      state.overall = nextSessionState({ current: state.overall.state, event: { type: "connected" } });
    } else if (statuses.includes("expired")) {
      state.overall = nextSessionState({ current: state.overall.state, event: { type: "unauthorized" } });
    } else if (statuses.includes("revoked")) {
      state.overall = nextSessionState({ current: state.overall.state, event: { type: "revoked" } });
    } else if (statuses.every((value) => value === "unpaired")) {
      state.overall = nextSessionState({ current: state.overall.state, event: { type: "unpaired" } });
    } else if (statuses.includes("offline")) {
      state.overall = nextSessionState({ current: state.overall.state, event: { type: "network-lost" } });
    } else {
      state.overall = nextSessionState({ current: "connecting" });
    }
  }

  function publish() {
    updateOverall();
    const snapshot = {
      sessions: { daemon: { ...state.sessions.daemon }, web: { ...state.sessions.web }, overall: { ...state.overall } },
      missions: { status: state.missions.status, items: [...state.missions.items], errors: [...state.missions.errors] },
      approvals: { status: state.approvals.status, items: [...state.approvals.items], errors: [...state.approvals.errors] },
      lastSyncedAtMs: state.lastSyncedAtMs,
    };
    onUpdate(snapshot);
    return snapshot;
  }

  async function daemonRequest(path, init = {}) {
    const credential = await storage.get("atlas.device.credential");
    if (!credential) {
      state.sessions.daemon = nextSessionState({ current: state.sessions.daemon.state, event: { type: "unpaired" } });
      return { ok: false, status: 401, data: { message: "This device is not paired." } };
    }

    try {
      const response = await fetchImpl(`${daemonOrigin}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: authorizationHeader(credential),
          ...(init.headers ?? {}),
        },
      });
      const data = await readJson(response);
      if (response.ok) state.sessions.daemon = nextSessionState({ current: state.sessions.daemon.state, event: { type: "connected" } });
      else if (response.status === 401 || response.status === 403) state.sessions.daemon = nextSessionState({ current: state.sessions.daemon.state, event: { type: "revoked" } });
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      state.sessions.daemon = nextSessionState({ current: state.sessions.daemon.state, event: { type: "network-lost" } });
      return { ok: false, status: 0, error, data: { message: error?.message ?? "Atlas is offline." } };
    }
  }

  async function webRequest(path, init = {}) {
    try {
      const response = await fetchImpl(`${webOrigin}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
      const data = await readJson(response);
      if (response.ok) state.sessions.web = nextSessionState({ current: state.sessions.web.state, event: { type: "connected" } });
      else if (response.status === 401) state.sessions.web = nextSessionState({ current: state.sessions.web.state, event: { type: "unauthorized" } });
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      state.sessions.web = nextSessionState({ current: state.sessions.web.state, event: { type: "network-lost" } });
      return { ok: false, status: 0, error, data: { message: error?.message ?? "The signed-in Atlas session is offline." } };
    }
  }

  function rememberApprovals(items) {
    approvalIndex.clear();
    for (const approval of items) approvalIndex.set(`${approval.source}:${approval.id}`, approval);
  }

  return {
    state: publish,
    async refresh() {
      const syncedAtMs = now();
      const [teamMissions, platformMissions, daemonApprovals, computer] = await Promise.all([
        daemonRequest("/v1/team/missions"),
        daemonRequest("/v1/missions"),
        daemonRequest("/v1/approvals"),
        webRequest("/api/computer/tasks"),
      ]);

      const missionErrors = [];
      const missions = [];
      if (teamMissions.ok && Array.isArray(teamMissions.data?.missions)) {
        missions.push(...teamMissions.data.missions.map((mission) => normalizeMission(mission, "team")));
      } else if (teamMissions.status && teamMissions.status !== 401 && teamMissions.status !== 403 && teamMissions.status !== 404) {
        missionErrors.push(teamMissions.data?.message ?? "Atlas could not refresh team missions.");
      }
      if (platformMissions.ok && Array.isArray(platformMissions.data?.missions)) {
        missions.push(...platformMissions.data.missions.map((mission) => normalizeMission(mission, "mission")));
      } else if (platformMissions.status && ![401, 403, 404, 503].includes(platformMissions.status)) {
        missionErrors.push(platformMissions.data?.message ?? "Atlas could not refresh missions.");
      }

      const approvalErrors = [];
      const approvals = [];
      if (daemonApprovals.ok && Array.isArray(daemonApprovals.data?.approvals)) {
        approvals.push(...daemonApprovals.data.approvals.map((approval) => normalizeApproval(approval, { source: "daemon", cachedAtMs: syncedAtMs })));
      } else if (daemonApprovals.status && daemonApprovals.status !== 401 && daemonApprovals.status !== 403) {
        approvalErrors.push(daemonApprovals.data?.message ?? "Atlas could not refresh local approvals.");
      }
      if (computer.ok) {
        approvals.push(...((computer.data?.approvals ?? []).map((approval) => normalizeApproval(approval, { source: "web", cachedAtMs: syncedAtMs }))));
      } else if (computer.status && computer.status !== 401) {
        approvalErrors.push(computer.data?.message ?? "Atlas could not refresh signed-in approvals.");
      }

      if (missions.length > 0 || state.sessions.daemon.state !== "offline") state.missions.items = missions;
      if (approvals.length > 0 || (state.sessions.daemon.state !== "offline" && state.sessions.web.state !== "offline")) state.approvals.items = approvals;
      state.missions.errors = missionErrors;
      state.approvals.errors = approvalErrors;
      state.lastSyncedAtMs = syncedAtMs;
      updateOverall();
      state.missions.status = sectionStatus({ items: state.missions.items, state: state.sessions.daemon.state, errors: missionErrors });
      state.approvals.status = sectionStatus({ items: state.approvals.items, state: state.overall.state, errors: approvalErrors });
      rememberApprovals(state.approvals.items);
      return publish();
    },
    async mission({ id, source = "team" }) {
      const path = source === "mission" ? `/v1/missions/${encodeURIComponent(id)}` : `/v1/team/missions/${encodeURIComponent(id)}`;
      const result = await daemonRequest(path);
      if (!result.ok) return { ok: false, status: result.status, reason: result.data?.message ?? "Mission detail is unavailable." };
      return { ok: true, mission: normalizeMission(result.data?.mission ?? {}, source) };
    },
    async decideApproval({ approval, decision, actionBinding = approval?.actionBinding } = {}) {
      if (!approval?.id || !approval?.source) throw new TypeError("decideApproval requires a normalized approval.");
      const current = approvalIndex.get(`${approval.source}:${approval.id}`) ?? approval;
      const binding = decisionBinding(current) ?? current.exactAction;
      if (actionBinding !== binding) {
        return { accepted: false, status: "binding-mismatch", reason: "This decision no longer matches the exact action Atlas asked you to approve." };
      }
      if (spentDecisionBindings.has(`${approval.source}:${approval.id}:${binding}`)) {
        return { accepted: false, status: "replayed", reason: "That exact approval decision has already been used." };
      }
      const expiresAtMs = current?.expiresAt ? Date.parse(current.expiresAt) : null;
      if (expiresAtMs !== null && Number.isFinite(expiresAtMs) && expiresAtMs <= now()) {
        return { accepted: false, status: "expired", reason: "That approval has expired. Refresh Atlas before deciding." };
      }

      const sessionState = current.source === "web" ? state.sessions.web.state : state.sessions.daemon.state;
      const freshness = canActOnCachedApproval({ sessionState, cachedAtMs: current.cachedAtMs ?? state.lastSyncedAtMs ?? now(), now: now() });
      if (!freshness.allowed) return { accepted: false, status: "offline", reason: freshness.reason };

      const requirement = biometricDecision({ approval: current, lastVerifiedAtMs, now: now() });
      if (requirement.required && !requirement.satisfied) {
        const verified = await verifyIdentity({ reason: `Approve: ${current.exactAction}`.slice(0, 140) });
        if (!verified?.verified) return { accepted: false, status: "biometric-refused", reason: verified?.reason ?? "Re-authentication failed." };
        lastVerifiedAtMs = verified.at ?? now();
      }

      const sourceDecision = current.source === "web"
        ? (decision === "deny" || decision === "denied" || decision === "rejected" ? "rejected" : "approved")
        : (decision === "deny" || decision === "rejected" ? "denied" : "approved");

      const request = current.source === "web"
        ? webRequest(`/api/computer/approvals/${encodeURIComponent(current.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: sourceDecision }),
        })
        : daemonRequest(`/v1/approvals/${encodeURIComponent(current.id)}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: sourceDecision }),
        });

      const result = await request;
      if (!result.ok) {
        const reason = result.data?.message ?? result.data?.status ?? "Atlas refused that decision.";
        if (result.status === 409) {
          return {
            accepted: false,
            status: expiresAtMs !== null && expiresAtMs <= now() ? "expired" : "replayed",
            reason,
          };
        }
        if (result.status === 401 || result.status === 403) {
          return { accepted: false, status: "expired", reason };
        }
        return { accepted: false, status: "error", reason };
      }

      spentDecisionBindings.add(`${approval.source}:${approval.id}:${binding}`);
      const updated = { ...current, status: sourceDecision };
      approvalIndex.set(`${updated.source}:${updated.id}`, updated);
      state.approvals.items = state.approvals.items.map((item) => (item.id === updated.id && item.source === updated.source ? updated : item));
      state.approvals.status = sectionStatus({ items: state.approvals.items, state: state.overall.state, errors: state.approvals.errors });
      publish();
      return { accepted: true, status: sourceDecision, approval: updated };
    },
    async startPolling({ intervalMs = pollIntervalMs, immediate = true } = {}) {
      if (timer) clearTimer(timer);
      if (immediate) await this.refresh();
      timer = setTimer(() => { this.refresh().catch(() => {}); }, intervalMs);
      return { started: true, intervalMs };
    },
    stopPolling() {
      if (timer) clearTimer(timer);
      timer = null;
      return { stopped: true };
    },
  };
}
