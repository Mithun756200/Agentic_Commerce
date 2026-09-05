/**
 * agent.js — AI Buyer Agent orchestrator
 *
 * Uses the new @google/genai SDK (v1.x) for compatibility with
 * gemini-2.0-flash and newer Gemini models.
 *
 * Architecture (enforced in code, NOT by prompting):
 *   User message
 *     → LLM reasoning (Gemini)
 *     → structured tool call (searchProducts / select_product)
 *     → safety validator (validatePurchase)
 *     → approval gate (UI click)
 *     → payment service (createOrder / confirmPayment)
 *
 * The LLM NEVER receives a function to call Razorpay.
 */

import { GoogleGenAI, Type } from '@google/genai';
import { searchProducts } from './productSearch.js';
import { validatePurchase, SAFETY_CONFIG, getActiveSafetyLimits } from './safety.js';
import { getRecommendationForProduct } from './recommendations.js';

import { logAction } from './audit.js';

/** Max characters accepted from the user before the LLM is ever invoked. */
const MAX_INPUT_LENGTH = 300;

/**
 * Sanitize and validate a raw user message before it reaches the LLM or DB.
 *
 * @param {string} raw - the raw input string from the request body
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function sanitizeInput(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Message must be a string.' };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: 'Message cannot be empty.' };
  }

  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: `Message too long — please keep it under ${MAX_INPUT_LENGTH} characters.` };
  }

  // Reject obvious script-injection / prompt-injection patterns
  const BLOCKED_PATTERNS = [
    /<script[\s\S]*?>/i,          // XSS script tags
    /javascript\s*:/i,            // javascript: URIs
    /on\w+\s*=/i,                 // inline event handlers (onerror=, onload=, …)
    /ignore\s+(all\s+)?(previous|above|prior|earlier)\s+instructions/i, // prompt injection
    /disregard\s+(all\s+)?(previous|above|prior)\s+instructions/i, // prompt injection variant
    /system\s*prompt/i,           // prompt injection
    /you\s+are\s+now\s+(a|an|the)?/i, // role-hijack attempts
    /act\s+as\s+(a|an|the)?\s+\w+\s+(without|with\s+no)\s+(restriction|limit|filter)/i, // jailbreak
    /\bDROP\s+TABLE\b/i,          // SQL injection
    /\bUNION\s+SELECT\b/i,        // SQL injection
    /\bEXEC(UTE)?\s*\(/i,         // SQL stored procedure injection
  ];


  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, error: 'Message contains disallowed content.' };
    }
  }

  // Strip null bytes and non-printable control characters (keep newlines/tabs)
  const cleaned = trimmed.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  if (cleaned.length === 0) {
    return { ok: false, error: 'Message contains no readable content.' };
  }

  return { ok: true, value: cleaned };
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

/** Timeout (ms) applied to each individual LLM call inside the agentic loop. */
const LLM_TIMEOUT_MS = 30_000;

/** Max retry attempts on Gemini 503 UNAVAILABLE responses. */
export const MAX_503_RETRIES = 3;

/** Base delay for exponential backoff: 1s, 2s, 4s (1000ms, 2000ms, 4000ms). */
export const BASE_503_BACKOFF_MS = 1000;

/** Hard outer time budget across all retry attempts and backoff combined (45s). */
export const TOTAL_LLM_BUDGET_MS = 45_000;

/**
 * Safely extracts requested quantity from user message without confusing
 * price constraints (e.g. "under 500", "budget 2000", "<₹3000") with quantities.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function extractRequestedQuantity(text) {
  if (!text || typeof text !== 'string') return null;

  // Strip price language first so price numbers are never parsed as quantities
  const withoutPrices = text
    .replace(/(?:under|below|less\s+than|upto|within|budget\s+(?:of\s+)?|max(?:imum)?\s+(?:price\s+)?(?:of\s+)?|at|around)\s*(?:₹|rs\.?|inr)?\s*\d+/gi, '')
    .replace(/(?:₹|rs\.?|inr)\s*\d+/gi, '')
    .replace(/\b\d+\s*(?:rs|rupees?|inr|bucks?)\b/gi, '');

  // 1. Explicit unit suffix: "5 units", "3 pieces", "2 pcs", "10 items", "4 nos"
  const suffixMatch = withoutPrices.match(/\b(\d+)\s*(?:units?|pieces?|pcs?|items?|nos?\.?)\b/i);
  if (suffixMatch) {
    const q = parseInt(suffixMatch[1], 10);
    return q > 1 ? q : null;
  }

  // 2. Explicit quantity prefix: "qty: 5", "qty 5", "quantity 3", "quantity: 3"
  const prefixMatch = withoutPrices.match(/\b(?:qty|quantity)\s*[:=]?\s*(\d+)\b/i);
  if (prefixMatch) {
    const q = parseInt(prefixMatch[1], 10);
    return q > 1 ? q : null;
  }

  // 3. Command style: "buy 5 of ...", "order 3 ...", "send 2 ..."
  const verbMatch = withoutPrices.match(/\b(?:buy|order|purchase|send|get)\s+(\d+)\s+(?:of\s+)?/i);
  if (verbMatch) {
    const q = parseInt(verbMatch[1], 10);
    return q > 1 ? q : null;
  }

  return null;
}

/**
 * Checks if an error corresponds to Gemini 503 UNAVAILABLE / overloaded service.
 */
export function is503Unavailable(err) {
  if (!err) return false;
  return (
    err.status === 503 ||
    err.statusCode === 503 ||
    err.code === 503 ||
    err.code === '503' ||
    err.code === 'UNAVAILABLE' ||
    err.error?.code === 503 ||
    err.error?.status === 'UNAVAILABLE' ||
    (typeof err.message === 'string' &&
      (err.message.includes('503') ||
        err.message.toUpperCase().includes('UNAVAILABLE') ||
        err.message.toLowerCase().includes('service unavailable') ||
        err.message.toLowerCase().includes('overloaded')))
  );
}

/**
 * Wraps ai.models.generateContent() with a hard per-call timeout.
 * Throws an error with code 'LLM_TIMEOUT' if the SDK doesn't respond in time.
 */
async function generateContentWithTimeout(params, timeoutMs = LLM_TIMEOUT_MS) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error('LLM call timed out');
      err.code = 'LLM_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      ai.models.generateContent(params),
      timeoutPromise,
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Executes an LLM call with explicit 503 UNAVAILABLE handling, bounded by a total
 * outer time budget across all attempts and backoff combined (default 45s).
 */
export async function generateContentWithRetryAndTimeout(
  params,
  {
    sessionId,
    iteration = 0,
    simulate503 = null,
    backoffBaseMs = BASE_503_BACKOFF_MS,
    maxBudgetMs = TOTAL_LLM_BUDGET_MS,
    simulateSlowMs = null,
  } = {}
) {
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingBudget = maxBudgetMs - elapsed;

    // Check if outer time budget is already exhausted before starting another attempt
    if (remainingBudget <= 0) {
      if (sessionId) {
        logAction({
          sessionId,
          action: 'LLM_UNAVAILABLE',
          reasoning: `Gemini API outer time budget (${maxBudgetMs / 1000}s) exhausted during 503 retry cycle (elapsed: ${(elapsed / 1000).toFixed(1)}s). Service temporarily overloaded.`,
          result: 'unavailable',
          metadata: {
            attemptsMade: attempt,
            elapsedMs: elapsed,
            maxBudgetMs,
            statusCode: 503,
            iteration,
          },
        });
      }
      const unavailErr = new Error('the AI service is temporarily overloaded, please try again');
      unavailErr.code = 'LLM_UNAVAILABLE';
      unavailErr.status = 503;
      throw unavailErr;
    }

    // Call timeout is the minimum of individual call timeout and remaining outer budget
    const callTimeoutMs = Math.min(LLM_TIMEOUT_MS, remainingBudget);

    try {
      if (simulateSlowMs) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(simulateSlowMs, remainingBudget)));
      }

      // Simulation hook for automated testing / verification
      if (simulate503) {
        if (typeof simulate503 === 'number') {
          if (attempt < simulate503) {
            const simErr = new Error('503 Service Unavailable: The model is overloaded. Please try again later.');
            simErr.status = 503;
            simErr.code = 'UNAVAILABLE';
            throw simErr;
          }
        } else if (typeof simulate503 === 'object' && simulate503 !== null) {
          const failCount = simulate503.failCount !== undefined ? simulate503.failCount : 1;
          if (attempt < failCount) {
            const simErr = new Error('503 Service Unavailable: The model is overloaded. Please try again later.');
            simErr.status = 503;
            simErr.code = 'UNAVAILABLE';
            throw simErr;
          }
          if (simulate503.mockSuccess) {
            return {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Recovered successfully from transient 503 overload.' }],
                  },
                },
              ],
            };
          }
        } else if (simulate503 === true || simulate503 === 'always') {
          const simErr = new Error('503 Service Unavailable: The model is overloaded. Please try again later.');
          simErr.status = 503;
          simErr.code = 'UNAVAILABLE';
          throw simErr;
        }
      }

      return await generateContentWithTimeout(params, callTimeoutMs);
    } catch (err) {
      if (is503Unavailable(err)) {
        if (attempt < MAX_503_RETRIES) {
          attempt++;
          // Exponential backoff: 1s, 2s, 4s
          const delayMs = backoffBaseMs * Math.pow(2, attempt - 1);
          const totalElapsedSoFar = Date.now() - startTime;

          // If the required backoff delay would exceed the outer budget,
          // conclude retries immediately with LLM_UNAVAILABLE
          if (totalElapsedSoFar + delayMs >= maxBudgetMs) {
            console.warn(`[lib/agent] Outer budget (${maxBudgetMs}ms) would be exceeded by backoff (${delayMs}ms). Exhausting retries to LLM_UNAVAILABLE.`);
            if (sessionId) {
              logAction({
                sessionId,
                action: 'LLM_UNAVAILABLE',
                reasoning: `Gemini API 503 retry budget exceeded (${(totalElapsedSoFar / 1000).toFixed(1)}s elapsed, required backoff: ${delayMs}ms, budget: ${maxBudgetMs / 1000}s).`,
                result: 'unavailable',
                metadata: {
                  attempt,
                  elapsedMs: totalElapsedSoFar,
                  maxBudgetMs,
                  statusCode: 503,
                  iteration,
                },
              });
            }
            const unavailErr = new Error('the AI service is temporarily overloaded, please try again');
            unavailErr.code = 'LLM_UNAVAILABLE';
            unavailErr.status = 503;
            unavailErr.originalError = err;
            throw unavailErr;
          }

          if (sessionId) {
            logAction({
              sessionId,
              action: 'LLM_RETRY',
              reasoning: `Gemini API 503 UNAVAILABLE on attempt ${attempt}/${MAX_503_RETRIES}. Retrying in ${delayMs / 1000}s with exponential backoff...`,
              result: 'retry',
              metadata: {
                attempt,
                maxRetries: MAX_503_RETRIES,
                delayMs,
                iteration,
                statusCode: 503,
                error: err.message,
                remainingBudgetMs: maxBudgetMs - (Date.now() - startTime),
              },
            });
          }

          console.warn(`[lib/agent] Gemini 503 UNAVAILABLE (attempt ${attempt}/${MAX_503_RETRIES}). Waiting ${delayMs}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        } else {
          // All 3 retries exhausted
          if (sessionId) {
            logAction({
              sessionId,
              action: 'LLM_UNAVAILABLE',
              reasoning: `Gemini API 503 UNAVAILABLE: all ${MAX_503_RETRIES} retries exhausted. Service temporarily overloaded.`,
              result: 'unavailable',
              metadata: {
                retriesExhausted: MAX_503_RETRIES,
                statusCode: 503,
                error: err.message,
                iteration,
                totalElapsedMs: Date.now() - startTime,
              },
            });
          }

          const unavailErr = new Error('the AI service is temporarily overloaded, please try again');
          unavailErr.code = 'LLM_UNAVAILABLE';
          unavailErr.status = 503;
          unavailErr.originalError = err;
          throw unavailErr;
        }
      }

      // If call timed out because callTimeoutMs expired:
      if (err.code === 'LLM_TIMEOUT') {
        const totalElapsed = Date.now() - startTime;
        // If we timed out because the outer budget was reached during retries,
        // and we had previously encountered 503s in this cycle:
        if (attempt > 0 || totalElapsed >= maxBudgetMs - 1000) {
          const unavailErr = new Error('the AI service is temporarily overloaded, please try again');
          unavailErr.code = 'LLM_UNAVAILABLE';
          unavailErr.status = 503;
          unavailErr.originalError = err;
          throw unavailErr;
        }
      }

      // Re-throw timeouts and other errors directly
      throw err;
    }
  }
}

// ─── Tool definitions the LLM can call ────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_products',
    description: "Search the product catalog. Call this to find products matching the user's request.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Keyword to match against product name and features (e.g. "wireless", "gaming")',
        },
        category: {
          type: Type.STRING,
          description:
            'Product category filter. Use "electronics" for mice, headphones, and earbuds. ' +
            'Use "accessories" for chargers, cables, hubs, and portable drives. ' +
            'Use "peripherals" for keyboards only. Omit if unsure.',
        },
        maxPrice: {
          type: Type.NUMBER,
          description: 'Maximum price in INR',
        },
      },
    },
  },
  {
    name: 'select_product',
    description: 'Select the best product and explain the choice. Call this after reviewing search results.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        productId: {
          type: Type.NUMBER,
          description: 'The id of the chosen product',
        },
        quantity: {
          type: Type.NUMBER,
          description: 'How many units to purchase (default 1)',
        },
        explanation: {
          type: Type.STRING,
          description:
            'A clear, human-readable explanation of why this product was chosen (price, features, rating, stock)',
        },
      },
      required: ['productId', 'quantity', 'explanation'],
    },
  },
];

/**
 * Run the agent for one user message turn.
 *
 * @param {object}   params
 * @param {string}   params.userMessage
 * @param {string}   params.sessionId
 * @param {Array}    [params.history]     - prior chat messages [{role, content}]
 *
 * @returns {Promise<AgentResult>}
 */
export async function runAgent({
  userMessage,
  sessionId,
  history = [],
  simulate503 = null,
  backoffBaseMs = BASE_503_BACKOFF_MS,
  maxBudgetMs = TOTAL_LLM_BUDGET_MS,
  simulateSlowMs = null,
}) {
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  // Log the user request
  logAction({
    sessionId,
    action: 'USER_REQUEST',
    reasoning: userMessage,
    result: 'received',
    metadata: { messageLength: userMessage.length },
  });

  logAction({
    sessionId,
    action: 'LLM_CALL',
    reasoning: 'Sending user message to Gemini for tool-call reasoning',
    result: 'in_progress',
    metadata: { model: GEMINI_MODEL },
  });

  // Build conversation history for the new SDK format
  // History must start with a 'user' role message
  const safeHistory = buildSafeHistory(history);

  // Append the current user message to history
  const contents = [
    ...safeHistory,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  let searchResults = [];
  let selectedProduct = null;
  let selectedQuantity = 1;
  let selectionExplanation = '';
  // Extract quantity user originally asked for (e.g. "5 units", "3 pieces", "qty 5") without conflating price
  let requestedQuantity = extractRequestedQuantity(userMessage);

  // ── Agentic loop ──────────────────────────────────────────────────────────────
  for (let iteration = 0; iteration < 6; iteration++) {
    let response;
    try {
      response = await generateContentWithRetryAndTimeout(
        {
          model: GEMINI_MODEL,
          contents,
          config: {
            tools: [{ functionDeclarations: TOOLS }],
            systemInstruction: buildSystemPrompt(),
            generationConfig: { maxOutputTokens: 512 },
          },
        },
        {
          sessionId,
          iteration,
          simulate503,
          backoffBaseMs,
          maxBudgetMs,
          simulateSlowMs,
        }
      );
    } catch (err) {
      // ── Per-iteration timeout — fail fast, don't silently hang ────────────
      if (err.code === 'LLM_TIMEOUT') {
        logAction({
          sessionId,
          action: 'LLM_TIMEOUT',
          reasoning: `LLM call timed out after ${LLM_TIMEOUT_MS / 1000}s on iteration ${iteration}`,
          result: 'timeout',
          metadata: { iteration, timeoutMs: LLM_TIMEOUT_MS },
        });
        return {
          type: 'error',
          errorState: 'LLM_TIMEOUT',
          text: 'The AI is taking longer than expected — please try again.',
          error: 'The AI is taking longer than expected — please try again.',
          searchResults,
        };
      }

      // ── 503 UNAVAILABLE — all retries exhausted ──────────────────────────
      if (err.code === 'LLM_UNAVAILABLE' || is503Unavailable(err)) {
        return {
          type: 'error',
          errorState: 'LLM_UNAVAILABLE',
          text: 'the AI service is temporarily overloaded, please try again',
          error: 'the AI service is temporarily overloaded, please try again',
          searchResults,
        };
      }

      // Re-throw unexpected errors so the API route can handle them
      throw err;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];

    // Check for text-only response (final answer)
    const textParts = parts.filter((p) => p.text);
    const fnCallParts = parts.filter((p) => p.functionCall);

    if (fnCallParts.length === 0) {
      // No more tool calls — extract final text and break
      const finalText = textParts.map((p) => p.text).join('') || "I couldn't process that request.";

      logAction({
        sessionId,
        action: 'LLM_RESPONSE',
        reasoning: 'Final LLM text response generated',
        result: 'ok',
        metadata: { responseLength: finalText.length, hasSelection: !!selectedProduct },
      });

      if (selectedProduct) {
        const safetyResult = validatePurchase({
          priceInr: selectedProduct.price,
          category: selectedProduct.category,
          quantity: selectedQuantity,
          stock: selectedProduct.stock,
        });

        let recommendation = null;
        if (safetyResult.allowed) {
          recommendation = getRecommendationForProduct(selectedProduct.id, sessionId);
          if (recommendation) {
            logAction({
              sessionId,
              action: 'RECOMMENDATION_SHOWN',
              reasoning: `Suggested add-on: "${recommendation.addon.name}" for ₹${recommendation.addon.price} — ${recommendation.reason}`,
              result: 'shown',
              metadata: {
                primaryProductId: selectedProduct.id,
                addonProductId: recommendation.addon.id,
                addonPrice: recommendation.addon.price,
                reason: recommendation.reason,
              },
            });
          }
        }

        return {
          type: 'product_selection',
          text: finalText,
          product: selectedProduct,
          quantity: selectedQuantity,
          requestedQuantity: requestedQuantity,
          explanation: selectionExplanation,
          safetyCheck: safetyResult,
          searchResults,
          recommendation,
        };
      }

      return { type: 'message', text: finalText, searchResults };
    }

    // Add the model's response (with function calls) to contents
    contents.push({ role: 'model', parts });

    // ── Process each tool call ─────────────────────────────────────────────────
    const functionResponseParts = [];

    for (const part of fnCallParts) {
      const { name, args } = part.functionCall;
      let toolResult;

      if (name === 'search_products') {
        logAction({
          sessionId,
          action: 'TOOL_CALL_SEARCH',
          reasoning: `Searching catalog with: ${JSON.stringify(args)}`,
          result: 'in_progress',
          metadata: args,
        });

        const results = searchProducts({
          query: args.query || '',
          category: args.category || '',
          maxPrice: args.maxPrice || Infinity,
          limit: 8,
          sessionId,
        });

        searchResults = results;

        logAction({
          sessionId,
          action: 'SEARCH_RESULTS',
          reasoning: `Found ${results.length} matching products`,
          result: results.length > 0 ? 'ok' : 'no_results',
          metadata: {
            count: results.length,
            products: results.map((p) => ({ id: p.id, name: p.name, price: p.price })),
          },
        });

        toolResult = {
          products: results.map((p) => ({
            id: p.id,
            name: p.name,
            price: p.price,
            stock: p.stock,
            category: p.category,
            key_features: p.key_features,
            rating: p.rating,
          })),
          count: results.length,
        };
      } else if (name === 'select_product') {
        const product = searchResults.find((p) => p.id === args.productId);

        logAction({
          sessionId,
          action: 'AGENT_SELECTION',
          reasoning: args.explanation,
          result: product ? 'ok' : 'product_not_found',
          metadata: { productId: args.productId, quantity: args.quantity },
        });

        if (product) {
          selectedProduct = product;
          selectedQuantity = args.quantity || 1;
          selectionExplanation = args.explanation;

          const safetyResult = validatePurchase({
            priceInr: product.price,
            category: product.category,
            quantity: selectedQuantity,
            stock: product.stock,
          });

          logAction({
            sessionId,
            action: 'SAFETY_CHECK',
            reasoning: safetyResult.reason,
            result: safetyResult.allowed ? 'passed' : 'blocked',
            metadata: {
              productId: product.id,
              priceInr: product.price,
              category: product.category,
              quantity: selectedQuantity,
              totalAmount: product.price * selectedQuantity,
              safetyConfig: SAFETY_CONFIG,
            },
          });

          toolResult = {
            selected: true,
            productId: product.id,
            safetyPassed: safetyResult.allowed,
            safetyReason: safetyResult.reason,
          };
        } else {
          toolResult = { selected: false, error: 'Product not found in search results' };
        }
      }

      functionResponseParts.push({
        functionResponse: {
          name,
          response: toolResult,
        },
      });
    }

    // Add tool results to contents for next iteration
    contents.push({ role: 'user', parts: functionResponseParts });
  }

  // Fallback if loop exits without a clean text response
  return {
    type: 'message',
    text: "I've finished processing your request. Please check the product selection above.",
    searchResults,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSafeHistory(history) {
  const mapped = history
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

  // Gemini requires history to start with a user message
  let start = 0;
  while (start < mapped.length && mapped[start].role !== 'user') start++;
  const trimmed = mapped.slice(start);

  // Ensure alternating roles: user, model, user, model...
  const alternated = [];
  for (const msg of trimmed) {
    if (alternated.length === 0) {
      if (msg.role === 'user') alternated.push(msg);
    } else {
      const last = alternated[alternated.length - 1];
      if (last.role === msg.role) {
        // If two consecutive messages have the same role, merge their text into one turn
        last.parts[0].text += `\n${msg.parts[0].text}`;
      } else {
        alternated.push(msg);
      }
    }
  }

  // Because the current user message will be appended with role 'user',
  // safeHistory must end with a 'model' message if it's not empty.
  if (alternated.length > 0 && alternated[alternated.length - 1].role === 'user') {
    alternated.pop();
  }

  return alternated;
}

function buildSystemPrompt() {
  return `You are an AI Buyer Agent for an e-commerce platform. Your job is to help users find and buy products.

WORKFLOW (follow this strictly):
1. When a user describes what they want to buy, ALWAYS call search_products first with relevant filters. Focus on the user's latest request. If earlier conversation turns mention a previously searched, selected, or purchased product, treat the user's new message as a fresh, independent request. Do NOT combine earlier product keywords with the new request unless the user explicitly asks to combine them (e.g. "also buy", "both", "add a ... as well").
2. Review the search results carefully.
3. If results are found, you MUST call select_product with the single best matching product and an explanation. Do NOT just list products in text — call select_product. Always call select_product even if the product exceeds the user's budget or belongs to a restricted category (e.g. furniture), so that our server-side safety engine can formally inspect the item, log the check to the audit trail, and enforce guardrails.
4. If no results are found at all, tell the user politely and suggest broadening the search.

CATEGORY GUIDE (important — use these exact values or omit the category):
- "electronics"  → mice (wired or wireless), headphones, earbuds
- "accessories"  → chargers, cables (USB-C etc.), hubs, portable hard drives
- "peripherals"  → keyboards ONLY
- If you are unsure which category a product belongs to, DO NOT pass a category filter — let the search run without it.

RULES:
- Be helpful, concise, and conversational.
- Always explain your selection clearly so the user can make an informed decision.
- NEVER make up products that aren't in the search results.
- After selecting a product, the user will be asked for approval before any payment is processed.

SAFETY LIMITS (inform users if relevant):
- Max budget per transaction: ₹${SAFETY_CONFIG.MAX_BUDGET_INR}
- Allowed categories: ${SAFETY_CONFIG.ALLOWED_CATEGORIES.join(', ')}
- Max quantity per order: ${SAFETY_CONFIG.MAX_QUANTITY}`;
}
