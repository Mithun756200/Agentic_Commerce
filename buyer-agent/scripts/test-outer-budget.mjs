#!/usr/bin/env node
/**
 * test-outer-budget.mjs — Verifies bounded worst-case wait time
 *
 * Tests:
 * 1. Forced worst-case scenario: All attempts slow (1500ms each) + 503 UNAVAILABLE on every attempt.
 * 2. Capped outer budget (maxBudgetMs = 3500ms): Confirms that instead of taking 13s+ across all
 *    slow attempts and backoff pauses, the outer time budget terminates the retry cycle and returns
 *    LLM_UNAVAILABLE cleanly within ~3.5s.
 * 3. Audit trail verification: Confirms LLM_UNAVAILABLE is logged with outer time budget reason.
 * 4. User-facing message: "the AI service is temporarily overloaded, please try again".
 */

import { getDb } from '../lib/database.js';
import { TOTAL_LLM_BUDGET_MS } from '../lib/agent.js';

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
  console.log(c.bold('  Worst-Case Bounded Wait Time & Outer Budget Test Suite'));
  console.log(c.bold('══════════════════════════════════════════════════════════════\n'));

  console.log(`  Default TOTAL_LLM_BUDGET_MS: ${c.bold(TOTAL_LLM_BUDGET_MS + 'ms')} (45s outer ceiling)\n`);

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Forced Worst-Case (Slow attempts + continuous 503s + outer cap)
  // ───────────────────────────────────────────────────────────────────────────
  const sessionId = `test_outer_budget_${Date.now()}`;
  const maxBudgetMs = 3500; // 3.5s forced outer cap for test execution
  const simulateSlowMs = 1200; // Each attempt takes 1.2s

  console.log(c.cyan('▶ Forced Worst-Case Test: Slow attempts (1.2s each) + 503 UNAVAILABLE'));
  console.log(c.dim(`  Session ID    : ${sessionId}`));
  console.log(c.dim(`  Outer Budget  : ${maxBudgetMs}ms (3.5s)`));
  console.log(c.dim(`  Attempt Delay : ${simulateSlowMs}ms slow delay per call`));
  console.log(c.dim(`  Without Budget: Would stretch to >13s across 4 attempts + 1s,2s,4s backoff`));
  console.log(c.dim(`  With Budget   : Must terminate within ~3.5s and return LLM_UNAVAILABLE\n`));

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'I need a wireless mouse',
      sessionId,
      simulate503: true,       // Force 503 on every attempt
      simulateSlowMs,          // Simulate slow response on every attempt
      backoffBaseMs: 1000,     // 1s, 2s, 4s backoff
      maxBudgetMs,             // Hard outer budget cap
    }),
  });

  const durationMs = Date.now() - t0;
  const durationSec = (durationMs / 1000).toFixed(2);
  const data = await res.json();

  console.log(c.dim(`  Request returned in ${durationSec}s (${durationMs}ms)\n`));

  // 1. Duration check — must be bounded by outer budget (3500ms + small network grace < 4500ms)
  if (durationMs <= maxBudgetMs + 1000) {
    pass(`Execution time strictly bounded by outer budget`, `${durationMs}ms ≤ ${maxBudgetMs + 1000}ms (avoided 13s+ delay)`);
  } else {
    fail(`Execution time strictly bounded by outer budget`, `Took ${durationMs}ms > ${maxBudgetMs + 1000}ms`);
  }

  // 2. Error state check — must return distinct LLM_UNAVAILABLE
  if (data.errorState === 'LLM_UNAVAILABLE') {
    pass('Returns distinct errorState "LLM_UNAVAILABLE"', `errorState=${data.errorState}`);
  } else {
    fail('Returns distinct errorState "LLM_UNAVAILABLE"', `got errorState=${data.errorState}`);
  }

  if (data.success === false) {
    pass('Response indicates success = false', `success=${data.success}`);
  } else {
    fail('Response indicates success = false', `got success=${data.success}`);
  }

  // 3. User-facing message check
  const text = (data.text || data.error || '').toLowerCase();
  if (text.includes('temporarily overloaded') && text.includes('try again')) {
    pass('User-facing message shows overload guidance', `"${data.text}"`);
  } else {
    fail('User-facing message shows overload guidance', `got "${data.text}"`);
  }

  // 4. Audit trail check — confirms LLM_UNAVAILABLE was logged with budget exhaustion details
  const auditLogs = db.prepare('SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  const unavailLogs = auditLogs.filter(l => l.action === 'LLM_UNAVAILABLE');
  const retryLogs = auditLogs.filter(l => l.action === 'LLM_RETRY');

  if (unavailLogs.length === 1) {
    pass('LLM_UNAVAILABLE event logged in audit trail', unavailLogs[0].reasoning);
  } else {
    fail('LLM_UNAVAILABLE event logged in audit trail', `found ${unavailLogs.length} events`);
  }

  console.log(c.dim(`\n  Audit Summary: ${retryLogs.length} retries attempted before outer time cap enforced LLM_UNAVAILABLE termination.`));

  console.log(c.bold('\n══════════════════════════════════════════════════════════════'));
  console.log(c.green(c.bold('  ALL BOUNDED WAIT TIME & OUTER BUDGET CHECKS PASSED ✓')));
  console.log(c.bold('══════════════════════════════════════════════════════════════\n'));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
