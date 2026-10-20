import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constructionLaunchPlan, selfImprovementPlan } from "./business-plans.mjs";
import { normalizeBudget } from "./budget.mjs";
import { BusinessBudget } from "./business-budget.mjs";

const text = (value, label, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} is required (maximum ${max} characters).`);
  return value.trim();
};

/** Owner-scoped local business registry. Responsibilities survive mission completion. */
export class BusinessService {
  #db;
  #missions;
  #budgets;
  constructor({ filename, missionService }) {
    this.#missions = missionService;
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_responsibilities (
        id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), record TEXT NOT NULL
      );
    `);
    this.#budgets = new BusinessBudget(this.#db, missionService);
  }
  close() { this.#db.close(); }
  list() { return this.#db.prepare("SELECT record FROM businesses ORDER BY id").all().map(row => JSON.parse(row.record)); }
  get(id) {
    const row = this.#db.prepare("SELECT record FROM businesses WHERE id=?").get(id);
    if (!row) return null;
    const business = JSON.parse(row.record);
    return { ...business, executionBudget: this.#budgets.snapshot(business), responsibilities: this.#db.prepare("SELECT record FROM business_responsibilities WHERE business_id=? ORDER BY id").all(id).map(row => JSON.parse(row.record)) };
  }
  create({ name, objective, budget = {} }) {
    const limits = normalizeBudget(budget);
    if (!Object.values(limits).every(Number.isSafeInteger)) throw new Error("Business budget must use safe integers.");
    const record = { id: randomUUID(), name: text(name, "Business name", 200), objective: text(objective, "Objective"), budget: limits, executionBudgetVersion: 1, createdAt: new Date().toISOString() };
    this.#db.prepare("INSERT INTO businesses (id,record) VALUES (?,?)").run(record.id, JSON.stringify(record));
    return this.get(record.id);
  }
  assign(id, { owner, objective, successCriteria, intervalMs }) {
    if (!this.get(id)) throw Object.assign(new Error("Business not found."), { statusCode: 404 });
    if (!Array.isArray(successCriteria) || !successCriteria.length || successCriteria.length > 20) throw new Error("Provide 1-20 measurable success criteria.");
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 365 * 86400000) throw new Error("intervalMs must be an integer between one minute and one year.");
    const record = { id: randomUUID(), businessId: id, owner: text(owner, "Owner", 200), objective: text(objective, "Responsibility"), successCriteria: successCriteria.map(value => text(value, "Success criterion", 500)), intervalMs, nextReviewAt: new Date().toISOString(), status: "active", lastReview: null };
    this.#db.prepare("INSERT INTO business_responsibilities (id,business_id,record) VALUES (?,?,?)").run(record.id, id, JSON.stringify(record));
    return record;
  }
  review(id, responsibilityId, { missionId }) {
    const responsibility = this.get(id)?.responsibilities.find(item => item.id === responsibilityId);
    if (!responsibility) throw Object.assign(new Error("Responsibility not found."), { statusCode: 404 });
    const mission = this.#missions.get(missionId);
    if (!mission || mission.status !== "completed" || !mission.children.length || !mission.children.every(child => child.metadata?.businessId === id && child.result?.evidence?.length)) {
      throw new Error("Review requires a completed mission for this business with evidence for every child.");
    }
    const now = Date.now();
    responsibility.lastReview = { missionId, reviewedAt: new Date(now).toISOString() };
    responsibility.nextReviewAt = new Date(now + responsibility.intervalMs).toISOString();
    this.#db.prepare("UPDATE business_responsibilities SET record=? WHERE id=? AND business_id=?").run(JSON.stringify(responsibility), responsibilityId, id);
    return responsibility;
  }
  due(now = Date.now()) {
    return this.#db.prepare("SELECT record FROM business_responsibilities ORDER BY id").all().map(row => JSON.parse(row.record)).filter(item => item.status === "active" && Date.parse(item.nextReviewAt) <= now);
  }
  plan(id, template = "construction-launch") {
    const business = this.get(id);
    if (!business) throw Object.assign(new Error("Business not found."), { statusCode: 404 });
    const build = { "construction-launch": constructionLaunchPlan, "self-improvement": selfImprovementPlan }[template];
    if (typeof build !== "function" || !["construction-launch", "self-improvement"].includes(template)) throw new Error("Unknown business plan template.");
    return build({ businessId: id, ...business });
  }
  launch(id, { repository, model, template = "construction-launch", budget }) {
    const plan = this.plan(id, template);
    if (typeof repository !== "string" || !repository.trim() || repository.length > 4096) throw new Error("A repository folder is required for a mission.");
    if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("A model is required for a mission.");
    const business = this.get(id);
    const limits = normalizeBudget({ ...business.budget, ...budget });
    // Bound each existing scheduler child. Reservation precedes any executor.
    plan.children = plan.children.map(child => ({ ...child, budget: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Math.floor(value / plan.children.length)])) }));
    const missionId = randomUUID();
    this.#budgets.reserve(business, missionId, limits);
    // A thrown create can follow durable creation or executor start. Keep the
    // reservation even when its acknowledgement is lost; never infer rollback.
    const mission = this.#missions.create({ ...plan, id: missionId, repository, model });
    this.#budgets.created(missionId);
    return mission;
  }
}
