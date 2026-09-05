/**
 * audit.js — Centralised audit logging helpers
 * Every agent action writes a row to the audit_log table.
 */

import { getDb } from './database.js';

/**
 * @param {object} entry
 * @param {string} entry.sessionId
 * @param {string} entry.action      - e.g. "SEARCH", "SELECTION", "SAFETY_CHECK", "APPROVAL", "PAYMENT", "OUTCOME"
 * @param {string} [entry.reasoning]
 * @param {string} [entry.result]    - "ok" | "blocked" | "failed" | ...
 * @param {object} [entry.metadata]  - arbitrary JSON
 */
export function logAction({ sessionId, action, reasoning = '', result = '', metadata = {} }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (session_id, timestamp, action, reasoning, result, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    new Date().toISOString(),
    action,
    reasoning,
    result,
    JSON.stringify(metadata),
  );
}

/**
 * Fetch all audit entries for a session, newest-first.
 */
export function getSessionLog(sessionId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC
  `).all(sessionId);
}

/**
 * Fetch all audit entries (for the dashboard), newest-first.
 */
export function getAllLogs(limit = 200) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM audit_log ORDER BY id DESC LIMIT ?
  `).all(limit);
}

/**
 * Delete all audit log entries. Returns the number of rows deleted.
 * Used by the dashboard "Clear logs" demo-reset feature.
 */
export function clearAllLogs() {
  const db = getDb();
  const result = db.prepare('DELETE FROM audit_log').run();
  return result.changes;
}
