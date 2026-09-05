/**
 * POST /api/payment
 * Handles the following actions:
 *   action: "create_order"    — creates a real Razorpay order (after user approval)
 *   action: "confirm"         — verifies Razorpay signature and marks order paid (or failed)
 *   action: "cancel_order"    — cancels a paid order within the cancellation window
 *   action: "dismiss_checkout"— marks order as dismissed when user closes popup without paying
 *
 * The LLM NEVER calls this endpoint — only the frontend does, after explicit user approval.
 */

import { NextResponse } from 'next/server';
import { createOrder, confirmPayment, cancelOrder, dismissCheckout, getOrCreateCustomer } from '@/lib/payment';
import { logAction } from '@/lib/audit';
import { validateCombinedCart } from '@/lib/recommendations';

// Return the public Razorpay key so the browser doesn't need process.env
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const response = { razorpayKeyId: process.env.RAZORPAY_KEY_ID || '' };
  if (sessionId) {
    try {
      response.customerId = await getOrCreateCustomer(sessionId);
    } catch (err) {
      // Non-fatal — save-card will be unavailable but plain payment still works
      console.warn('[/api/payment GET] Customer creation failed:', err.message);
      response.customerId = null;
    }
  }
  return NextResponse.json(response);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, sessionId } = body;

    if (!action || !sessionId) {
      return NextResponse.json({ success: false, error: 'action and sessionId are required' }, { status: 400 });
    }

    // ── Cross-sell cart validation & recommendation choice ─────────────────
    if (action === 'validate_cart') {
      const primary = body.primary || body.product;
      const primaryQuantity = body.primaryQuantity || body.quantity || 1;
      const addon = body.addon || body.recommendation?.addon || body.recommendation?.item;
      const userChoice = body.choice || body.decision;

      if (userChoice === 'declined' || userChoice === 'decline') {
        logAction({
          sessionId,
          action: 'RECOMMENDATION_REJECTED',
          reasoning: `User declined add-on: "${addon?.name || 'addon'}"`,
          result: 'rejected',
          metadata: {
            primaryProductId: primary?.id,
            addonProductId: addon?.id,
            userChoice: 'declined',
          },
        });
        return NextResponse.json({ success: true, allowed: true, choice: 'declined' });
      }

      // Choice is 'accepted'
      const check = validateCombinedCart({ primary, primaryQuantity, addon });

      if (check.allowed) {
        logAction({
          sessionId,
          action: 'RECOMMENDATION_ACCEPTED',
          reasoning: `User accepted add-on: "${addon.name}" (+₹${addon.price}) — combined total: ₹${check.combinedTotal}`,
          result: 'accepted',
          metadata: {
            primaryProductId: primary.id,
            addonProductId: addon.id,
            addonPrice: addon.price,
            combinedTotal: check.combinedTotal,
          },
        });

        logAction({
          sessionId,
          action: 'SAFETY_CHECK',
          reasoning: `Combined order safety check passed. Total amount ₹${check.combinedTotal} within budget ₹${check.limitsApplied.MAX_BUDGET_INR}.`,
          result: 'passed',
          metadata: {
            primaryProductId: primary.id,
            addonProductId: addon.id,
            combinedTotal: check.combinedTotal,
            safetyConfig: check.limitsApplied,
          },
        });

        return NextResponse.json({ success: true, allowed: true, choice: 'accepted', check, reason: check.reason });
      } else {
        // Add-on specifically rejected by safety engine
        logAction({
          sessionId,
          action: 'SAFETY_CHECK',
          reasoning: check.reason,
          result: 'blocked',
          metadata: {
            primaryProductId: primary.id,
            addonProductId: addon.id,
            combinedTotal: check.combinedTotal,
            safetyConfig: check.limitsApplied,
          },
        });

        logAction({
          sessionId,
          action: 'RECOMMENDATION_REJECTED',
          reasoning: `Add-on rejected by safety engine: ${check.reason}`,
          result: 'rejected',
          metadata: {
            primaryProductId: primary.id,
            addonProductId: addon.id,
            reason: check.reason,
            combinedTotal: check.combinedTotal,
          },
        });

        return NextResponse.json({ success: true, allowed: false, choice: 'rejected_safety', check, reason: check.reason });
      }
    }

    // ── Create order (called after user clicks "Approve & Pay") ─────────────
    if (action === 'create_order') {
      const { productId, quantity, priceInr, productName, addonProduct, addonPriceInr } = body;

      const totalInr = (priceInr * quantity) + (addonProduct ? (addonPriceInr || addonProduct.price) : 0);
      const approvalReason = addonProduct
        ? `User explicitly approved purchase of "${productName}" x${quantity} + Add-on "${addonProduct.name}" for ₹${totalInr}`
        : `User explicitly approved purchase of "${productName}" x${quantity} for ₹${priceInr * quantity}`;

      logAction({
        sessionId,
        action: 'USER_APPROVED',
        reasoning: approvalReason,
        result: 'approved',
        metadata: {
          productId,
          quantity,
          priceInr,
          productName,
          addonProduct: addonProduct ? { id: addonProduct.id, name: addonProduct.name, price: addonProduct.price } : null,
          totalInr,
        },
      });

      const [result, customerId] = await Promise.all([
        createOrder({ sessionId, productId, quantity, priceInr, productName, addonProduct, addonPriceInr }),
        getOrCreateCustomer(sessionId).catch((err) => {
          console.warn('[/api/payment POST create_order] Customer creation failed:', err.message);
          return null;
        }),
      ]);
      return NextResponse.json({ ...result, customerId });
    }

    // ── Confirm payment — requires real Razorpay credentials or simulateFailure ──
    if (action === 'confirm') {
      const {
        dbOrderId,
        razorpayPaymentId,
        razorpayOrderId,
        razorpaySignature,
        simulateFailure = false,
      } = body;

      const result = await confirmPayment({
        dbOrderId,
        sessionId,
        razorpayPaymentId,
        razorpayOrderId,
        razorpaySignature,
        simulateFailure,
      });

      if (result.success) {
        logAction({
          sessionId,
          action: 'ORDER_CONFIRMED',
          reasoning: result.message,
          result: 'paid',
          metadata: {
            dbOrderId,
            razorpayPaymentId,
            razorpayOrderId,
            cancellationDeadline: result.cancellationDeadline,
          },
        });
      } else if (simulateFailure) {
        logAction({
          sessionId,
          action: 'FAILURE_HANDLED',
          reasoning: 'Payment failure handled gracefully — no duplicate order created',
          result: 'failed',
          metadata: { dbOrderId, simulateFailure },
        });
      }
      // Real failures (invalid signature etc.) are already logged inside confirmPayment

      return NextResponse.json(result);
    }

    // ── Cancel a paid order within the cancellation window ───────────────────
    if (action === 'cancel_order') {
      const { dbOrderId } = body;
      const result = await cancelOrder({ dbOrderId, sessionId });
      return NextResponse.json(result);
    }

    // ── Dismiss checkout (user closed Razorpay popup without paying) ─────────
    if (action === 'dismiss_checkout') {
      const { dbOrderId } = body;
      try { dismissCheckout({ dbOrderId, sessionId }); } catch (_) {}
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('[/api/payment]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
