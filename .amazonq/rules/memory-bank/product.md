# Product Overview — AI Buyer Agent

## Purpose & Value Proposition

A full-stack conversational AI shopping agent built for the **Razorpay Agentic Commerce Hackathon**. It demonstrates a safe, auditable, LLM-driven purchase flow where the AI can search and recommend products but **cannot trigger payments** — that gate is exclusively controlled by explicit user approval in the UI.

The core value is showing how agentic AI can be integrated into e-commerce with hard safety guardrails that the LLM cannot bypass, combined with a complete audit trail of every decision.

## Key Features & Capabilities

### AI Agent
- Conversational product discovery powered by **Gemini 2.0 Flash** via `@google/genai` SDK
- Agentic loop with two LLM-callable tools: `search_products` and `select_product`
- Word-by-word keyword matching across product name and key_features fields
- Category fallback: if a category-filtered search returns zero results, automatically retries without the category filter
- Per-call LLM timeout (20s) with graceful error messaging
- Multi-turn conversation history support

### Safety Layer (Hard-Coded, LLM-Bypass-Proof)
- Max budget per transaction: ₹5,000 (env-configurable)
- Allowed categories: electronics, accessories, peripherals (env-configurable)
- Max quantity per order: 3 (env-configurable)
- Stock availability check
- Safety result displayed to user before any approval is possible

### Payment Integration (Razorpay TEST mode)
- Razorpay order created only after explicit user approval click
- DB order record inserted before Razorpay API call (no orphan orders)
- Server-side HMAC-SHA256 signature verification before marking any order as paid
- Stock decremented atomically on confirmed payment
- 2-day cancellation window with stock restoration on cancel
- Deliberate failure simulation for demo purposes
- Checkout-dismissed state (distinct from payment failure)

### Audit Trail
- Every agent action logged to SQLite `audit_log` table with session ID, timestamp, action type, reasoning, result, and JSON metadata
- `/dashboard` page with grouped timeline view, stats, filtering, and auto-refresh
- `GET /api/audit` endpoint for log retrieval

### Frontend
- Dark glassmorphism design with purple/violet palette
- Quick search chips in sidebar
- Safety limits panel visible to user
- Product card with AI explanation, meta grid, safety badge
- Success/failure confirmation cards
- Auto-scroll, typing indicator, Enter-to-send

## Target Users & Use Cases

- **Hackathon judges / evaluators**: Demonstrates responsible agentic AI commerce with Razorpay integration
- **Developers**: Reference implementation for LLM tool-calling with hard safety layers and payment gating
- **Demo audiences**: End-to-end flow from natural language query → AI recommendation → safety check → payment → audit trail

## Demo Flow

1. User types: "gaming mouse under ₹2000, wireless"
2. Agent calls `search_products` → reviews catalog results
3. Agent calls `select_product` with best match + explanation
4. Safety validator runs (hard-coded, not LLM-controlled)
5. User clicks "Approve & Pay" (explicit gate)
6. Razorpay TEST order created → payment confirmed
7. `/dashboard` shows full audit trail of every step
