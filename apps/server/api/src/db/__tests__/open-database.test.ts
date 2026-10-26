import { expect, test } from "bun:test";
import { openSqliteDatabase } from "@/db/open-database.js";

// This checks our connection policy; repository tests exercise Kysely's CRUD
// and transaction paths against the application's real tables.
test("openSqliteDatabase enables foreign-key enforcement", () => {
  const db = openSqliteDatabase(":memory:");
  try {
    db.exec("CREATE TABLE parents (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE children (parent_id TEXT REFERENCES parents(id))");
    expect(() => db.exec("INSERT INTO children VALUES ('missing')")).toThrow(/FOREIGN KEY/i);
    db.exec("INSERT INTO parents VALUES ('present')");
    expect(() => db.exec("INSERT INTO children VALUES ('present')")).not.toThrow();
  } finally {
    db.close();
  }
});
