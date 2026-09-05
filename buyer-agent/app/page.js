'use client';

import Link from 'next/link';
import Navbar from './components/Navbar';
import styles from './page.module.css';

export default function LandingPage() {
  return (
    <div className={`${styles.landingRoot} page-enter`}>
      <Navbar />

      {/* ── Hero Section (Styled directly from razorpay.com/buildathon) ── */}
      <section className={styles.heroSection}>
        <div className={styles.heroTag}>
          Razorpay Buildathon // Track 01: AI Growth &amp; Agentic Commerce
        </div>

        <h1 className={styles.heroHeading}>
          Autonomous buyer agent with <span className="accent">deterministic safety.</span>
        </h1>

        <p className={styles.heroSub}>
          An AI shopping agent that discovers merchant products, justifies its picks with clear trade-off explanations, enforces hard SQLite budget boundaries, and requires explicit user authorization before generating real Razorpay test orders.
        </p>

        <div className={styles.heroActions}>
          <Link href="/chat" className="btn btn-paper">
            Launch Agent Terminal →
          </Link>
          <Link href="/audit" className="btn btn-gold">
            View Live Audit Trail ↗
          </Link>
        </div>

        <div className={styles.heroDetailsBar}>
          <div className={styles.heroDetailItem}>
            <span className={styles.heroDetailBullet}>/</span>
            <span>Zero Client Trust</span>
          </div>
          <div className={styles.heroDetailItem}>
            <span className={styles.heroDetailBullet}>/</span>
            <span>Server-Enforced SQLite Limits</span>
          </div>
          <div className={styles.heroDetailItem}>
            <span className={styles.heroDetailBullet}>/</span>
            <span>Real Razorpay Test API</span>
          </div>
          <div className={styles.heroDetailItem}>
            <span className={styles.heroDetailBullet}>/</span>
            <span>SHA-256 HMAC Signatures</span>
          </div>
        </div>
      </section>

      {/* ── The Bar (Directly referencing Hackathon Bar) ── */}
      <section className={styles.section} style={{ paddingTop: 0 }}>
        <div className={styles.barBox}>
          <span className={styles.barTag}>THE CRITERIA // RAZORPAY BUILDATHON TRACK 01</span>
          <p className={styles.barQuote}>
            &ldquo;Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully.&rdquo;
          </p>

          <div className={styles.barGrid}>
            <div className={styles.barItem}>
              <span className={styles.barItemTitle}>01. EXPLAINABLE</span>
              <p className={styles.barItemDesc}>
                The agent parses natural language intent, searches merchant catalog, and explains exactly why a product was selected based on specs, stock, and price.
              </p>
            </div>
            <div className={styles.barItem}>
              <span className={styles.barItemTitle}>02. BOUNDED &amp; GATED</span>
              <p className={styles.barItemDesc}>
                Hard deterministic rules in code block over-budget, over-quantity, or disallowed-category orders before any payment call is ever made.
              </p>
            </div>
            <div className={styles.barItem}>
              <span className={styles.barItemTitle}>03. AUDITABLE &amp; RESILIENT</span>
              <p className={styles.barItemDesc}>
                Every evaluation step is committed to an SQLite audit log in real time. Automatic exponential backoff retries handle transient LLM provider outages up to a 45s outer budget. Payment declines are handled with zero orphan orders and full idempotency.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Interactive Guardrail Demo Scenarios ── */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTag}>TESTING THE GATES</span>
          <h2 className={styles.sectionTitle}>Pick a guardrail scenario to verify.</h2>
          <p className={styles.sectionDesc}>
            Launch the agent directly into specific boundary test cases to watch the safety layer evaluate and intervene in real time.
          </p>
        </div>

        <div className={styles.gridScenarios}>
          <Link href="/chat?scenario=budget" className={styles.scenarioCard}>
            <span className={styles.scenarioNum}>01 // BUDGET CAP</span>
            <h3 className={styles.scenarioTitle}>Exceed ₹5,000 Budget</h3>
            <p className={styles.scenarioDesc}>
              Attempts to purchase a ₹6,999 mechanical keyboard against a ₹5,000 per-transaction cap. Rejection occurs in code.
            </p>
            <span className={styles.scenarioAction}>Run Scenario →</span>
          </Link>

          <Link href="/chat?scenario=category" className={styles.scenarioCard}>
            <span className={styles.scenarioNum}>02 // POLICY BOUNDARY</span>
            <h3 className={styles.scenarioTitle}>Disallowed Category</h3>
            <p className={styles.scenarioDesc}>
              Requests an executive office chair in the disallowed &apos;furniture&apos; category. Evaluates against permitted category lists.
            </p>
            <span className={styles.scenarioAction}>Run Scenario →</span>
          </Link>

          <Link href="/chat?scenario=quantity" className={styles.scenarioCard}>
            <span className={styles.scenarioNum}>03 // VOLUME LIMIT</span>
            <h3 className={styles.scenarioTitle}>Quantity Overrun (5 Units)</h3>
            <p className={styles.scenarioDesc}>
              Requests 5 units of a wired mouse, exceeding the 3-unit per-order maximum threshold.
            </p>
            <span className={styles.scenarioAction}>Run Scenario →</span>
          </Link>

          <Link href="/chat?scenario=decline" className={styles.scenarioCard}>
            <span className={styles.scenarioNum}>04 // FAULT HANDLING</span>
            <h3 className={styles.scenarioTitle}>Simulate Bank Decline</h3>
            <p className={styles.scenarioDesc}>
              Exercises the failure recovery pipeline: verifies zero duplicate orders, records failure in audit log, and offers retry.
            </p>
            <span className={styles.scenarioAction}>Run Scenario →</span>
          </Link>

          <Link href="/chat?scenario=503" className={styles.scenarioCard}>
            <span className={styles.scenarioNum}>05 // INFRA RESILIENCE</span>
            <h3 className={styles.scenarioTitle}>503 Provider Overload</h3>
            <p className={styles.scenarioDesc}>
              Simulates an upstream Gemini 503 outage to verify automatic exponential backoff retries and bounded budget fallback.
            </p>
            <span className={styles.scenarioAction}>Run Scenario →</span>
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className={styles.footer}>
        <div>
          <span>Razorpay Agentic Commerce // Built for AI Growth &amp; Agentic Commerce Track</span>
        </div>
        <div>
          <span>{process.env.NEXT_PUBLIC_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'} · Razorpay Test-Mode APIs · SQLite 3</span>
        </div>
      </footer>
    </div>
  );
}
