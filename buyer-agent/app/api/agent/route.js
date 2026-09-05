/**
 * POST /api/agent
 * Body: { message: string, sessionId: string, history?: Array<{role,content}> }
 * Returns: AgentResult (see lib/agent.js)
 */

import { NextResponse } from 'next/server';
import { runAgent, sanitizeInput, is503Unavailable } from '@/lib/agent';

export async function POST(request) {
  try {
    const body = await request.json();
    const { message, sessionId, history = [], simulate503, backoffBaseMs, maxBudgetMs, simulateSlowMs } = body;

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'sessionId is required' },
        { status: 400 }
      );
    }

    const sanity = sanitizeInput(message);
    if (!sanity.ok) {
      return NextResponse.json(
        { success: false, error: sanity.error },
        { status: 400 }
      );
    }

    const result = await runAgent({
      userMessage: sanity.value,
      sessionId,
      history,
      simulate503,
      backoffBaseMs,
      maxBudgetMs,
      simulateSlowMs,
    });

    const isError = result.type === 'error' || !!result.errorState;
    return NextResponse.json({ success: !isError, ...result });
  } catch (err) {
    console.error('[/api/agent]', err);

    // Explicit handling for Gemini 503 UNAVAILABLE / LLM_UNAVAILABLE
    if (err.code === 'LLM_UNAVAILABLE' || is503Unavailable(err)) {
      return NextResponse.json(
        {
          success: false,
          type: 'error',
          errorState: 'LLM_UNAVAILABLE',
          text: 'the AI service is temporarily overloaded, please try again',
          error: 'the AI service is temporarily overloaded, please try again',
        },
        { status: 200 }
      );
    }

    // Explicit handling for LLM timeout
    if (err.code === 'LLM_TIMEOUT') {
      return NextResponse.json(
        {
          success: false,
          type: 'error',
          errorState: 'LLM_TIMEOUT',
          text: 'The AI is taking longer than expected — please try again.',
          error: 'The AI is taking longer than expected — please try again.',
        },
        { status: 200 }
      );
    }

    // Gracefully handle Gemini API rate limits (429) — don't expose as 500
    if (err?.status === 429) {
      // Extract retry delay from error details if available
      const retryMatch = err?.message?.match(/retry in (\d+)/i);
      const retrySeconds = retryMatch ? parseInt(retryMatch[1], 10) : 60;

      return NextResponse.json(
        {
          success: true, // send as success so the UI renders it as a chat message, not a crash
          type: 'text',
          text: `⚠️ **Rate limit reached** — the Gemini free tier allows a limited number of requests per day.\n\nPlease wait about **${retrySeconds} seconds** and try again, or upgrade your Gemini API plan at https://ai.dev/rate-limit.`,
        },
        { status: 200 }
      );
    }

    return NextResponse.json({ success: false, error: err.message, type: 'error' }, { status: 500 });
  }
}
