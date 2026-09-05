/**
 * /api/settings
 *
 * GET  - Read active server-enforced safety limits from SQLite
 * POST - Update safety limits with server-side validation and audit logging
 */

import { NextResponse } from 'next/server';
import { getSettings, updateSettings } from '@/lib/database';
import { getActiveSafetyLimits } from '@/lib/safety';
import { logAction } from '@/lib/audit';

export async function GET() {
  try {
    const limits = getActiveSafetyLimits();
    return NextResponse.json({
      success: true,
      settings: {
        max_budget_inr: limits.MAX_BUDGET_INR,
        allowed_categories: limits.allowed_categories_raw,
        allowed_categories_list: limits.ALLOWED_CATEGORIES,
        max_quantity: limits.MAX_QUANTITY,
        updated_at: limits.updated_at,
      },
    });
  } catch (err) {
    console.error('[/api/settings GET]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    let { max_budget_inr, allowed_categories, max_quantity, sessionId = 'system_settings' } = body;

    // Server-side validation
    const budgetNum = Number(max_budget_inr);
    if (isNaN(budgetNum) || budgetNum < 100 || budgetNum > 1000000) {
      return NextResponse.json(
        { success: false, error: 'Max budget must be a number between ₹100 and ₹10,00,000.' },
        { status: 400 }
      );
    }

    const qtyNum = parseInt(max_quantity, 10);
    if (isNaN(qtyNum) || qtyNum < 1 || qtyNum > 50) {
      return NextResponse.json(
        { success: false, error: 'Max quantity must be an integer between 1 and 50.' },
        { status: 400 }
      );
    }

    if (Array.isArray(allowed_categories)) {
      allowed_categories = allowed_categories.join(',');
    }

    if (typeof allowed_categories !== 'string' || !allowed_categories.trim()) {
      return NextResponse.json(
        { success: false, error: 'At least one allowed category must be specified.' },
        { status: 400 }
      );
    }

    // Clean categories string: comma-separated, trimmed, lowercase
    const cleanedCategories = allowed_categories
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
      .join(',');

    if (!cleanedCategories) {
      return NextResponse.json(
        { success: false, error: 'Allowed categories list cannot be empty.' },
        { status: 400 }
      );
    }

    // Persist to database
    const updated = updateSettings({
      max_budget_inr: Math.round(budgetNum),
      allowed_categories: cleanedCategories,
      max_quantity: qtyNum,
    });

    // Log to audit trail so setting changes are visible in the decision trace and audit log
    logAction({
      sessionId,
      action: 'SETTINGS_UPDATED',
      reasoning: `Safety limits updated: budget ₹${budgetNum}, max qty ${qtyNum}, categories: ${cleanedCategories}`,
      result: 'ok',
      metadata: {
        max_budget_inr: budgetNum,
        max_quantity: qtyNum,
        allowed_categories: cleanedCategories,
      },
    });

    const current = getActiveSafetyLimits();

    return NextResponse.json({
      success: true,
      settings: {
        max_budget_inr: current.MAX_BUDGET_INR,
        allowed_categories: current.allowed_categories_raw,
        allowed_categories_list: current.ALLOWED_CATEGORIES,
        max_quantity: current.MAX_QUANTITY,
        updated_at: current.updated_at,
      },
    });
  } catch (err) {
    console.error('[/api/settings POST]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
