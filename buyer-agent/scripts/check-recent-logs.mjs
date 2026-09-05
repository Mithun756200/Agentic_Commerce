import Database from 'better-sqlite3';
const db = new Database('db/store.db');
const rows = db.prepare("SELECT id, session_id, timestamp, action, reasoning, metadata FROM audit_log WHERE action IN ('LLM_RETRY', 'LLM_UNAVAILABLE') ORDER BY id DESC LIMIT 20").all();
console.log(JSON.stringify(rows, null, 2));
