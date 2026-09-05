# ⚡ AI Buyer Agent — Razorpay Agentic Commerce Hackathon

> **Track:** AI Growth & Agentic Commerce  
> **Demo:** `http://localhost:3000` · Audit trail: `http://localhost:3000/dashboard`

A full-stack conversational shopping agent. You describe what you want to buy in plain English. The AI finds the best product, explains its reasoning, enforces hard safety limits, and — **only after you explicitly approve** — opens a real Razorpay checkout. Every decision is logged to an inspectable audit trail.

---

## What It Does — 60-second version

```
You: "wireless gaming mouse under ₹2000"

Agent:
  1. Searches product catalog (SQLite, 10 products)
  2. Selects best match + explains WHY (price, rating, stock, feature match)
  3. Runs hard safety checks  ──► blocked if over budget / bad category / too many units
  4. Shows product card → YOU click "Approve & Pay"  (LLM cannot skip this step)
  5. Creates real Razorpay order via API → opens checkout popup
  6. Verifies HMAC-SHA256 signature server-side before marking paid
  7. Logs EVERY step with timestamp + reasoning to /dashboard
  8. Handles failure gracefully — no duplicate orders, clean error, retry button
```

---

## Architecture

```
Browser (Next.js / React)
  │
  │  POST /api/agent  { message, sessionId, history }
  ▼
lib/agent.js  ── sanitizeInput() ── Gemini agentic loop (max 6 iterations)
  ├─ search_products tool  →  lib/productSearch.js  →  SQLite
  └─ select_product tool   →  lib/safety.js  ← hard-coded limits (LLM cannot override)
                           →  lib/audit.js   ← every step logged before it completes
  │
  │  Returns: { product, explanation, safetyCheck, searchResults }
  ▼
Browser shows product card ── USER MUST CLICK "✓ Approve & Pay"
  │
  │  POST /api/payment { action: 'create_order' }
  ▼
lib/payment.js
  ├─ INSERT order (status=pending) in DB  ← before any Razorpay call
  ├─ razorpay.orders.create(...)
  └─ Razorpay checkout popup opens
        │
        │  POST /api/payment { action: 'confirm', razorpay_signature }
        ▼
      HMAC-SHA256 verified server-side
      Stock decremented atomically
      2-day cancellation window set
      Audit event logged: PAYMENT_SUCCESS
```

**Key invariant:** The LLM only has `search_products` and `select_product` tools. There is no tool to call Razorpay — that code path is only reachable by a real user click.

---

## Safety Guarantees

| Guarantee | How it works |
|---|---|
| **Explainable** | Every agent decision written to `audit_log` with a `reasoning` field. View at `/dashboard`. |
| **Bounded** | Hard limits: ₹5,000 max spend · 3 units max · 3 allowed categories — set in `.env`, enforced in `lib/safety.js`, LLM-bypass-proof. |
| **Gated** | Payment only triggers on explicit user click. The LLM returns a product card; it never calls `createOrder`. |
| **Audited** | Search → selection → safety check → payment init → payment result — every step logged atomically. |
| **Graceful failure** | Bank decline, signature mismatch, popup dismissed, rate-limit hit — all handled without orphan orders or 500 crashes. |

---

## Quick Start

### 1. Install
```bash
cd buyer-agent
npm install
```

### 2. Configure
```bash
cp .env.example .env.local
```

Edit `.env.local` with your keys:

```env
GEMINI_API_KEY=...        # https://aistudio.google.com/app/apikey
RAZORPAY_KEY_ID=...       # https://dashboard.razorpay.com/app/keys  (TEST mode)
RAZORPAY_KEY_SECRET=...
```

Optional limits (have sane defaults):
```env
MAX_BUDGET_INR=5000
ALLOWED_CATEGORIES=electronics,accessories,peripherals
MAX_QUANTITY=3
```

### 3. Run
```bash
npm run dev
# → http://localhost:3000
```

### 4. Run automated tests
```bash
# Server must be running first
node scripts/test-agent.mjs
```

---

## Live Demo Walkthrough

| Step | What to type / click |
|---|---|
| 1 | `wireless gaming mouse under ₹2000` |
| 2 | Watch agent search + select + explain in real time |
| 3 | Note the green safety badge ✓ — all limits passed |
| 4 | Click **✓ Approve & Pay** → Razorpay TEST checkout |
| 5 | Test card: `4100 2800 0000 1007` (Visa) · Exp: `12/28` · CVV: `123` |
| 6 | Click **⚡ Simulate Failure** to demo graceful failure handling |
| 7 | Open `/dashboard` → click **✓ Latest session only** to see your session |
| 8 | After payment: click **🔄 Cancel Order** (2-day cancellation window) |

**Safety demo:** Try `I want to buy a Keychron K2 keyboard` (₹6999 → blocked) or `I want 5 mice` (qty > 3 → blocked).

---

## Razorpay Test Cards (India Domestic)

> **Note:** Indian Razorpay merchant accounts process domestic INR transactions by default. The standard global card `4111 1111 1111 1111` is treated as an international card (which Razorpay declines with *"International cards are not supported"* unless international transactions are specifically enabled on the MID). Use the official domestic test cards below:

| Card | Network | Region | Result |
|---|---|---|---|
| `4100 2800 0000 1007` | Visa | India Domestic | ✓ Success |
| `5500 6700 0000 1002` | Mastercard | India Domestic | ✓ Success |
| `6527 6589 0000 1005` | RuPay | India Domestic | ✓ Success |
| `4000 0000 0000 0002` | Visa | Domestic Decline | ✗ Decline |

OTP for bank simulator / tokenization: Enter any 4–10 digit number (e.g. `123456`) to simulate success; enter <4 digits to simulate failure.

---

## Project Structure

```
buyer-agent/
├── app/
│   ├── page.js               # Chat UI (React, 'use client')
│   ├── page.module.css       # Chat UI styles
│   ├── dashboard/page.js     # Audit trail dashboard
│   └── api/
│       ├── agent/route.js    # AI orchestration endpoint
│       ├── payment/route.js  # Payment — approval-gated, 4 actions
│       ├── audit/route.js    # Audit log read + DELETE reset
│       ├── search/route.js   # Direct product search
│       └── products/route.js # Full catalog
├── lib/
│   ├── agent.js              # Gemini agentic loop + sanitizeInput()
│   ├── safety.js             # Hard-limit validator (LLM-bypass-proof)
│   ├── payment.js            # createOrder · confirmPayment · cancelOrder
│   ├── database.js           # SQLite singleton + schema + seed
│   ├── productSearch.js      # Word-by-word search + category fallback
│   └── audit.js              # Audit log write helpers
├── scripts/
│   └── test-agent.mjs        # 8-scenario automated test suite
├── db/store.db               # SQLite (auto-created on first run)
└── .env.local                # Keys (not in git)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router) + React 19 |
| AI | Gemini 2.0 Flash via `@google/genai` SDK |
| Payments | Razorpay Node SDK + browser checkout.js (TEST mode) |
| Database | `better-sqlite3` — synchronous SQLite, no ORM |
| Language | JavaScript ES Modules — no TypeScript, no build step for tests |

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio key |
| `RAZORPAY_KEY_ID` | ✅ | — | Razorpay TEST key ID |
| `RAZORPAY_KEY_SECRET` | ✅ | — | Razorpay TEST secret |
| `MAX_BUDGET_INR` | ❌ | `5000` | Per-transaction cap |
| `ALLOWED_CATEGORIES` | ❌ | `electronics,accessories,peripherals` | Category allowlist |
| `MAX_QUANTITY` | ❌ | `3` | Max units per order |
