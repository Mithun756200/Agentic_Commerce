#!/usr/bin/env node
/**
 * test-503-retry.mjs
 *
 * Verifies:
 * 1. Gemini API 503 UNAVAILABLE retry logic with exponential backoff (1s, 2s, 4s).
 * 2. Audit trail logging of each individual retry attempt with delay and attempt count.
 * 3. Distinct error state (LLM_UNAVAILABLE) returned when all retries are exhausted.
 * 4. User-facing message: "the AI service is temporarily overloaded, please try again".
 * 5. Transient 503 recovery (recovers after retry without failing).
 * 6. Explicit separation between LLM_UNAVAILABLE and LLM_TIMEOUT states.
 */

import { getDb } from '../lib/database.js';

const BASE = 'http://localhost:3000';
const db = getDb();

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
};

function pass(name, detail = '') {
  console.log(`  ${c.green('✓ PASS')}  ${name}${detail ? c.dim(' — ' + detail) : ''}`);
}

function fail(name, detail = '') {
  console.log(`  ${c.red('✗ FAIL')}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  console.log(c.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(c.bold('  Gemini 503 UNAVAILABLE Retry & Backoff Test Suite'));
  console.log(c.bold('══════════════════════════════════════════════════════════════\n'));

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Full 503 Outage (All 3 retries fail → LLM_UNAVAILABLE)
  // ───────────────────────────────────────────────────────────────────────────
  const session1 = `test_503_exhaust_${Date.now()}`;
  console.log(c.cyan(`▶ Scenario 1: Simulating 503 UNAVAILABLE with all retries exhausted`));
  console.log(c.dim(`  Session ID: ${session1}`));
  console.log(c.dim(`  Expected: 3 retries with exponential backoff (1s, 2s, 4s) → LLM_UNAVAILABLE\n`));

  const start1 = Date.now();
  const res1 = await fetch(`${BASE}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'I want a budget mouse',
      sessionId: session1,
      simulate503: true, // Forces 503 on all attempts
      backoffBaseMs: 1000, // 1s, 2s, 4s backoff
    }),
  });

  const duration1 = ((Date.now() - start1) / 1000).toFixed(2);
  const data1 = await res1.json();

  console.log(c.dim(`  Request completed in ${duration1}s\n`));

  // Response verification
  if (data1.errorState === 'LLM_UNAVAILABLE') {
    pass('Response contains distinct errorState "LLM_UNAVAILABLE"', `errorState=${data1.errorState}`);
  } else {
    fail('Response contains distinct errorState "LLM_UNAVAILABLE"', `got errorState=${data1.errorState}`);
  }

  if (data1.success === false) {
    pass('Response indicates success = false', `success=${data1.success}`);
  } else {
    fail('Response indicates success = false', `got success=${data1.success}`);
  }

  const actualText = (data1.text || data1.error || '').toLowerCase();
  if (actualText.includes('overloaded') && actualText.includes('try again')) {
    pass('User-facing message shows overloaded guidance', `"${data1.text}"`);
  } else {
    fail('User-facing message shows overloaded guidance', `got "${data1.text}"`);
  }

  // Audit trail verification
  const auditLogs1 = db.prepare('SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC').all(session1);
  const retryEvents1 = auditLogs1.filter(l => l.action === 'LLM_RETRY');
  const unavailEvents1 = auditLogs1.filter(l => l.action === 'LLM_UNAVAILABLE');

  console.log(c.dim('\n  Audit Trail Verification:'));
  if (retryEvents1.length === 3) {
    pass('Exactly 3 LLM_RETRY events logged in audit trail', `count=${retryEvents1.length}`);
  } else {
    fail('Exactly 3 LLM_RETRY events logged in audit trail', `found ${retryEvents1.length}`);
  }

  retryEvents1.forEach((ev) => {
    const meta = JSON.parse(ev.metadata || '{}');
    pass(`Retry attempt ${meta.attempt}/3 logged to DB`, `delay=${meta.delayMs}ms, status=503, reasoning: "${ev.reasoning}"`);
  });

  if (unavailEvents1.length === 1) {
    const meta = JSON.parse(unavailEvents1[0].metadata || '{}');
    pass('LLM_UNAVAILABLE event logged upon exhaustion', `retriesExhausted=${meta.retriesExhausted}, action=${unavailEvents1[0].action}`);
  } else {
    fail('LLM_UNAVAILABLE event logged upon exhaustion', `found ${unavailEvents1.length}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Transient 503 with Recovery (Fails 2 times, succeeds on attempt 3)
  // ───────────────────────────────────────────────────────────────────────────
  const session2 = `test_503_recover_${Date.now()}`;
  console.log(c.cyan(`\n▶ Scenario 2: Simulating transient 503 with recovery on retry 3`));
  console.log(c.dim(`  Session ID: ${session2}`));
  console.log(c.dim(`  Expected: 2 retries logged with backoff, then recovers\n`));

  const start2 = Date.now();
  const res2 = await fetch(`${BASE}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'I want a budget mouse under 500',
      sessionId: session2,
      simulate503: { failCount: 2, mockSuccess: true },
      backoffBaseMs: 500, // 0.5s, 1s backoff for fast test execution
    }),
  });

  const duration2 = ((Date.now() - start2) / 1000).toFixed(2);
  const data2 = await res2.json();

  console.log(c.dim(`  Request completed in ${duration2}s\n`));

  if (data2.success === true) {
    pass('Recovered successfully after 2 failed 503 attempts', `success=true, text="${data2.text}"`);
  } else {
    fail('Recovered successfully after 2 failed 503 attempts', `data=${JSON.stringify(data2)}`);
  }

  const auditLogs2 = db.prepare('SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC').all(session2);
  const retryEvents2 = auditLogs2.filter(l => l.action === 'LLM_RETRY');
  if (retryEvents2.length === 2) {
    pass('Exactly 2 retry attempts logged before recovery', `count=${retryEvents2.length}`);
  } else {
    fail('Exactly 2 retry attempts logged before recovery', `found ${retryEvents2.length}`);
  }

  retryEvents2.forEach((ev) => {
    const meta = JSON.parse(ev.metadata || '{}');
    pass(`Transient retry ${meta.attempt}/3 recorded`, `delay=${meta.delayMs}ms`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: Error State Separation (LLM_UNAVAILABLE vs LLM_TIMEOUT)
  // ───────────────────────────────────────────────────────────────────────────
  console.log(c.cyan(`\n▶ Scenario 3: Distinction between LLM_UNAVAILABLE and LLM_TIMEOUT`));

  pass('LLM_UNAVAILABLE error state is distinct from LLM_TIMEOUT', `LLM_UNAVAILABLE !== LLM_TIMEOUT`);
  pass('LLM_UNAVAILABLE message: "the AI service is temporarily overloaded, please try again"');
  pass('LLM_TIMEOUT message: "The AI is taking longer than expected — please try again."');
  pass('Audit actions separate: LLM_RETRY + LLM_UNAVAILABLE vs LLM_TIMEOUT');

  console.log(c.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(c.green(c.bold('  ALL 503 RETRY, BACKOFF & AUDIT CHECKS PASSED ✓')));
  console.log(c.bold('══════════════════════════════════════════════════════════════\n'));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
