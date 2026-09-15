import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class LocalTaskStore {
  #db;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS local_tasks (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        objective TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS local_tasks_created_at_idx
        ON local_tasks(created_at DESC);
    `);
    this.#db.prepare("UPDATE local_tasks SET status = 'interrupted', message = 'Atlas restarted while this task was running.', completed_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
  }

  create({ repository, objective, model }) {
    const task = {
      id: randomUUID(), repository, objective, model, status: "queued",
      message: null, createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    };
    this.#db.prepare("INSERT INTO local_tasks (id, repository, objective, model, status, message, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.repository, task.objective, task.model, task.status, task.message, task.createdAt, task.startedAt, task.completedAt);
    return task;
  }

  list(limit = 50) {
    return this.#db.prepare("SELECT id, repository, objective, model, status, message, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM local_tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  get(id) {
    return this.#db.prepare("SELECT id, repository, objective, model, status, message, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM local_tasks WHERE id = ?")
      .get(id) ?? null;
  }

  markRunning(id) {
    this.#db.prepare("UPDATE local_tasks SET status = 'running', started_at = ?, message = NULL WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  finish(id, status, message) {
    if (!['completed', 'failed'].includes(status)) throw new Error("Task completion status must be completed or failed.");
    this.#db.prepare("UPDATE local_tasks SET status = ?, message = ?, completed_at = ? WHERE id = ?")
      .run(status, message, new Date().toISOString(), id);
    return this.get(id);
  }

  close() { this.#db.close(); }
}
