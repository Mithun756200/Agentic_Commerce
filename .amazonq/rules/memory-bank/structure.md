# Project Structure — AI Buyer Agent

## Directory Layout

```
Agentic_Commerce/
└── buyer-agent/                  # Single Next.js application (App Router)
    ├── app/                      # Next.js App Router pages and API routes
    │   ├── page.js               # Main chat UI (root route)
    │   ├── page.module.css       # Chat page scoped styles
    │   ├── layout.js             # Root layout (metadata, global CSS)
    │   ├── globals.css           # Global design system / CSS variables
    │   ├── dashboard/
    │   │   ├── page.js           # Audit trail dashboard UI
    │   │   └── dashboard.module.css
    │   └── api/
    │       ├── agent/route.js    # POST — AI agent orchestration endpoint
    │       ├── payment/route.js  # POST — Payment create/confirm/cancel/dismiss
    │       ├── search/route.js   # GET  — Product search endpoint
    │       ├── products/route.js # GET  — Full catalog endpoint
    │       └── audit/route.js    # GET  — Audit log retrieval endpoint
    ├── lib/                      # Server-side business logic (pure modules)
    │   ├── agent.js              # Gemini orchestrator + agentic loop
    │   ├── database.js           # SQLite singleton, schema init, product seeding
    │   ├── productSearch.js      # Catalog search queries (word-by-word + fallback)
    │   ├── safety.js             # Hard-limit purchase validator
    │   ├── payment.js            # Razorpay service layer (create/confirm/cancel)
    │   └── audit.js              # Audit log write/read helpers
    ├── db/
    │   └── store.db              # SQLite database (auto-created on first run)
    ├── public/                   # Static assets (SVGs)
    ├── .env.example              # Environment variable templates
    ├── .env.local                # Actual secrets (git-ignored)
    ├── next.config.mjs           # Next.js config (serverExternalPackages for sqlite3)
    ├── jsconfig.json             # JS path aliases
    ├── eslint.config.mjs         # ESLint flat config
    └── package.json
```

## Core Components & Relationships

### Request Flow (Happy Path)

```
Browser (app/page.js)
  │  POST /api/agent
  ▼
app/api/agent/route.js
  │  calls
  ▼
lib/agent.js  ──────────────────────────────────────────────────────────┐
  │  Gemini LLM loop (max 6 iterations)                                  │
  │  tool: search_products ──► lib/productSearch.js ──► lib/database.js  │
  │  tool: select_product  ──► lib/safety.js                             │
  │  all steps ────────────► lib/audit.js                                │
  └──────────────────────────────────────────────────────────────────────┘
  │  returns AgentResult to route
  ▼
Browser shows product card + safety badge
  │  User clicks "Approve & Pay"
  │  POST /api/payment { action: 'create' }
  ▼
app/api/payment/route.js
  │  calls
  ▼
lib/payment.js ──► Razorpay API ──► lib/database.js (orders table)
                                 ──► lib/audit.js
```

### Data Layer

- Single SQLite file (`db/store.db`) managed by `better-sqlite3`
- Singleton pattern via `globalThis._buyerAgentDb` to survive Next.js hot-reloads
- WAL journal mode + foreign keys enabled at connection time
- Three tables: `products`, `orders`, `audit_log`
- Schema created idempotently with `CREATE TABLE IF NOT EXISTS`
- Safe column migrations via try/catch `ALTER TABLE` statements
- Products seeded once on first run (15 products across 3 categories)

### API Route Conventions

All routes live in `app/api/*/route.js` following Next.js App Router conventions:
- Export named functions `GET` / `POST` matching HTTP methods
- Accept `Request` object, return `Response.json(...)` or `NextResponse.json(...)`
- Errors returned as `{ error: string }` with appropriate HTTP status codes
- Session IDs passed in request body (POST) or query params (GET)

## Architectural Patterns

### LLM Isolation (Security by Design)
The LLM is given only two tool definitions (`search_products`, `select_product`). The Razorpay payment code path exists exclusively in `/api/payment`, which is only reachable via explicit user UI interaction. This is enforced structurally in code, not by prompting.

### Hard Safety Layer
`lib/safety.js` is a pure synchronous validator called both inside the agentic loop (on `select_product`) and before any payment is processed. Its rules are env-configurable but cannot be overridden by the LLM.

### Audit-First Logging
Every significant action (user request, LLM call, tool call, search results, safety check, payment events) is written to `audit_log` before the action completes, providing a complete immutable timeline.

### Service Layer Separation
Business logic is fully isolated in `lib/` modules. API routes are thin — they parse the request, call the appropriate lib function, and return the result. No business logic lives in route files.
