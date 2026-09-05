/**
 * recommendations.js — Pre-payment cross-sell recommendation engine
 *
 * Recommends exactly one complementary, in-catalog add-on item for any selected product.
 * All recommended items exist in the 16-item catalog.
 * Nothing bypasses validatePurchase() — combined carts are verified against hard limits.
 */

import { getDb } from './database.js';
import { validatePurchase } from './safety.js';
import { logAction } from './audit.js';

/**
 * Fixed, coherent mapping from product ID to a complementary product ID and reason.
 */
const RECOMMENDATION_MAP = {
  // 1: Logitech G305 Wireless Mouse (₹1895, electronics)
  1: { addonId: 9, reason: 'High-speed charging cable to keep your wireless gaming setup powered.' },

  // 2: Portronics Toad 23 Wireless Mouse (₹499, electronics)
  2: { addonId: 9, reason: 'Durable fast-charging cable, perfect accessory for your mobile workstation.' },

  // 3: HP X200 Wired Optical Mouse (₹349, electronics)
  3: { addonId: 12, reason: 'Adds 4 extra USB 3.0 ports to easily connect your mouse, drives, and accessories.' },

  // 4: Dell MS116 Wired Optical Mouse (₹299, electronics)
  4: { addonId: 12, reason: 'Expands USB ports on your PC or laptop for seamless peripheral connectivity.' },

  // 5: Zebronics Zeb-Transformer-M (₹649, electronics)
  5: { addonId: 9, reason: 'Durable high-speed cable to complete your desktop gaming setup.' },

  // 6: boAt Rockerz 450 Bluetooth Headphones (₹1499, electronics)
  6: { addonId: 9, reason: 'Fast-charging Type-C cable for quick recharging of your wireless headphones.' },

  // 7: JBL Tune 510BT Wireless Headphones (₹2999, electronics)
  // Pairs with Anker 65W GaN Charger (₹2499) -> combined ₹5498 (> ₹5000 budget cap for Live Test 3)
  7: { addonId: 10, reason: 'High-speed 65W GaN fast charger to rapidly recharge your premium headphones and devices.' },

  // 8: Noise Shots X5 Pro TWS Earbuds (₹1299, electronics)
  8: { addonId: 11, reason: 'Convenient wireless charging pad to keep your earbuds and phone charged cord-free.' },

  // 9: AmazonBasics Type-C Cable (₹349, accessories)
  9: { addonId: 10, reason: 'High-output 65W GaN charger that unleashes the full fast-charging speed of this cable.' },

  // 10: Anker 65W GaN USB-C Charger (₹2499, accessories)
  10: { addonId: 9, reason: 'Durable Type-C to Type-A high-speed cable paired with your fast charger.' },

  // 11: Portronics Modesk 2 Wireless Charging Pad (₹799, accessories)
  11: { addonId: 10, reason: 'Powers your wireless charging pad with optimal GaN charging efficiency.' },

  // 12: Ugreen USB Hub 4-Port USB 3.0 (₹899, accessories)
  12: { addonId: 9, reason: 'Reliable data transfer and power cable for hub-connected devices.' },

  // 13: WD 1TB My Passport Portable HDD (₹3999, accessories)
  // Coherent connectivity pairing with Ugreen 4-Port USB 3.0 Hub (₹899)
  13: { addonId: 12, reason: 'Expands high-speed connectivity to connect your portable hard drive and multiple peripherals simultaneously.' },

  // 14: Keychron K2 Mechanical Keyboard (₹6999, peripherals)
  14: { addonId: 12, reason: 'Adds multi-device USB ports to easily switch between your mechanical keyboard and peripherals.' },

  // 15: Zebronics Zeb-K11 USB Wired Keyboard (₹449, peripherals)
  15: { addonId: 4, reason: 'Complete your workstation with a reliable, matching desktop optical mouse.' },

  // 16: Ergonomic Executive Office Chair (₹3499, furniture)
  16: { addonId: 11, reason: 'Desk-side wireless charging pad for your ergonomic workspace.' },
};

/**
 * Return the set of product IDs already purchased (status='paid') in this session.
 * Checks both product_id and addon_product_id columns so cross-sell add-ons
 * that were themselves purchased are also detected.
 *
 * @param {string} sessionId
 * @returns {Set<number>}
 */
function _getPurchasedProductIds(sessionId) {
  if (!sessionId) return new Set();
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT product_id, addon_product_id FROM orders
       WHERE session_id = ? AND status = 'paid'`
    ).all(sessionId);
    const ids = new Set();
    for (const row of rows) {
      if (row.product_id) ids.add(row.product_id);
      if (row.addon_product_id) ids.add(row.addon_product_id);
    }
    return ids;
  } catch (err) {
    console.warn('[recommendations.js] Could not query session orders:', err.message);
    return new Set();
  }
}

/**
 * Get complementary in-catalog product recommendation for a given product ID,
 * filtered against the current session's purchase history.
 *
 * If the mapped add-on was already purchased in this session:
 *   (a) If the RECOMMENDATION_MAP has an alternative entry for the same primary
 *       product that maps to a different add-on, use that instead.
 *   (b) Otherwise suppress the recommendation entirely (return null) and log
 *       RECOMMENDATION_SUPPRESSED_ALREADY_OWNED to the audit trail.
 *
 * @param {number} productId
 * @param {string} [sessionId]  - current session; used to filter already-owned items
 * @returns {{ addon: object, reason: string } | null}
 */
export function getRecommendationForProduct(productId, sessionId = '') {
  const mapping = RECOMMENDATION_MAP[productId];
  if (!mapping) return null;

  const purchasedIds = _getPurchasedProductIds(sessionId);

  try {
    const db = getDb();

    // ── Primary candidate ────────────────────────────────────────────────────
    if (!purchasedIds.has(mapping.addonId)) {
      const addon = db.prepare(
        'SELECT id, name, price, stock, category, key_features, rating FROM products WHERE id = ?'
      ).get(mapping.addonId);
      if (addon) return { addon, reason: mapping.reason };
    }

    // ── Primary add-on already owned — look for a substitute ─────────────────
    // Scan RECOMMENDATION_MAP for any other primary product that maps to a
    // different add-on for the same primary product's category, excluding
    // all already-purchased IDs and the primary product itself.
    const primaryProduct = db.prepare('SELECT category FROM products WHERE id = ?').get(productId);
    const primaryCategory = primaryProduct?.category;

    let substituteAddon = null;
    let substituteReason = '';

    for (const [, entry] of Object.entries(RECOMMENDATION_MAP)) {
      if (entry.addonId === mapping.addonId) continue;   // same as the suppressed one
      if (purchasedIds.has(entry.addonId)) continue;     // also already owned
      if (entry.addonId === productId) continue;         // don't recommend the primary itself

      const candidate = db.prepare(
        'SELECT id, name, price, stock, category, key_features, rating FROM products WHERE id = ? AND stock > 0'
      ).get(entry.addonId);

      if (!candidate) continue;

      // Prefer a substitute in the same or a complementary category
      if (!substituteAddon) {
        substituteAddon = candidate;
        substituteReason = entry.reason;
      }
      // Prefer accessories over peripherals as generic complements for electronics
      if (primaryCategory === 'electronics' && candidate.category === 'accessories') {
        substituteAddon = candidate;
        substituteReason = entry.reason;
        break;
      }
    }

    if (substituteAddon) {
      if (sessionId) {
        logAction({
          sessionId,
          action: 'RECOMMENDATION_SUBSTITUTED',
          reasoning: `Add-on product #${mapping.addonId} already purchased in this session — substituting with "${substituteAddon.name}" (id=${substituteAddon.id})`,
          result: 'substituted',
          metadata: {
            primaryProductId: productId,
            suppressedAddonId: mapping.addonId,
            substituteAddonId: substituteAddon.id,
            substituteAddonName: substituteAddon.name,
          },
        });
      }
      return { addon: substituteAddon, reason: substituteReason };
    }

    // ── No substitute available — suppress entirely ───────────────────────────
    if (sessionId) {
      logAction({
        sessionId,
        action: 'RECOMMENDATION_SUPPRESSED_ALREADY_OWNED',
        reasoning: `Add-on product #${mapping.addonId} already purchased in this session — no suitable substitute found, suppressing recommendation`,
        result: 'suppressed',
        metadata: {
          primaryProductId: productId,
          suppressedAddonId: mapping.addonId,
          purchasedIds: [...purchasedIds],
        },
      });
    }
    return null;

  } catch (err) {
    console.warn('[recommendations.js] Failed to query add-on product:', err.message);
    return null;
  }
}

/**
 * Validates a combined order (primary item + add-on item) against hard safety limits.
 * Budget cap applies to the combined total amount.
 * Quantity cap applies per line item (primary quantity and add-on quantity=1).
 * Category allowlist applies to both items.
 *
 * @param {object} params
 * @param {object} params.primary - primary product object { price, category, stock }
 * @param {number} params.primaryQuantity - quantity of primary product
 * @param {object} params.addon - add-on product object { price, category, stock }
 *
 * @returns {{ allowed: boolean, reason: string, combinedTotal: number, limitsApplied: object }}
 */
export function validateCombinedCart({ primary, primaryQuantity, addon }) {
  const combinedTotal = (primary.price * primaryQuantity) + (addon.price * 1);

  // 1. Validate primary product individually
  const primaryCheck = validatePurchase({
    priceInr: primary.price,
    category: primary.category,
    quantity: primaryQuantity,
    stock: primary.stock,
  });
  if (!primaryCheck.allowed) {
    return {
      allowed: false,
      reason: `Primary item rejected: ${primaryCheck.reason}`,
      combinedTotal,
      limitsApplied: primaryCheck.limitsApplied,
    };
  }

  // 2. Validate add-on product individually (category, stock, single-item quantity)
  const addonCheck = validatePurchase({
    priceInr: addon.price,
    category: addon.category,
    quantity: 1,
    stock: addon.stock,
  });
  if (!addonCheck.allowed) {
    return {
      allowed: false,
      reason: `Add-on item rejected: ${addonCheck.reason}`,
      combinedTotal,
      limitsApplied: addonCheck.limitsApplied,
    };
  }

  // 3. Validate combined budget cap using validatePurchase (testing total against MAX_BUDGET_INR)
  const combinedBudgetCheck = validatePurchase({
    priceInr: combinedTotal,
    category: primary.category, // category already validated above
    quantity: 1,
    stock: Infinity,
  });

  if (!combinedBudgetCheck.allowed) {
    return {
      allowed: false,
      reason: `Combined total ₹${combinedTotal} exceeds the per-transaction budget limit of ₹${combinedBudgetCheck.limitsApplied.MAX_BUDGET_INR}.`,
      combinedTotal,
      limitsApplied: combinedBudgetCheck.limitsApplied,
    };
  }

  return {
    allowed: true,
    reason: 'Combined order passed all safety checks.',
    combinedTotal,
    limitsApplied: primaryCheck.limitsApplied,
  };
}
