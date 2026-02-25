import Database from "better-sqlite3";
const db = new Database("presentations.db");
const rows = db.prepare("SELECT id, title, created_at FROM presentations").all();
console.log(JSON.stringify(rows, null, 2));
