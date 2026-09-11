import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Durable development adapter. Route handlers never depend on SQLite queries.
export function createRepository(root) {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_kind ON records(kind)",
  );
  return {
    list(kind) {
      return db
        .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind)
        .map((r) => JSON.parse(r.body));
    },
    get(kind, id) {
      const row = db
        .prepare("SELECT body FROM records WHERE kind=? AND id=?")
        .get(kind, id);
      return row ? JSON.parse(row.body) : null;
    },
    put(kind, value) {
      const item = {
        id: randomUUID(),
        createdAt: Date.now(),
        ...value,
        updatedAt: Date.now(),
      };
      db.prepare(
        "INSERT INTO records(id,kind,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      ).run(item.id, kind, JSON.stringify(item));
      return item;
    },
    remove(kind, id) {
      db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
    },
    removeMany(items) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const statement = db.prepare(
          "DELETE FROM records WHERE kind=? AND id=?",
        );
        for (const { kind, id } of items) statement.run(kind, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
