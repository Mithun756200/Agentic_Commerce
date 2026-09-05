/**
 * safety.js — Hard-limit safety validator
 *
 * This function is the ONLY gate between the LLM's decision and the payment service.
 * The LLM cannot override these rules — they are enforced in server-side code.
 *
 * Enforcement is 100% server-side:
 * - Active limits are read dynamically from SQLite `settings` table at validation time.
 * - Client payloads or LLM-suggested limits are NEVER trusted.
 * - Sane environment defaults are used if the database is not yet initialized.
 */

import { getDb } from './database.js';

/**
 * Fetch the active safety limits from the database (persisted settings).
 * Always queries the DB directly so live updates take effect immediately.
 */
export function getActiveSafetyLimits() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    if (row) {
      const allowedCategories = row.allowed_categories
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      return {
        MAX_BUDGET_INR: Number(row.max_budget_inr),
        ALLOWED_CATEGORIES: allowedCategories,
        MAX_QUANTITY: Number(row.max_quantity),
        allowed_categories_raw: row.allowed_categories,
        updated_at: row.updated_at,
      };
    }
  } catch (err) {
    console.warn('[safety.js] Could not read settings from DB, falling back to environment:', err.message);
  }

  // Fallback defaults from environment
  const fallbackCategories = (process.env.ALLOWED_CATEGORIES || 'electronics,accessories,peripherals')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  return {
    MAX_BUDGET_INR: parseInt(process.env.MAX_BUDGET_INR || '5000', 10),
    ALLOWED_CATEGORIES: fallbackCategories,
    MAX_QUANTITY: parseInt(process.env.MAX_QUANTITY || '3', 10),
    allowed_categories_raw: process.env.ALLOWED_CATEGORIES || 'electronics,accessories,peripherals',
    updated_at: null,
  };
}

/**
 * Validates a prospective purchase against active hard limits.
 * ALWAYS reads limits directly from the DB at runtime.
 *
 * @param {object} params
 * @param {number} params.priceInr     - unit price in INR
 * @param {string} params.category     - product category
 * @param {number} params.quantity     - requested quantity
 * @param {number} params.stock        - available stock
 *
 * @returns {{ allowed: boolean, reason: string, limitsApplied: object }}
 */
export function validatePurchase({ priceInr, category, quantity, stock }) {
  const limits = getActiveSafetyLimits();
  const totalAmount = priceInr * quantity;

  if (!limits.ALLOWED_CATEGORIES.includes(category.trim().toLowerCase())) {
    return {
      allowed: false,
      reason: `Category "${category}" is not in the allowed list (${limits.ALLOWED_CATEGORIES.join(', ')}).`,
      limitsApplied: limits,
    };
  }

  if (quantity > limits.MAX_QUANTITY) {
    return {
      allowed: false,
      reason: `Requested quantity (${quantity}) exceeds the maximum allowed (${limits.MAX_QUANTITY}).`,
      limitsApplied: limits,
    };
  }

  if (totalAmount > limits.MAX_BUDGET_INR) {
    return {
      allowed: false,
      reason: `Total amount ₹${totalAmount} exceeds the per-transaction budget limit of ₹${limits.MAX_BUDGET_INR}.`,
      limitsApplied: limits,
    };
  }

  if (quantity > stock) {
    return {
      allowed: false,
      reason: `Insufficient stock. Requested ${quantity} but only ${stock} available.`,
      limitsApplied: limits,
    };
  }

  return {
    allowed: true,
    reason: 'All safety checks passed.',
    limitsApplied: limits,
  };
}

/**
 * Dynamic proxy object for backward compatibility with existing imports.
 * Accessing .MAX_BUDGET_INR, .ALLOWED_CATEGORIES, etc. always gets fresh DB values.
 */
export const SAFETY_CONFIG = {
  get MAX_BUDGET_INR() {
    return getActiveSafetyLimits().MAX_BUDGET_INR;
  },
  get ALLOWED_CATEGORIES() {
    return getActiveSafetyLimits().ALLOWED_CATEGORIES;
  },
  get MAX_QUANTITY() {
    return getActiveSafetyLimits().MAX_QUANTITY;
  },
};
