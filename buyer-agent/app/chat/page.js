'use client';

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Navbar from '../components/Navbar';
import styles from './chat.module.css';

function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatINR(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

function getTimestamp() {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

const SCENARIOS = [
  {
    key: 'budget',
    num: '01',
    label: 'Exceed Budget',
    desc: '₹6,999 Keychron keyboard against ₹5,000 cap',
    query: 'I want to buy a Keychron K2 mechanical keyboard',
  },
  {
    key: 'category',
    num: '02',
    label: 'Disallowed Category',
    desc: 'Office chair in disallowed furniture category',
    query: 'I want to buy an ergonomic office chair',
  },
  {
    key: 'quantity',
    num: '03',
    label: 'Quantity Overrun',
    desc: '5 units exceeding 3-unit per-order limit',
    query: 'I want to buy 5 units of HP X200 mouse',
  },
  {
    key: 'decline',
    num: '04',
    label: 'Simulate Decline',
    desc: 'Selects item & runs bank decline simulation',
    query: 'I need a cheap wired mouse',
    isDeclineDemo: true,
  },
  {
    key: '503',
    num: '05',
    label: '503 Overload',
    desc: 'Simulate Gemini 503 outage & test backoff sequence',
    query: 'I need a cheap mouse (simulate 503 overload)',
    simulate503: true,
  },
];

/* ── Pre-Payment Cross-Sell Recommendation Card ────────────────────────────── */
function CrossSellCard({
  recommendation,
  primaryProduct,
  addonState,
  onAccept,
  onDecline,
  loading = false,
}) {
  if (!recommendation || !recommendation.addon) return null;
  const { addon, reason } = recommendation;

  if (addonState?.status === 'accepted') {
    return (
      <div style={{
        marginTop: 14,
        marginBottom: 10,
        padding: '10px 14px',
        background: 'rgba(52, 211, 153, 0.08)',
        border: '1px solid var(--status-pass-border, rgba(52, 211, 153, 0.3))',
        borderLeft: '4px solid var(--status-pass, #34D399)',
        borderRadius: 'var(--radius-sm, 6px)',
        fontSize: '0.8rem',
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        color: 'var(--text-primary)',
      }}>
        <div>
          <span style={{ color: 'var(--status-pass)', fontWeight: 'bold' }}>✓ ADD-ON ADDED: </span>
          <strong>{addon.name}</strong> (+{formatINR(addon.price)})
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>Included in Authorization Gate below</span>
      </div>
    );
  }

  if (addonState?.status === 'declined') {
    return (
      <div style={{
        marginTop: 14,
        marginBottom: 10,
        padding: '8px 14px',
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid var(--border-subtle, #2C261E)',
        borderRadius: 'var(--radius-sm, 6px)',
        fontSize: '0.75rem',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
      }}>
        ✕ Add-on recommendation declined — proceeding with primary item only.
      </div>
    );
  }

  if (addonState?.status === 'rejected_safety') {
    return (
      <div style={{
        marginTop: 14,
        marginBottom: 10,
        padding: '10px 14px',
        background: 'rgba(239, 68, 68, 0.1)',
        border: '1px solid var(--status-fail-border, rgba(239, 68, 68, 0.3))',
        borderLeft: '4px solid var(--status-fail, #EF4444)',
        borderRadius: 'var(--radius-sm, 6px)',
        fontSize: '0.78rem',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.5,
        color: 'var(--text-primary)',
      }}>
        <div style={{ color: 'var(--status-fail)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>⚠ ADD-ON REJECTED BY SAFETY ENGINE</span>
        </div>
        <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
          {addonState.reason}
        </div>
        <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: '0.72rem' }}>
          Proceeding with original item ({primaryProduct.name}) only.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.crossSellCard}>
      <div className={styles.crossSellTop}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={styles.crossSellBadge}>Recommended Add-On</span>
          <span className={styles.crossSellName}>{addon.name}</span>
        </div>
        <span className={styles.crossSellPrice}>+{formatINR(addon.price)}</span>
      </div>

      <div className={styles.crossSellReason}>
        💡 <span style={{ fontStyle: 'italic' }}>{reason}</span>
      </div>

      <div className={styles.crossSellActions}>
        <button
          type="button"
          className="btn btn-paper btn-sm"
          style={{ padding: '6px 14px', fontSize: '0.78rem' }}
          onClick={onAccept}
          disabled={loading}
        >
          {loading ? 'Validating…' : `+ Add to Order (+${formatINR(addon.price)})`}
        </button>
        <button
          type="button"
          className="btn btn-dark btn-sm"
          style={{ padding: '6px 14px', fontSize: '0.78rem' }}
          onClick={onDecline}
          disabled={loading}
        >
          No thanks
        </button>
      </div>
    </div>
  );
}

/* ── Mandatory Human Authorization Gate ──────────────────────────────────── */
function AuthorizationGate({
  product,
  quantity,
  requestedQuantity,
  explanation,
  safetyCheck,
  addonProduct = null,
  onAuthorize,
  onSimulateFailure,
  onAbort,
  pending,
}) {
  const addonPrice = addonProduct ? addonProduct.price : 0;
  const total = (product.price * quantity) + addonPrice;
  const isAllowed = safetyCheck?.allowed;
  // Show quantity-cap notice if user asked for more than the agent selected
  const quantityCapped = requestedQuantity && requestedQuantity > quantity;

  if (!isAllowed) {
    return (
      <div className={`${styles.authGate} ${styles.authGateBlocked}`}>
        <div className={styles.authGateHeader}>
          <div className={`${styles.authGateTitle} ${styles.authGateTitleBlocked}`}>
            <span>⛔</span>
            <span>DETERMINISTIC SAFETY GATE // EXECUTION HALTED</span>
          </div>
          <span className="badge badge-block">POLICY VIOLATION</span>
        </div>

        <table className={styles.authTable}>
          <tbody>
            <tr>
              <td className={styles.authTableLabel}>PROPOSED ITEM</td>
              <td className={styles.authTableVal}>{product.name} (SKU #{product.id})</td>
            </tr>
            <tr>
              <td className={styles.authTableLabel}>CATEGORY</td>
              <td className={styles.authTableVal}><span className="font-mono">[{product.category}]</span></td>
            </tr>
            <tr>
              <td className={styles.authTableLabel}>PRICE &amp; QTY</td>
              <td className={styles.authTableVal}><span className="font-mono">{formatINR(product.price)} × {quantity} = {formatINR(total)}</span></td>
            </tr>
            <tr>
              <td className={styles.authTableLabel}>REJECTION REASON</td>
              <td className={styles.authTableVal} style={{ color: 'var(--status-block)', fontWeight: 600 }}>
                {safetyCheck?.reason}
              </td>
            </tr>
          </tbody>
        </table>

        <div className={styles.authChecklist}>
          <span>CODE-LEVEL ENFORCEMENT:</span>
          <span>Zero external payment APIs called. Order creation strictly halted.</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.authGate}>
      <div className={styles.authGateHeader}>
        <div className={styles.authGateTitle}>
          <span>🛡️</span>
          <span>MANDATORY HUMAN-IN-THE-LOOP AUTHORIZATION GATE</span>
        </div>
        <span className="badge badge-pass">SAFETY VERIFIED</span>
      </div>

      <table className={styles.authTable}>
        <tbody>
          <tr>
            <td className={styles.authTableLabel}>MERCHANT ITEM</td>
            <td className={styles.authTableVal}>
              <strong>{product.name}</strong>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: '0.75rem' }}>(SKU #{product.id})</span>
            </td>
          </tr>
          {addonProduct && (
            <tr>
              <td className={styles.authTableLabel} style={{ color: 'var(--accent-gold)' }}>COMPLEMENTARY ADD-ON</td>
              <td className={styles.authTableVal}>
                <strong>{addonProduct.name}</strong>
                <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: '0.75rem' }}>(SKU #{addonProduct.id})</span>
              </td>
            </tr>
          )}
          <tr>
            <td className={styles.authTableLabel}>UNIT PRICE × QTY</td>
            <td className={styles.authTableVal}>
              <span className="font-mono">
                {formatINR(product.price)} × {quantity} unit{quantity > 1 ? 's' : ''}
                {addonProduct && (
                  <span style={{ color: 'var(--accent-gold)', marginLeft: 8 }}>
                    + {formatINR(addonProduct.price)} × 1 unit
                  </span>
                )}
              </span>
            </td>
          </tr>
          <tr>
            <td className={styles.authTableLabel}>AUTHORIZED AMOUNT</td>
            <td>
              <span className={styles.authAmount}>{formatINR(total)}</span>
              {addonProduct && (
                <span style={{ fontSize: '0.75rem', color: 'var(--accent-gold)', marginLeft: 10, fontFamily: 'var(--font-mono)' }}>
                  (Combined Order)
                </span>
              )}
            </td>
          </tr>
          <tr>
            <td className={styles.authTableLabel}>SAFETY VERDICT</td>
            <td className={styles.authTableVal} style={{ color: 'var(--status-pass)' }}>
              ✓ All deterministic rules satisfied (Budget, Category, Quantity, Stock)
            </td>
          </tr>
        </tbody>
      </table>

      <div className={styles.authChecklist}>
        <span style={{ color: 'var(--accent-gold)' }}>AI SELECTION REASONING:</span>
        <span style={{ color: 'var(--text-primary)' }}>{explanation}</span>
      </div>

      {quantityCapped && (
        <div style={{
          background: 'var(--status-warn-bg)',
          border: '1px solid var(--status-warn-border)',
          borderLeft: '4px solid var(--status-warn)',
          borderRadius: 'var(--radius-xs)',
          padding: '10px 14px',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.78rem',
          color: 'var(--status-warn)',
          lineHeight: 1.5,
        }}>
          <strong>⚠ QUANTITY LIMIT ENFORCED</strong>
          <p style={{ margin: '4px 0 0', color: 'var(--text-primary)' }}>
            You requested <strong>{requestedQuantity} units</strong>, but the server-enforced maximum is <strong>{quantity} units per order</strong>. The order has been capped at <strong>{quantity}</strong>. To purchase more, place separate orders.
          </p>
        </div>
      )}

      <div className={styles.authActions}>
        <button
          className="btn btn-paper"
          onClick={() => onAuthorize(false)}
          disabled={pending}
        >
          {pending ? 'Opening Razorpay…' : 'Authorize & Pay with Razorpay →'}
        </button>
        <button
          className="btn btn-dark btn-sm"
          onClick={onSimulateFailure}
          disabled={pending}
          title="Demo scenario: simulate immediate bank decline"
        >
          ⚡ Simulate Bank Decline
        </button>
        <button
          className="btn btn-dark btn-sm"
          onClick={onAbort}
          disabled={pending}
        >
          Cancel
        </button>
      </div>

      <div style={{
        marginTop: 10,
        padding: '8px 12px',
        background: 'rgba(212, 158, 81, 0.08)',
        border: '1px dashed var(--accent-gold-border, rgba(212, 158, 81, 0.3))',
        borderRadius: 'var(--radius-sm, 6px)',
        fontSize: '0.75rem',
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        color: 'var(--text-secondary)'
      }}>
        <span>💳 Test Card: <strong style={{ color: 'var(--accent-gold)' }}>4100 2800 0000 1007</strong> (Exp: Any future MM/YY • CVV: 123)</span>
        <button
          type="button"
          className="btn btn-dark btn-sm"
          style={{ padding: '2px 8px', fontSize: '0.7rem' }}
          onClick={(e) => {
            e.preventDefault();
            navigator.clipboard?.writeText('4100280000001007');
            const target = e.currentTarget;
            target.textContent = 'Copied!';
            setTimeout(() => { target.textContent = 'Copy Card'; }, 1500);
          }}
        >
          Copy Card
        </button>
      </div>
    </div>
  );
}

/* ── Order Execution Result Card ─────────────────────────────────────────── */
function OrderResultCard({
  success,
  message,
  orderId,
  paymentId,
  dbOrderId,
  sessionId,
  cancellationDeadline,
  onRetry,
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelMsg, setCancelMsg] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const deadlineDate = cancellationDeadline ? new Date(cancellationDeadline) : null;
  const canCancel = success && !cancelled && deadlineDate && now < deadlineDate.getTime();

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch('/api/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_order', sessionId, dbOrderId }),
      });
      const data = await res.json();
      if (data.success) {
        setCancelled(true);
        setCancelMsg(data.message);
      } else {
        setCancelMsg(data.message || 'Cancellation failed.');
      }
    } catch {
      setCancelMsg('Network error requesting cancellation.');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className={styles.orderCard}>
      <div className={styles.orderHeader}>
        <span style={{ color: cancelled ? 'var(--status-warn)' : success ? 'var(--status-pass)' : 'var(--status-block)' }}>
          {cancelled ? '🔄 ORDER CANCELLED' : success ? '✓ ORDER CONFIRMED & PAID' : '✕ PAYMENT DECLINED'}
        </span>
        <span className={`badge ${cancelled ? 'badge-block' : success ? 'badge-pass' : 'badge-block'}`}>
          {cancelled ? 'CANCELLED' : success ? 'RAZORPAY_TEST_PAID' : 'DECLINED'}
        </span>
      </div>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
        {cancelled ? cancelMsg : message}
      </p>

      {!cancelled && (orderId || paymentId) && (
        <div className={styles.orderDetails}>
          {orderId && (
            <div>
              <span style={{ color: 'var(--text-muted)' }}>RAZORPAY ORDER: </span>
              <code>{orderId}</code>
            </div>
          )}
          {paymentId && (
            <div>
              <span style={{ color: 'var(--text-muted)' }}>PAYMENT ID: </span>
              <code>{paymentId}</code>
            </div>
          )}
          {dbOrderId && (
            <div>
              <span style={{ color: 'var(--text-muted)' }}>AUDIT DB ID: </span>
              <code>#{dbOrderId}</code>
            </div>
          )}
          <div>
            <span style={{ color: 'var(--text-muted)' }}>HMAC_SIGNATURE: </span>
            <code style={{ color: 'var(--status-pass)' }}>SHA-256 VERIFIED</code>
          </div>
        </div>
      )}

      {canCancel && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xs)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem', color: 'var(--accent-gold)', fontWeight: 700 }}>CANCELLATION &amp; RETURN WINDOW</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                Cancel by: <strong>{deadlineDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} at {deadlineDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</strong>
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Returns accepted within 7 days of delivery. Cancellation after this window is not guaranteed.
              </span>
            </div>
            <button className="btn btn-dark btn-sm" onClick={handleCancel} disabled={cancelling} style={{ flexShrink: 0 }}>
              {cancelling ? 'Cancelling…' : 'Cancel Order'}
            </button>
          </div>
        </div>
      )}

      {!success && !cancelled && onRetry && (
        <button
          className="btn btn-gold btn-sm"
          style={{ width: 'fit-content', marginTop: 6 }}
          onClick={onRetry}
        >
          🔄 Retry Transaction
        </button>
      )}

      <div style={{ marginTop: 6 }}>
        <Link href={`/audit?sessionId=${sessionId}`} style={{ fontSize: '0.75rem', color: 'var(--accent-gold)' }}>
          View full audit trail entry in SQLite DB →
        </Link>
      </div>
    </div>
  );
}

const CHAT_STORAGE_KEY = 'agentic_commerce_chat_session';

/* ── Chat Client Component ───────────────────────────────────────────────── */
function ChatClient() {
  const searchParams = useSearchParams();
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'agent',
      time: '00:00:00',
      content: `AI Buyer Agent ready.

Describe what you're looking for (e.g. "wireless gaming mouse under ₹2000"). I will search the merchant catalog, explain my recommendation, verify hard safety limits, and require your explicit signature before payment.`,
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState(null);
  const [orderResults, setOrderResults] = useState({});
  const [addonStates, setAddonStates] = useState({});
  const [validatingAddonId, setValidatingAddonId] = useState(null);
  const [retryState, setRetryState] = useState(null);
  const [loadingElapsed, setLoadingElapsed] = useState(0);

  // Rehydrate sessionId, messages, orderResults, and addonStates from sessionStorage if this tab already has a session
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.sessionId && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
          setSessionId(parsed.sessionId);
          setMessages(parsed.messages);
          if (parsed.orderResults && typeof parsed.orderResults === 'object') {
            setOrderResults(parsed.orderResults);
          }
          if (parsed.addonStates && typeof parsed.addonStates === 'object') {
            setAddonStates(parsed.addonStates);
          }
          return;
        }
      }
    } catch (_) {}

    // If no existing session in this browser tab, initialize as normal
    setSessionId(generateSessionId());
  }, []);

  // Persist current session's message array, session ID, order results, and addonStates to sessionStorage on every update
  useEffect(() => {
    if (!sessionId) return;
    try {
      sessionStorage.setItem(
        CHAT_STORAGE_KEY,
        JSON.stringify({
          sessionId,
          messages,
          orderResults,
          addonStates,
        })
      );
    } catch (_) {}
  }, [sessionId, messages, orderResults, addonStates]);

  const streamEndRef = useRef(null);
  const inputRef = useRef(null);
  const turnStartTimeRef = useRef(0);
  const isPollingRef = useRef(false);
  const hasUserInteractedRef = useRef(false);

  // Ensure view starts at the very top on initial load
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Only auto-scroll to latest message once user has started interacting
  useEffect(() => {
    if (!hasUserInteractedRef.current) return;
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, retryState]);

  // Track loading elapsed time and monitor live audit trail for LLM_RETRY in real time
  useEffect(() => {
    if (!loading) {
      setRetryState(null);
      setLoadingElapsed(0);
      return;
    }

    const startTime = Date.now();
    let cancelled = false;

    // 1. Elapsed timer - ticks every 500ms for continuous real-time progress
    const timerInterval = setInterval(() => {
      if (!cancelled) {
        setLoadingElapsed(Math.floor((Date.now() - startTime) / 1000));
      }
    }, 500);

    // 2. Serialized audit poller - guarantees no overlapping fetches and no stale out-of-order state
    const pollAudit = async () => {
      if (cancelled || !sessionId || isPollingRef.current) return;
      isPollingRef.current = true;
      try {
        const url = `/api/audit?sessionId=${encodeURIComponent(sessionId)}&_t=${Date.now()}`;
        const res = await fetch(url, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store' },
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          const turnStart = turnStartTimeRef.current || startTime;
          const retries = (data.logs || []).filter(l => {
            if (l.action !== 'LLM_RETRY') return false;
            if (!l.timestamp) return true;
            return new Date(l.timestamp).getTime() >= turnStart - 1500;
          });
          const latestRetry = retries.length > 0 ? retries[retries.length - 1] : null;
          if (latestRetry && !cancelled) {
            let meta = {};
            try {
              meta = typeof latestRetry.metadata === 'string' ? JSON.parse(latestRetry.metadata) : (latestRetry.metadata || {});
            } catch (_) {}
            const attempt = meta.attempt || 1;
            setRetryState(prev => {
              const highestAttempt = prev ? Math.max(prev.attempt, attempt) : attempt;
              const delayMs = highestAttempt === attempt ? (meta.delayMs || 1000) : prev.delayMs;
              const retryTimestamp = latestRetry.timestamp ? new Date(latestRetry.timestamp).getTime() : (prev?.retryTimestamp || Date.now());
              return {
                attempt: highestAttempt,
                maxRetries: meta.maxRetries || 3,
                delayMs,
                reasoning: latestRetry.reasoning,
                retryTimestamp,
              };
            });
          }
        }
      } catch (_) {
      } finally {
        isPollingRef.current = false;
        if (!cancelled) {
          pollingTimeout = setTimeout(pollAudit, 250);
        }
      }
    };

    let pollingTimeout = setTimeout(pollAudit, 100);

    return () => {
      cancelled = true;
      clearInterval(timerInterval);
      clearTimeout(pollingTimeout);
      isPollingRef.current = false;
    };
  }, [loading, sessionId]);

  const sendMessage = useCallback(async (queryText, options = {}) => {
    if (!queryText.trim() || loading) return;
    hasUserInteractedRef.current = true;
    const text = queryText.trim();
    setInput('');
    turnStartTimeRef.current = Date.now();
    setLoading(true);

    const userMsg = {
      id: Date.now(),
      role: 'user',
      time: getTimestamp(),
      content: text,
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      const history = messages
        .filter(m => m.content || m.product)
        .map(m => {
          if (m.role === 'user') {
            return { role: 'user', content: m.content };
          }
          let text = m.content || m.explanation || '';
          if (m.product) {
            const isPaid = orderResults[m.id]?.success;
            const statusNote = isPaid
              ? `[Order completed & paid for ${m.product.name} (₹${m.product.price})]`
              : `[Selected product: ${m.product.name} (₹${m.product.price})]`;
            text = text ? `${text}\n${statusNote}` : statusNote;
          }
          return { role: 'model', content: text };
        });

      let start = 0;
      while (start < history.length && history[start].role !== 'user') start++;
      const cleanedHistory = history.slice(start);

      const isSimRecover = options.simulateRecover
        || searchParams.get('scenario') === '503-recover'
        || text.toLowerCase().includes('simulate-503-recover')
        || text.toLowerCase().includes('503 recover');

      const isSim503 = isSimRecover
        || options.simulate503
        || searchParams.get('simulate503') === 'true'
        || searchParams.get('scenario') === '503'
        || text.toLowerCase().includes('503')
        || text.toLowerCase().includes('simulate-503');

      const backoffParam = searchParams.get('backoff');
      const backoffBaseMs = options.backoffBaseMs
        || (backoffParam ? parseInt(backoffParam, 10) : undefined);

      const payload = {
        message: text,
        sessionId,
        history: cleanedHistory,
      };

      if (isSimRecover) {
        payload.simulate503 = { failCount: 2, mockSuccess: true };
        if (backoffBaseMs !== undefined) payload.backoffBaseMs = backoffBaseMs;
      } else if (isSim503) {
        payload.simulate503 = typeof options.simulate503 === 'object' && options.simulate503 !== null
          ? options.simulate503
          : true;
        if (backoffBaseMs !== undefined) payload.backoffBaseMs = backoffBaseMs;
      }

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      const agentMsg = {
        id: Date.now() + 1,
        role: 'agent',
        time: getTimestamp(),
        content: data.text || (data.success ? '' : data.error || 'Failed to process request.'),
        errorState: data.errorState || null,
        product: data.product || null,
        quantity: data.quantity || 1,
        requestedQuantity: data.requestedQuantity || null,
        explanation: data.explanation || '',
        safetyCheck: data.safetyCheck || null,
        searchResults: data.searchResults || [],
        recommendation: data.recommendation || null,
      };

      setMessages(prev => [...prev, agentMsg]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'agent',
          time: getTimestamp(),
          content: `Connection error: ${err.message}. Please retry.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [loading, messages, sessionId, searchParams]);

  // Handle scenario URL trigger on mount
  const hasTriggeredScenario = useRef(false);
  useEffect(() => {
    if (hasTriggeredScenario.current || !sessionId) return;
    const scenarioKey = searchParams.get('scenario');
    if (scenarioKey) {
      const match = SCENARIOS.find(s => s.key === scenarioKey);
      if (match) {
        hasTriggeredScenario.current = true;
        sendMessage(match.query, { simulate503: match.simulate503 });
      }
    }
  }, [searchParams, sessionId, sendMessage]);

  // Handle cross-sell add-on decision (accept / decline)
  const handleAddonDecision = async (msg, choice) => {
    hasUserInteractedRef.current = true;
    if (choice === 'decline') {
      try {
        await fetch('/api/payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'validate_cart',
            sessionId,
            decision: 'decline',
            product: msg.product,
            recommendation: msg.recommendation,
          }),
        });
      } catch (_) {}
      setAddonStates(prev => ({
        ...prev,
        [msg.id]: { status: 'declined', addon: null },
      }));
      return;
    }

    // choice === 'accept'
    setValidatingAddonId(msg.id);
    try {
      const res = await fetch('/api/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'validate_cart',
          sessionId,
          decision: 'accept',
          product: msg.product,
          recommendation: msg.recommendation,
          quantity: msg.quantity || 1,
        }),
      });
      const data = await res.json();
      if (data.success && data.allowed) {
        setAddonStates(prev => ({
          ...prev,
          [msg.id]: {
            status: 'accepted',
            addon: msg.recommendation.addon || msg.recommendation.item,
            error: null,
          },
        }));
      } else {
        setAddonStates(prev => ({
          ...prev,
          [msg.id]: {
            status: 'blocked',
            addon: null,
            error: data.reason || 'Add-on cannot be added due to policy limit.',
          },
        }));
      }
    } catch (err) {
      setAddonStates(prev => ({
        ...prev,
        [msg.id]: {
          status: 'blocked',
          addon: null,
          error: `Validation network error: ${err.message}`,
        },
      }));
    } finally {
      setValidatingAddonId(null);
    }
  };

  // Handle Authorize Purchase & Real Razorpay Checkout
  const handleAuthorize = async (msgId, product, quantity, simulateFailure, addonProduct = null) => {
    hasUserInteractedRef.current = true;
    setPendingId(msgId);
    try {
      const createRes = await fetch('/api/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_order',
          sessionId,
          productId: product.id,
          quantity,
          priceInr: product.price,
          productName: product.name,
          addonProduct: addonProduct || undefined,
          addonPriceInr: addonProduct ? addonProduct.price : undefined,
        }),
      });
      const createData = await createRes.json();

      if (!createData.success) {
        setOrderResults(prev => ({
          ...prev,
          [msgId]: { success: false, message: createData.error || 'Order creation failed.' },
        }));
        setPendingId(null);
        return;
      }

      if (simulateFailure) {
        const failRes = await fetch('/api/payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'confirm',
            sessionId,
            dbOrderId: createData.dbOrderId,
            simulateFailure: true,
          }),
        });
        const failData = await failRes.json();
        setOrderResults(prev => ({
          ...prev,
          [msgId]: { success: false, message: failData.message || 'Payment declined by bank.' },
        }));
        setPendingId(null);
        return;
      }

      // Load checkout.js and open popup
      const loaded = await new Promise((resolve) => {
        if (document.getElementById('razorpay-checkout-js')) return resolve(true);
        const s = document.createElement('script');
        s.id = 'razorpay-checkout-js';
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.body.appendChild(s);
      });

      if (!loaded) {
        setOrderResults(prev => ({
          ...prev,
          [msgId]: { success: false, message: 'Could not load payment checkout script.' },
        }));
        setPendingId(null);
        return;
      }

      const keyRes = await fetch(`/api/payment?sessionId=${encodeURIComponent(sessionId)}`);
      const { razorpayKeyId, customerId } = await keyRes.json();
      const activeCustomerId = createData.customerId || customerId;

      const orderDesc = addonProduct
        ? `${product.name} (x${quantity}) + ${addonProduct.name}`
        : `${product.name} (x${quantity})`;

      const rzp = new window.Razorpay({
        key: razorpayKeyId,
        amount: createData.razorpayOrder.amount,
        currency: createData.razorpayOrder.currency,
        name: 'Razorpay Agentic Commerce',
        description: orderDesc,
        order_id: createData.razorpayOrder.id,
        customer_id: activeCustomerId || undefined,
        remember_customer: true,
        prefill: {
          name: 'Demo Buyer',
          email: `${sessionId.slice(5, 18).replace(/[^a-z0-9]/gi, '')}@agent.test`,
          contact: '9999999999',
          method: 'card',
        },
        theme: { color: '#D49E51' },
        handler: async (response) => {
          try {
            const confirmRes = await fetch('/api/payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'confirm',
                sessionId,
                dbOrderId: createData.dbOrderId,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpayOrderId: response.razorpay_order_id,
                razorpaySignature: response.razorpay_signature,
                simulateFailure: false,
              }),
            });
            const confirmData = await confirmRes.json();
            setOrderResults(prev => ({
              ...prev,
              [msgId]: {
                success: confirmData.success,
                message: confirmData.message || 'Payment confirmed successfully.',
                orderId: createData.razorpayOrder.id,
                paymentId: response.razorpay_payment_id,
                dbOrderId: createData.dbOrderId,
                cancellationDeadline: confirmData.cancellationDeadline,
              },
            }));
          } catch (e) {
            setOrderResults(prev => ({
              ...prev,
              [msgId]: { success: false, message: `Verification error: ${e.message}` },
            }));
          } finally {
            setPendingId(null);
          }
        },
        modal: {
          ondismiss: async () => {
            try {
              await fetch('/api/payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'dismiss_checkout', sessionId, dbOrderId: createData.dbOrderId }),
              });
            } catch {}
            setOrderResults(prev => ({
              ...prev,
              [msgId]: { success: false, message: 'Checkout dismissed. No charge made.' },
            }));
            setPendingId(null);
          },
        },
      });

      rzp.open();
    } catch (err) {
      setOrderResults(prev => ({
        ...prev,
        [msgId]: { success: false, message: err.message },
      }));
      setPendingId(null);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className={`${styles.chatRoot} page-enter`}>
      <Navbar />

      <main className={styles.chatContainer}>
        {/* ── Scenario Quick-Launch Bar ── */}
        <section className={styles.scenarioBar}>
          <div className={styles.scenarioBarHeader}>
            <span className={styles.scenarioBarTitle}>1-Click Guardrail Verifications</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
              TEST HARD DETERMINISTIC GATES
            </span>
          </div>

          <div className={styles.scenarioChips}>
            {SCENARIOS.map(s => (
              <button
                key={s.key}
                className={styles.scenarioChip}
                onClick={() => sendMessage(s.query, { simulate503: s.simulate503 })}
                disabled={loading}
                title={s.desc}
              >
                <span className={styles.scenarioChipNum}>[{s.num}]</span>
                <span className={styles.scenarioChipTitle}>{s.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ── Message Stream ── */}
        <div className={styles.messageStream}>
          {messages.map(msg => (
            <div key={msg.id} className={styles.messageCard}>
              <div className={styles.messageHeader}>
                <span className={msg.role === 'user' ? styles.authorUser : styles.authorAgent}>
                  {msg.role === 'user' ? 'USER' : 'BUYER_AGENT'}
                </span>
                <span className={styles.messageTime}>[{msg.time}]</span>
              </div>

              <div className={`${styles.messageBody} ${msg.role === 'user' ? styles.messageBodyUser : styles.messageBodyAgent}`}>
                <p style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</p>

                {msg.errorState === 'LLM_UNAVAILABLE' && (
                  <div
                    id="llm-unavailable-badge"
                    style={{
                      marginTop: '12px',
                      padding: '10px 14px',
                      background: 'rgba(239, 68, 68, 0.12)',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      borderLeft: '4px solid #EF4444',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.8rem',
                      color: '#FCA5A5',
                      fontFamily: 'var(--font-mono)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      width: 'fit-content',
                    }}
                  >
                    <span
                      style={{
                        background: '#EF4444',
                        color: '#FFFFFF',
                        padding: '2px 8px',
                        borderRadius: '3px',
                        fontWeight: 'bold',
                        fontSize: '0.72rem',
                        letterSpacing: '0.04em',
                      }}
                    >
                      STATUS: 503
                    </span>
                    <span style={{ fontWeight: 600 }}>
                      AI Engine Overloaded — 3 Retries Exhausted (exponential backoff)
                    </span>
                  </div>
                )}

                {msg.errorState === 'LLM_TIMEOUT' && (
                  <div style={{
                    marginTop: '8px',
                    padding: '8px 12px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    color: '#FDE68A',
                    fontFamily: 'var(--font-mono)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: 'fit-content',
                  }}>
                    <span style={{ color: '#F59E0B', fontWeight: 'bold' }}>[STATUS: TIMEOUT]</span>
                    <span>AI Call Timed Out (&gt;20s)</span>
                  </div>
                )}

                {msg.product && !orderResults[msg.id] && msg.recommendation && !addonStates[msg.id] && (
                  <CrossSellCard
                    recommendation={msg.recommendation}
                    onAccept={() => handleAddonDecision(msg, 'accept')}
                    onDecline={() => handleAddonDecision(msg, 'decline')}
                    loading={validatingAddonId === msg.id}
                  />
                )}

                {msg.product && !orderResults[msg.id] && addonStates[msg.id]?.status === 'blocked' && (
                  <div style={{
                    margin: '10px 0',
                    padding: '10px 14px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                    borderLeft: '4px solid #EF4444',
                    borderRadius: 'var(--radius-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                    color: '#FCA5A5',
                  }}>
                    <span style={{ fontWeight: 600 }}>🛡️ ADD-ON BLOCKED BY SAFETY GATE:</span> {addonStates[msg.id].error}
                    <div style={{ marginTop: 4, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      Proceeding with primary item only.
                    </div>
                  </div>
                )}

                {msg.product && !orderResults[msg.id] && addonStates[msg.id]?.status === 'accepted' && (
                  <div style={{
                    margin: '10px 0',
                    padding: '8px 12px',
                    background: 'rgba(34, 197, 94, 0.1)',
                    border: '1px solid rgba(34, 197, 94, 0.3)',
                    borderRadius: 'var(--radius-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                    color: 'var(--status-pass)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}>
                    <span>✓ Added complementary item: <strong>{addonStates[msg.id].addon?.name}</strong> (+{formatINR(addonStates[msg.id].addon?.price)})</span>
                  </div>
                )}

                {msg.product && !orderResults[msg.id] && addonStates[msg.id]?.status === 'declined' && (
                  <div style={{
                    margin: '8px 0',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)'
                  }}>
                    <span>• Add-on declined. Proceeding with primary item only.</span>
                  </div>
                )}

                {msg.product && !orderResults[msg.id] && (!msg.recommendation || addonStates[msg.id]) && (
                  <AuthorizationGate
                    product={msg.product}
                    quantity={msg.quantity}
                    requestedQuantity={msg.requestedQuantity}
                    explanation={msg.explanation}
                    safetyCheck={msg.safetyCheck}
                    addonProduct={addonStates[msg.id]?.status === 'accepted' ? addonStates[msg.id].addon : null}
                    onAuthorize={() => handleAuthorize(
                      msg.id,
                      msg.product,
                      msg.quantity,
                      false,
                      addonStates[msg.id]?.status === 'accepted' ? addonStates[msg.id].addon : null
                    )}
                    onSimulateFailure={() => handleAuthorize(
                      msg.id,
                      msg.product,
                      msg.quantity,
                      true,
                      addonStates[msg.id]?.status === 'accepted' ? addonStates[msg.id].addon : null
                    )}
                    onAbort={() => {
                      setOrderResults(prev => ({
                        ...prev,
                        [msg.id]: { success: false, message: 'Purchase authorization aborted by user.' },
                      }));
                    }}
                    pending={pendingId === msg.id}
                  />
                )}

                {orderResults[msg.id] && (
                  <OrderResultCard
                    success={orderResults[msg.id].success}
                    message={orderResults[msg.id].message}
                    orderId={orderResults[msg.id].orderId}
                    paymentId={orderResults[msg.id].paymentId}
                    dbOrderId={orderResults[msg.id].dbOrderId}
                    sessionId={sessionId}
                    cancellationDeadline={orderResults[msg.id].cancellationDeadline}
                    onRetry={() => {
                      setOrderResults(prev => {
                        const copy = { ...prev };
                        delete copy[msg.id];
                        return copy;
                      });
                    }}
                  />
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className={styles.messageCard}>
              <div className={styles.messageHeader}>
                <span className={styles.authorAgent}>BUYER_AGENT</span>
                <span className={styles.messageTime}>[{retryState ? 'RETRYING' : 'PROCESSING'}]</span>
              </div>
              <div className={`${styles.messageBody} ${styles.messageBodyAgent}`}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {retryState ? (
                    <div
                      id="retry-indicator-box"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        padding: '12px 16px',
                        background: 'rgba(245, 158, 11, 0.12)',
                        border: '1px solid rgba(245, 158, 11, 0.45)',
                        borderLeft: '4px solid #F59E0B',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        {/* Amber pulse indicator */}
                        <span
                          id="amber-pulse-indicator"
                          style={{
                            display: 'inline-block',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            backgroundColor: '#F59E0B',
                            boxShadow: '0 0 0 0 rgba(245, 158, 11, 0.85)',
                            animation: 'amberPulse 1.2s infinite ease-in-out',
                            flexShrink: 0,
                          }}
                        />
                        <span
                          id="retrying-indicator-label"
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.92rem',
                            fontWeight: 700,
                            color: '#F59E0B',
                            letterSpacing: '0.02em',
                          }}
                        >
                          Retrying ({retryState.attempt}/3)... {loadingElapsed}s elapsed
                        </span>
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.72rem',
                            background: 'rgba(245, 158, 11, 0.22)',
                            color: '#FDE68A',
                            padding: '3px 8px',
                            borderRadius: '3px',
                            fontWeight: 600,
                            border: '1px solid rgba(245, 158, 11, 0.35)',
                          }}
                        >
                          503 UNAVAILABLE
                        </span>
                        <span
                          id="outer-budget-indicator"
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.72rem',
                            background: loadingElapsed >= 35 ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                            color: loadingElapsed >= 35 ? '#FCA5A5' : '#CBD5E1',
                            padding: '3px 8px',
                            borderRadius: '3px',
                            fontWeight: 500,
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                          }}
                        >
                          {loadingElapsed}s / 45s outer budget
                        </span>
                      </div>
                      <div
                        id="retrying-indicator-detail"
                        style={{
                          fontSize: '0.8rem',
                          color: '#E2E8F0',
                          fontFamily: 'var(--font-mono)',
                          lineHeight: 1.5,
                          paddingLeft: '22px',
                        }}
                      >
                        {(() => {
                          const retryAgeMs = Date.now() - (retryState.retryTimestamp || Date.now());
                          const isBackoffPause = retryAgeMs < (retryState.delayMs || 1000);
                          if (isBackoffPause) {
                            const pauseSec = (retryState.delayMs / 1000).toFixed(1);
                            return `Gemini API temporarily overloaded (503). Exponential backoff ${pauseSec}s pause active before attempt ${retryState.attempt}... (${loadingElapsed}s elapsed)`;
                          }
                          return `Gemini API 503 encountered. Attempt ${retryState.attempt}/3 in progress (${loadingElapsed}s elapsed, waiting for model response)...`;
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: '14px',
                          height: '14px',
                          border: '2px solid rgba(255,255,255,0.2)',
                          borderTopColor: '#0C83FF',
                          borderRadius: '50%',
                          animation: 'spin 0.8s linear infinite',
                        }}
                      />
                      <span style={{ fontSize: '0.85rem', color: '#E2E8F0', fontWeight: 500 }}>
                        {loadingElapsed >= 5 ? `Processing request (${loadingElapsed}s elapsed), please wait...` : 'Evaluating catalog & options...'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          <div ref={streamEndRef} />
        </div>

        {/* ── Input Bar ── */}
        <div className={styles.inputBar}>
          <div className={styles.inputWrapper}>
            <span className={styles.inputPrompt}>&gt;</span>
            <input
              ref={inputRef}
              type="text"
              className={styles.inputField}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want to buy (e.g. 'wireless gaming mouse under ₹2000')..."
              disabled={loading}
            />
            <button
              id="send-message-btn"
              className="btn btn-paper btn-sm"
              onClick={() => sendMessage(input)}
              disabled={loading || !input.trim()}
              style={retryState ? {
                background: '#261C08',
                color: '#F59E0B',
                borderColor: '#F59E0B',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
              } : {}}
            >
              {retryState && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: '#F59E0B',
                    boxShadow: '0 0 0 0 rgba(245, 158, 11, 0.85)',
                    animation: 'amberPulse 1.2s infinite ease-in-out',
                  }}
                />
              )}
              {loading
                ? (retryState ? `Retrying (${retryState.attempt}/3)... ${loadingElapsed}s elapsed` : (loadingElapsed >= 5 ? `Evaluating (${loadingElapsed}s)…` : 'Evaluating…'))
                : 'Send [↵]'}
            </button>
          </div>
          <div className={styles.inputMeta}>
            <span>Enforced by SQLite database validator</span>
            <span>Session: <code>{sessionId ? sessionId.slice(0, 16) : 'sess_init'}…</code></span>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading Agent Terminal…</div>}>
      <ChatClient />
    </Suspense>
  );
}
