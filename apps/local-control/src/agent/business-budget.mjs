import { BUDGET_DIMENSIONS, BudgetExceededError } from "./budget.mjs";

const zero = () => Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key, 0]));
const MAX_RESERVATIONS = 1000;
const failure = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

/** Business admission holds upper bounds, not spending receipts. Never free a
 * terminal mission: the mission runtime permits lane retries after completion. */
export class BusinessBudget {
  constructor(db, missions) {
    this.db = db;
    this.missions = missions;
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS business_budget_reservations (
        mission_id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
        limits TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS business_budget_scope ON business_budget_reservations(business_id);`);
  }
  rows(id) {
    return this.db.prepare("SELECT * FROM business_budget_reservations WHERE business_id=? ORDER BY created_at,mission_id LIMIT ?").all(id, MAX_RESERVATIONS);
  }
  snapshot(business) {
    const reserved = zero(), observedUsage = zero();
    let uncertainMissions = 0;
    const rows = this.rows(business.id);
    for (const row of rows) {
      const limits = JSON.parse(row.limits);
      for (const key of BUDGET_DIMENSIONS) reserved[key] += limits[key];
      const mission = this.missions.get(row.mission_id);
      if (row.state !== "created" || !mission) uncertainMissions++;
      for (const child of mission?.children ?? []) {
        if (child.metadata?.businessId !== business.id) continue;
        for (const key of BUDGET_DIMENSIONS) {
          const value = child.usage?.[key];
          if (Number.isFinite(value) && value >= 0) observedUsage[key] += value;
        }
      }
    }
    return {
      limits: business.budget, reserved, observedUsage,
      remaining: Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key, Math.max(0, business.budget[key] - reserved[key])])),
      reservations: rows.length, uncertainMissions,
      historyUncertain: business.executionBudgetVersion !== 1,
      accounting: "Reservations are execution upper bounds; observed usage is a lower bound, not a cash receipt. Reservations remain held across cancellation, failure, completion and retry.",
    };
  }
  reserve(business, missionId, limits) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (business.executionBudgetVersion !== 1) throw failure("BUSINESS_BUDGET_HISTORY_UNCERTAIN", "Business predates cumulative accounting; historical usage is uncertain. Create a new explicitly budgeted business before launching.");
      const rows = this.rows(business.id);
      if (rows.length >= MAX_RESERVATIONS) throw failure("BUSINESS_BUDGET_LEDGER_FULL", "Business execution reservation ledger is full; no further launches admitted.");
      const reserved = zero();
      for (const row of rows) for (const key of BUDGET_DIMENSIONS) reserved[key] += JSON.parse(row.limits)[key];
      for (const key of BUDGET_DIMENSIONS) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new Error("Business execution budget must contain safe non-negative integers.");
        if (reserved[key] + limits[key] > business.budget[key]) {
          throw Object.assign(new BudgetExceededError(key, reserved[key] + limits[key], business.budget[key]), { statusCode: 409 });
        }
      }
      this.db.prepare("INSERT INTO business_budget_reservations VALUES (?,?,?,?,?)").run(missionId, business.id, JSON.stringify(limits), "launch-uncertain", new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  created(id) { this.db.prepare("UPDATE business_budget_reservations SET state='created' WHERE mission_id=?").run(id); }
}
