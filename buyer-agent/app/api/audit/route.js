/**
 * GET /api/audit?sessionId=...&limit=...
 * Returns audit log entries for a session (or all entries if no sessionId).
 *
 * DELETE /api/audit
 * Clears all audit log entries (demo reset).
 */

import { NextResponse } from 'next/server';
import { getSessionLog, getAllLogs, clearAllLogs } from '@/lib/audit';
import { getDb } from '@/lib/database';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 200;

  try {
    const logs = sessionId ? getSessionLog(sessionId) : getAllLogs(limit);

    // Fetch order cancellation deadlines and statuses from SQLite
    const db = getDb();
    const orderRows = db.prepare('SELECT id, status, cancellation_deadline FROM orders').all();
    const orderDeadlines = {};
    const orderStatuses = {};
    for (const o of orderRows) {
      if (o.cancellation_deadline) orderDeadlines[o.id] = o.cancellation_deadline;
      if (o.status) orderStatuses[o.id] = o.status;
    }

    // Fetch distinct recorded sessions for the session filter dropdown
    const sessionRows = db.prepare(`
      SELECT session_id as sessionId, COUNT(*) as count
      FROM audit_log
      GROUP BY session_id
      ORDER BY MAX(id) DESC
    `).all();

    // Fetch total paid orders count across all sessions from SQLite
    const totalPaidOrdersRow = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'paid'").get();
    const totalPaidOrders = totalPaidOrdersRow ? totalPaidOrdersRow.cnt : 0;

    return NextResponse.json(
      {
        success: true,
        logs,
        orderDeadlines,
        orderStatuses,
        totalPaidOrders,
        sessions: sessionRows.map(s => s.sessionId),
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      }
    );
  } catch (err) {
    console.error('[/api/audit]', err);
    return NextResponse.json(
      { success: false, error: err.message },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  }
}

export async function DELETE() {
  try {
    const deleted = clearAllLogs();
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    console.error('[/api/audit DELETE]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
