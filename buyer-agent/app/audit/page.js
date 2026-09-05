'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Navbar from '../components/Navbar';
import styles from './audit.module.css';

function formatINR(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

function parseMeta(log) {
  if (!log || !log.metadata) return {};
  if (typeof log.metadata === 'object') return log.metadata;
  try {
    return JSON.parse(log.metadata);
  } catch {
    return {};
  }
}

function AuditClient() {
  const searchParams = useSearchParams();
  const initialSession = searchParams.get('sessionId') || '';

  const [logs, setLogs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(initialSession);
  const [loading, setLoading] = useState(true);
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [orderDeadlines, setOrderDeadlines] = useState({});
  const [globalPaidCount, setGlobalPaidCount] = useState(0);

  const timelineRef = useRef(null);
  const scrolledSessionRef = useRef(null);

  // Row-level cancel action states
  const [cancellingIds, setCancellingIds] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  const [rowStatuses, setRowStatuses] = useState({});
  const [cancelledOrders, setCancelledOrders] = useState(new Set());

  const fetchAuditData = useCallback(async () => {
    setLoading(true);
    try {
      const url = selectedSession ? `/api/audit?sessionId=${selectedSession}` : '/api/audit';
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        const fetchedLogs = data.logs || [];
        // Ensure newest entries are always at the top of the timeline
        const sortedLogs = [...fetchedLogs].sort((a, b) => b.id - a.id);
        setLogs(sortedLogs);
        if (data.sessions) {
          setSessions(data.sessions);
        }
        if (data.orderDeadlines) {
          setOrderDeadlines(data.orderDeadlines);
        }
        if (typeof data.totalPaidOrders === 'number') {
          setGlobalPaidCount(data.totalPaidOrders);
        }

        // Identify any orders already cancelled in the audit records
        const cancelledSet = new Set();
        for (const l of sortedLogs) {
          if (l.action === 'ORDER_CANCELLED' || l.result === 'cancelled') {
            const m = parseMeta(l);
            if (m.dbOrderId) cancelledSet.add(m.dbOrderId);
          }
        }
        setCancelledOrders(cancelledSet);
      }
    } catch (e) {
      console.error('Failed to load audit data', e);
    } finally {
      setLoading(false);
    }
  }, [selectedSession]);

  useEffect(() => {
    fetchAuditData();
  }, [fetchAuditData]);

  // Ensure the page starts at the very top on initial load or session switch
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  useEffect(() => {
    if (!loading && scrolledSessionRef.current !== selectedSession) {
      scrolledSessionRef.current = selectedSession;
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [loading, selectedSession]);

  // Cancel handler reusing existing /api/payment endpoint
  const handleCancelOrder = async (log, dbOrderId) => {
    if (!dbOrderId || cancellingIds[log.id]) return;

    // Clear any previous error on this row
    setRowErrors(prev => ({ ...prev, [log.id]: null }));
    setCancellingIds(prev => ({ ...prev, [log.id]: true }));

    try {
      const res = await fetch('/api/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel_order',
          sessionId: log.session_id,
          dbOrderId,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // Update just that row's displayed status from the response without a full page reload
        setRowStatuses(prev => ({ ...prev, [log.id]: 'cancelled' }));
        setCancelledOrders(prev => new Set([...prev, dbOrderId]));
        setLogs(prev =>
          prev.map(l =>
            l.id === log.id
              ? {
                  ...l,
                  result: 'cancelled',
                  reasoning: `${l.reasoning} [Order cancelled: ${data.message || 'Refund initiated'}]`,
                }
              : l
          )
        );
      } else {
        // Visible inline error on failure (e.g. order already cancelled elsewhere, window expired)
        const errorMsg = data.message || data.error || 'Failed to cancel order.';
        setRowErrors(prev => ({ ...prev, [log.id]: errorMsg }));
      }
    } catch (err) {
      setRowErrors(prev => ({
        ...prev,
        [log.id]: `Network error: ${err.message || 'Could not reach payment server.'}`,
      }));
    } finally {
      setCancellingIds(prev => ({ ...prev, [log.id]: false }));
    }
  };

  // Compute live statistics
  const totalEvents = logs.length;
  const safetyChecks = logs.filter(l => l.action === 'SAFETY_CHECK');
  const safetyPassed = safetyChecks.filter(l => l.result === 'passed').length;
  const safetyBlocked = safetyChecks.filter(l => l.result === 'blocked').length;

  // Distinct paid orders that have not been cancelled
  const paidOrderIds = new Set();
  logs.forEach(l => {
    if (
      (l.action === 'PAYMENT_CONFIRMED' || l.action === 'ORDER_CONFIRMED' || l.action === 'PAYMENT_SUCCESS') &&
      (rowStatuses[l.id] || l.result) === 'paid'
    ) {
      const oid = parseMeta(l).dbOrderId;
      if (oid && !cancelledOrders.has(oid)) {
        paidOrderIds.add(oid);
      }
    }
  });
  const ordersCompleted = selectedSession
    ? paidOrderIds.size
    : (globalPaidCount || paidOrderIds.size);

  return (
    <div className={`${styles.auditRoot} page-enter`}>
      <Navbar />

      <main className={styles.auditContainer}>
        {/* ── Header ── */}
        <div className={styles.auditHeader}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTag}>PERSISTENT AUDIT TRAIL // SQLITE STORE</span>
            <h1 className={styles.headerTitle}>Decision Trace &amp; Audit Log</h1>
            <p className={styles.headerSub}>
              Every AI action, catalog match, hard safety rule evaluation, and Razorpay payment event committed chronologically to SQLite.
            </p>
          </div>

          <div className={styles.headerControls}>
            <select
              className={styles.sessionSelect}
              value={selectedSession}
              onChange={e => setSelectedSession(e.target.value)}
            >
              <option value="">All Recorded Sessions ({sessions.length})</option>
              {sessions.map(s => {
                const sId = typeof s === 'string' ? s : s?.sessionId;
                const count = typeof s === 'object' ? s?.count : null;
                return (
                  <option key={sId} value={sId}>
                    {sId ? `${sId.slice(0, 18)}…` : 'Session'} {count ? `(${count} events)` : ''}
                  </option>
                );
              })}
            </select>

            <button className="btn btn-dark btn-sm" onClick={fetchAuditData} disabled={loading}>
              {loading ? 'Refreshing…' : '🔄 Refresh Log'}
            </button>
          </div>
        </div>

        {/* ── Key Metrics Bar ── */}
        <div className={styles.metricsGrid}>
          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Total Trace Events</span>
            <span className={styles.metricVal}>{totalEvents}</span>
          </div>
          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Safety Checks Passed</span>
            <span className={styles.metricVal} style={{ color: 'var(--status-pass)' }}>
              {safetyPassed}
            </span>
          </div>
          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Violations Blocked</span>
            <span className={styles.metricVal} style={{ color: 'var(--status-block)' }}>
              {safetyBlocked}
            </span>
          </div>
          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>
              {selectedSession ? 'Orders Paid (This Session)' : 'Orders Paid (All Sessions)'}
            </span>
            <span className={styles.metricVal} style={{ color: 'var(--accent-gold)' }}>
              {ordersCompleted}
            </span>
          </div>
        </div>

        {/* ── Timeline Pipeline List ── */}
        <div ref={timelineRef} className={styles.timeline}>
          {loading && logs.length === 0 && (
            <div className={styles.emptyState}>
              <span>Querying SQLite audit_log table…</span>
            </div>
          )}

          {!loading && logs.length === 0 && (
            <div className={styles.emptyState}>
              <span>No audit records found for the selected filter.</span>
              <Link href="/chat" className="btn btn-paper btn-sm">
                Run a transaction in Agent Terminal →
              </Link>
            </div>
          )}

          {logs.map(log => {
            const meta = parseMeta(log);
            const dbOrderId = meta.dbOrderId;

            // Current row status (accounting for real-time cancel update without full reload)
            const currentResult = rowStatuses[log.id] || log.result;
            const isCancelled = currentResult === 'cancelled' || (dbOrderId && cancelledOrders.has(dbOrderId));

            // Cancellable if order exists in DB, was paid/confirmed, and is not already cancelled, failed, or dismissed
            const isPaidOrder = Boolean(dbOrderId) && (
              log.action === 'ORDER_CONFIRMED' ||
              log.action === 'PAYMENT_SUCCESS' ||
              log.action === 'PAYMENT_CONFIRMED' ||
              currentResult === 'paid'
            );

            // Cancellation deadline evaluation
            const deadlineStr = (dbOrderId && orderDeadlines[dbOrderId]) || meta.cancellationDeadline || meta.cancellation_deadline;
            const deadlineTime = deadlineStr ? new Date(deadlineStr).getTime() : null;
            const isExpired = Boolean(deadlineTime && Date.now() > deadlineTime);

            const isCancellable = isPaidOrder && !isCancelled && !isExpired && currentResult !== 'failed' && currentResult !== 'dismissed';

            const displayResult = isCancelled ? 'cancelled' : currentResult;
            const isBlocked = isCancelled || displayResult === 'blocked' || displayResult === 'failed';
            const isPassed = !isCancelled && (displayResult === 'passed' || displayResult === 'ok' || displayResult === 'approved' || displayResult === 'paid');
            const isExpanded = expandedLogId === log.id;
            const isCancelling = Boolean(cancellingIds[log.id]);
            const rowError = rowErrors[log.id];

            return (
              <div key={log.id} className={styles.timelineCard}>
                <div className={styles.cardTop}>
                  <div className={styles.actionTagGroup}>
                    <span className={styles.eventId}>#{log.id}</span>
                    <span className={`badge ${isPassed ? 'badge-pass' : isBlocked ? 'badge-block' : 'badge-gold'}`}>
                      {log.action}
                    </span>
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      color: isCancelled ? 'var(--status-warn)' : isPassed ? 'var(--status-pass)' : isBlocked ? 'var(--status-block)' : 'var(--text-muted)'
                    }}>
                      [{displayResult?.toUpperCase()}]
                    </span>
                    {dbOrderId && (
                      <span className={styles.orderIdBadge}>
                        ORDER #{dbOrderId}
                      </span>
                    )}
                  </div>

                  <div className={styles.cardTopRight}>
                    {isCancellable && (
                      <button
                        className="btn btn-dark btn-sm"
                        style={{
                          fontSize: '0.72rem',
                          padding: '3px 10px',
                          borderColor: 'var(--status-warn)',
                          color: 'var(--status-warn)',
                          cursor: isCancelling ? 'wait' : 'pointer',
                        }}
                        onClick={() => handleCancelOrder(log, dbOrderId)}
                        disabled={isCancelling}
                        title={`Cancel order #${dbOrderId} and issue refund`}
                      >
                        {isCancelling ? 'Cancelling…' : 'Cancel Order'}
                      </button>
                    )}

                    {isPaidOrder && !isCancelled && isExpired && (
                      <button
                        className="btn btn-dark btn-sm"
                        style={{
                          fontSize: '0.72rem',
                          padding: '3px 10px',
                          borderColor: 'var(--border-subtle)',
                          color: 'var(--text-muted)',
                          cursor: 'not-allowed',
                          opacity: 0.75,
                        }}
                        disabled
                        title={`Cancellation window closed on ${new Date(deadlineTime).toLocaleString('en-IN')}`}
                      >
                        Cancellation window closed
                      </button>
                    )}

                    {isCancelled && Boolean(dbOrderId) && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--status-warn)', fontWeight: 600 }}>
                        ✓ CANCELLED
                      </span>
                    )}

                    <span className={styles.cardTimestamp}>
                      {new Date(log.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                </div>

                <p className={styles.cardReasoning}>{log.reasoning}</p>

                {rowError && (
                  <div className={styles.inlineError} role="alert">
                    <span>⚠️</span>
                    <span><strong>Cancellation Failed:</strong> {rowError}</span>
                  </div>
                )}

                {log.metadata && (
                  <div>
                    <button
                      className="btn btn-dark btn-sm"
                      style={{ fontSize: '0.68rem', padding: '3px 8px' }}
                      onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                    >
                      {isExpanded ? '▲ Hide Payload' : '▼ Inspect Metadata Payload'}
                    </button>

                    {isExpanded && (
                      <pre className={styles.payloadInspector}>
                        {typeof log.metadata === 'string'
                          ? JSON.stringify(JSON.parse(log.metadata), null, 2)
                          : JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading Decision Trace &amp; Audit…</div>}>
      <AuditClient />
    </Suspense>
  );
}
