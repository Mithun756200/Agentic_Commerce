# Development Guidelines — AI Buyer Agent

## Code Quality Standards

### Module System
- All files use **ES Modules** (`import`/`export`) exclusively — no CommonJS `require()`
- Named exports preferred for lib modules; default exports for React components and Next.js route handlers
- Path alias `@/` maps to the project root — use it for all cross-directory imports in `app/` and `lib/`
  ```js
  import { createOrder } from '@/lib/payment';   // ✅
  import { createOrder } from '../../lib/payment'; // ❌
  ```

### File-Level Documentation
- Every `lib/` file opens with a JSDoc block comment explaining its purpose and architectural role
- Route files open with a comment listing the HTTP methods and actions they handle
- Key invariants (e.g., "The LLM NEVER calls this endpoint") are stated explicitly at the top of the file

### Function Documentation
- All exported functions have JSDoc with `@param` (typed), `@returns`, and a description
- Internal/private helpers are prefixed with `_` (e.g., `_runSearch`) and documented inline
- Complex logic sections use `// ── Section Title ──` banner comments for visual separation

### Naming Conventions
- **camelCase** for variables, functions, and parameters
- **UPPER_SNAKE_CASE** for module-level constants and config values (e.g., `LLM_TIMEOUT_MS`, `SAFETY_CONFIG`)
- **PascalCase** for React components
- Action type strings use `UPPER_SNAKE_CASE` (e.g., `'PAYMENT_SUCCESS'`, `'TOOL_CALL_SEARCH'`)
- Database column names use `snake_case`; JS object properties mirror them (e.g., `session_id`, `razorpay_order_id`)

### Error Handling
- API routes wrap all logic in `try/catch` and return `{ success: false, error: err.message }` with appropriate HTTP status
- Specific error codes are returned as string constants (e.g., `'ORDER_NOT_FOUND'`, `'SESSION_MISMATCH'`, `'INVALID_SIGNATURE'`)
- Non-critical errors (e.g., audit log failures, dismiss_checkout) are silently swallowed with `catch (_) {}`
- LLM-specific errors (rate limits, timeouts) are handled gracefully and surfaced as user-friendly chat messages rather than 500 errors
- `console.error('[/api/route-name]', err)` pattern used for server-side error logging

### Input Validation
- Required fields validated at the top of route handlers before any business logic
- Return `{ success: false, error: '...' }` with `status: 400` for missing/invalid inputs
- Message length capped (2000 chars) with explicit validation in the agent route

---

## Architectural Patterns

### Thin API Routes, Fat Lib Modules
API routes are intentionally thin — they parse the request, validate inputs, call one lib function, and return the result. All business logic lives in `lib/`:

```js
// ✅ Route pattern
export async function POST(request) {
  const body = await request.json();
  const { message, sessionId } = body;
  if (!message || !sessionId) return NextResponse.json({ error: '...' }, { status: 400 });
  const result = await runAgent({ userMessage: message, sessionId });
  return NextResponse.json({ success: true, ...result });
}
```

### Action-Based POST Routes
Multi-action endpoints use a single POST route with an `action` discriminator field rather than multiple endpoints:
```js
const { action, sessionId } = body;
if (action === 'create_order') { ... }
if (action === 'confirm') { ... }
if (action === 'cancel_order') { ... }
```

### SQLite Singleton Pattern
The database connection is stored on `globalThis` to survive Next.js hot-reloads in dev:
```js
export function getDb() {
  if (!g._buyerAgentDb) {
    g._buyerAgentDb = new Database(DB_PATH);
    g._buyerAgentDb.pragma('journal_mode = WAL');
    g._buyerAgentDb.pragma('foreign_keys = ON');
    initSchema(g._buyerAgentDb);
  }
  return g._buyerAgentDb;
}
```
Always call `getDb()` at the start of each function — never store the db reference in module scope.

### Prepared Statements
All SQL uses `db.prepare(...).run(...)` or `db.prepare(...).get(...)` or `db.prepare(...).all(...)` — never string-interpolated SQL:
```js
// ✅
db.prepare('SELECT * FROM products WHERE id = ?').get(id);
// ❌ Never do this
db.exec(`SELECT * FROM products WHERE id = ${id}`);
```

### Audit-First Logging
Log the intent before the action, then log the outcome. Every significant step gets a `logAction()` call:
```js
logAction({ sessionId, action: 'PAYMENT_INIT', reasoning: '...', result: 'pending', metadata: { ... } });
// ... do the thing ...
logAction({ sessionId, action: 'PAYMENT_CREATED', reasoning: '...', result: 'ok', metadata: { ... } });
```
Standard `result` values: `'ok'`, `'failed'`, `'blocked'`, `'pending'`, `'in_progress'`, `'received'`, `'passed'`, `'paid'`, `'cancelled'`, `'dismissed'`

### DB-Before-External-API Pattern
Insert the local DB record before calling any external API (Razorpay). This prevents orphan records if the external call fails:
```js
const insertResult = db.prepare('INSERT INTO orders ...').run(...);
const dbOrderId = insertResult.lastInsertRowid;
// THEN call Razorpay
const razorpayOrder = await razorpay.orders.create({ ... });
```

### Safe Schema Migrations
Use try/catch for `ALTER TABLE` migrations on existing databases:
```js
for (const col of ['ALTER TABLE orders ADD COLUMN new_col TEXT']) {
  try { db.exec(col); } catch (_) {}
}
```

---

## React / Next.js Patterns

### Client Component Declaration
All interactive pages use `'use client'` at the very top of the file (before imports):
```js
'use client';
import { useState, useEffect, useCallback } from 'react';
```

### Component Decomposition
Pages are broken into small, focused sub-components defined in the same file, separated by `/* ── Component Name ── */` banner comments. Components are ordered from smallest/most-reused to the main page export at the bottom.

### CSS Modules
Scoped styles use CSS Modules (`styles.className`). Global utility classes (badges, buttons, animations) are defined in `globals.css` and used directly as string class names:
```jsx
<span className="badge badge-green">Passed</span>        // global utility
<div className={styles.productCard}>...</div>             // scoped module
<div className={`${styles.card} animate-fade-up`}>...</div> // both combined
```

### Session ID Initialization
Session IDs are initialized in `useEffect` (not `useState` initializer) to avoid React hydration mismatches:
```js
const [sessionId, setSessionId] = useState('');
useEffect(() => { setSessionId(generateSessionId()); }, []);
```

### useCallback for Fetch Functions
Data-fetching functions passed to `useEffect` are wrapped in `useCallback` to prevent infinite re-render loops:
```js
const fetchLogs = useCallback(async () => { ... }, []);
useEffect(() => { fetchLogs(); }, [fetchLogs]);
```

### Auto-Refresh Pattern
Polling intervals are set up in a separate `useEffect` that depends on the fetch function and a boolean toggle:
```js
useEffect(() => {
  if (!autoRefresh) return;
  const t = setInterval(fetchLogs, 3000);
  return () => clearInterval(t);
}, [autoRefresh, fetchLogs]);
```

### Status Cycling for Long Operations
For operations that may take several seconds, cycle through status messages to prevent the UI from appearing frozen:
```js
const statusMessages = ['Thinking...', 'Searching catalog...', 'Evaluating results...'];
let statusIdx = 0;
const statusTimer = setInterval(() => {
  statusIdx = (statusIdx + 1) % statusMessages.length;
  setAgentStatus(statusMessages[statusIdx]);
}, 4000);
// Always clearInterval in both success and error paths
```

### Inline Style for Dynamic Values
CSS variables are used for theming; dynamic values (colors from data) use inline `style` props:
```jsx
<span style={{ color: stat.color }}>{stat.value}</span>
<div style={{ color: 'var(--accent-green)', fontWeight: 700 }}>{price}</div>
```

---

## LLM / Agentic Patterns

### Tool Definition Structure
Tool definitions follow the `@google/genai` SDK format with `Type` enum for parameter types:
```js
import { GoogleGenAI, Type } from '@google/genai';
const TOOLS = [{
  name: 'tool_name',
  description: '...',
  parameters: {
    type: Type.OBJECT,
    properties: {
      param: { type: Type.STRING, description: '...' },
    },
    required: ['param'],
  },
}];
```

### Agentic Loop Guard
The agentic loop has a hard iteration cap (`for (let iteration = 0; iteration < 6; iteration++)`) to prevent infinite loops. Always include this guard.

### LLM Timeout Wrapper
Wrap LLM calls with a `Promise.race` timeout to prevent silent hangs:
```js
const timeoutPromise = new Promise((_, reject) => {
  timeoutId = setTimeout(() => {
    const err = new Error('LLM call timed out');
    err.code = 'LLM_TIMEOUT';
    reject(err);
  }, LLM_TIMEOUT_MS);
});
const result = await Promise.race([ai.models.generateContent(params), timeoutPromise]);
```

### Gemini History Safety
Chat history passed to Gemini must start with a `user` role message. Always strip leading model messages:
```js
let start = 0;
while (start < mapped.length && mapped[start].role !== 'user') start++;
return mapped.slice(start);
```

### Safety Validator Placement
`validatePurchase()` is called in two places: inside the agentic loop (on `select_product` tool call) AND before any payment is processed. This double-check ensures the safety layer cannot be bypassed.

---

## Security Patterns

### Payment Signature Verification
Always verify Razorpay signatures server-side with HMAC-SHA256 before marking any order as paid:
```js
const expectedSignature = crypto
  .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
  .update(`${razorpayOrderId}|${razorpayPaymentId}`)
  .digest('hex');
if (expectedSignature !== razorpaySignature) { /* reject */ }
```

### Session Ownership Verification
Always verify that an order belongs to the requesting session before any mutation:
```js
if (order.session_id !== sessionId) {
  return { success: false, error: 'SESSION_MISMATCH', message: '...' };
}
```

### Environment Variables
Never hardcode API keys. Always use `process.env.KEY_NAME || ''` with a safe fallback:
```js
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
```
Safety limits are env-configurable with `parseInt(process.env.MAX_BUDGET_INR || '5000', 10)`.

### LLM Isolation
The LLM is given only `search_products` and `select_product` tool definitions. Payment functions are never exposed as LLM tools — this is enforced structurally, not by prompting.
