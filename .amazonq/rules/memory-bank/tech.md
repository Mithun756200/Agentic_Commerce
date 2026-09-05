# Technology Stack — AI Buyer Agent

## Runtime & Framework

| Technology | Version | Role |
|---|---|---|
| Node.js | (LTS implied) | Server runtime |
| Next.js | 16.3.3 | Full-stack framework (App Router) |
| React | 19.2.8 | UI library |
| React DOM | 19.2.8 | DOM renderer |

## Programming Language

- **JavaScript (ES Modules)** — entire codebase uses ESM (`import`/`export`)
- No TypeScript; `jsconfig.json` provides path alias `@/*` → project root
- JSDoc used for function signatures and parameter documentation

## Key Dependencies

### AI / LLM
- `@google/genai` ^2.19.0 — primary Gemini SDK (`GoogleGenAI`, `Type` from `@google/genai`)
- `@google/generative-ai` ^0.24.1 — legacy SDK (present but primary code uses `@google/genai`)
- Model used: `gemini-3.5-flash-lite` (referenced in agent.js)

### Database
- `better-sqlite3` ^13.0.3 — synchronous SQLite bindings (native module)
- Configured as `serverExternalPackages` in `next.config.mjs` to prevent bundling

### Payments
- `razorpay` ^2.9.8 — Razorpay Node.js SDK for order creation
- `crypto` (Node built-in) — HMAC-SHA256 signature verification

### Utilities
- `uuid` ^14.0.2 — session ID generation

## Dev Dependencies

- `eslint` ^9 — linting
- `eslint-config-next` 16.3.3 — Next.js ESLint rules (core-web-vitals preset)
- ESLint flat config format (`eslint.config.mjs`)

## Database

- **SQLite** via `better-sqlite3` (synchronous API)
- File location: `db/store.db` (auto-created on first run)
- WAL journal mode enabled
- Foreign keys enforced
- Three tables: `products`, `orders`, `audit_log`

## Environment Variables

```env
# Required
GEMINI_API_KEY=your_gemini_api_key_here
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_test_secret

# Optional (these are the defaults)
MAX_BUDGET_INR=5000
ALLOWED_CATEGORIES=electronics,accessories,peripherals
MAX_QUANTITY=3
```

## Development Commands

```bash
# Install dependencies
cd buyer-agent
npm install

# Start dev server (http://localhost:3000)
npm run dev

# Production build
npm run build

# Start production server
npm start

# Lint
npm run lint
```

## Build Configuration

`next.config.mjs`:
```js
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],  // prevents native module bundling
};
```

`jsconfig.json`:
```json
{
  "compilerOptions": {
    "paths": { "@/*": ["./*"] }
  }
}
```

## External Services

| Service | Purpose | Mode |
|---|---|---|
| Google AI Studio (Gemini) | LLM reasoning + tool calling | Production API |
| Razorpay | Payment order creation & verification | TEST mode only |

## Architecture Notes

- Next.js App Router with server components and API routes
- All `lib/` modules run server-side only (SQLite, Razorpay, Gemini calls)
- `globalThis._buyerAgentDb` singleton pattern prevents multiple DB connections during Next.js hot-reload in dev
- No ORM — raw SQL via `better-sqlite3` prepared statements
