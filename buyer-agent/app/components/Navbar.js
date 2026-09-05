'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './Navbar.module.css';

export default function Navbar() {
  const pathname = usePathname();
  const [limits, setLimits] = useState({
    max_budget_inr: 5000,
    max_quantity: 3,
    allowed_categories: 'electronics,accessories,peripherals',
  });
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState({
    max_budget_inr: 5000,
    max_quantity: 3,
    allowed_categories: 'electronics,accessories,peripherals',
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success && data.settings) {
        setLimits(data.settings);
        setForm({
          max_budget_inr: data.settings.max_budget_inr,
          max_quantity: data.settings.max_quantity,
          allowed_categories: data.settings.allowed_categories,
        });
      }
    } catch (e) {
      console.warn('Navbar: failed to load settings', e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Lock background scroll when settings modal is open and handle Escape key
  useEffect(() => {
    if (!showSettings) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setShowSettings(false);
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showSettings]);

  const openSettings = () => {
    setForm({
      max_budget_inr: limits.max_budget_inr,
      max_quantity: limits.max_quantity,
      allowed_categories: limits.allowed_categories,
    });
    setShowSettings(true);
  };

  const handleSaveSettings = async (e) => {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) {
        setLimits(data.settings);
        setShowSettings(false);
        setToast('Limits updated in SQLite.');
        setTimeout(() => setToast(''), 3000);
      } else {
        alert(data.error || 'Failed to save settings');
      }
    } catch {
      alert('Network error saving settings');
    } finally {
      setSaving(false);
    }
  };

  const modalContent = showSettings ? (
    <div
      className={styles.modalOverlay}
      onClick={() => setShowSettings(false)}
    >
      <div
        className={styles.modalCard}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-limits-title"
      >
        <div className={styles.modalHeader}>
          <div>
            <h3 id="safety-limits-title" className={styles.modalTitle}>
              Server-Enforced Safety Limits
            </h3>
            <p className={styles.modalSub}>
              Thresholds persisted in SQLite database. Evaluated on every transaction in code.
            </p>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => setShowSettings(false)}
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <form noValidate onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className={styles.formField}>
            <label className={styles.fieldLabel}>Maximum Budget Limit (INR)</label>
            <input
              type="number"
              className={styles.fieldInput}
              value={form.max_budget_inr}
              onChange={(e) => setForm((prev) => ({ ...prev, max_budget_inr: e.target.value }))}
              min={100}
              step="any"
              placeholder="e.g. 5000"
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.fieldLabel}>Maximum Quantity (Per Order)</label>
            <input
              type="number"
              className={styles.fieldInput}
              value={form.max_quantity}
              onChange={(e) => setForm((prev) => ({ ...prev, max_quantity: e.target.value }))}
              min={1}
              max={50}
              step="1"
              placeholder="e.g. 3"
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.fieldLabel}>Allowed Product Categories</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={form.allowed_categories}
              onChange={(e) => setForm((prev) => ({ ...prev, allowed_categories: e.target.value }))}
              placeholder="electronics,accessories,peripherals"
              required
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-dark btn-sm"
              onClick={() => setShowSettings(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-paper btn-sm"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save Limits'}
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  return (
    <>
      <nav className={styles.navHeader}>
        <Link href="/" className={styles.brandLink}>
          <span className={styles.brandLogo}>Razorpay</span>
          <span className={styles.brandSlash}>/</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>agentic-commerce</span>
          <span className={styles.trackPill}>TRACK 01</span>
        </Link>

        <div className={styles.navLinks}>
          <Link
            href="/"
            className={`${styles.navLink} ${pathname === '/' ? styles.navLinkActive : ''}`}
          >
            Overview
          </Link>
          <Link
            href="/chat"
            className={`${styles.navLink} ${pathname === '/chat' ? styles.navLinkActive : ''}`}
          >
            Agent Terminal
          </Link>
          <Link
            href="/audit"
            className={`${styles.navLink} ${pathname === '/audit' ? styles.navLinkActive : ''}`}
          >
            Decision Trace &amp; Audit
          </Link>
        </div>

        <div className={styles.navRight}>
          <button
            type="button"
            className={styles.limitsTrigger}
            onClick={openSettings}
            title="Configure server-enforced safety limits in SQLite"
          >
            <span>CAP:</span>
            <span className={styles.limitsVal}>₹{Number(limits.max_budget_inr).toLocaleString('en-IN')}</span>
            <span style={{ color: 'var(--text-dim)' }}>|</span>
            <span>QTY: {limits.max_quantity}</span>
            <span style={{ color: 'var(--accent-gold)' }}>⚙</span>
          </button>

          {toast && (
            <span className="badge badge-pass" style={{ fontSize: '0.68rem' }}>
              {toast}
            </span>
          )}

          {/* Only show Launch Agent button when NOT already on /chat */}
          {pathname !== '/chat' && (
            <Link href="/chat" className="btn btn-paper btn-sm">
              {pathname?.startsWith('/audit') ? '← Launch Agent' : 'Launch Agent →'}
            </Link>
          )}
        </div>
      </nav>

      {/* ── Server-Enforced Limits Configuration Modal (Mounted to body via Portal) ── */}
      {mounted && typeof document !== 'undefined' ? createPortal(modalContent, document.body) : null}
    </>
  );
}
