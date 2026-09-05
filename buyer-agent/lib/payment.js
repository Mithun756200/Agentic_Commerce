/**
 * payment.js — Razorpay payment service layer
 *
 * The LLM NEVER calls this directly.
 * Flow: LLM reasoning → structured tool call → safety validator → THIS FILE → Razorpay API
 *
 * Signature verification is mandatory for confirmPayment — no payment is marked
 * as paid without a valid HMAC-SHA256 signature from Razorpay.
 */

import crypto from 'crypto';
import Razorpay from 'razorpay';
import { getDb, getSessionCustomer, setSessionCustomer } from './database.js';
import { logAction } from './audit.js';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});

/**
 * Get (or lazily create) a Razorpay customer for this session.
 * Required to enable card tokenization (RBI save-card flow).
 *
 * Customer creation is idempotent per session — we cache the customer_id in SQLite
 * so we never create duplicate Razorpay customers for the same session.
 *
 * @param {string} sessionId
 * @returns {Promise<string>} Razorpay customer_id (e.g. "cust_xxx")
 */
export async function getOrCreateCustomer(sessionId) {
  // Return cached customer if already exists for this session
  const cached = getSessionCustomer(sessionId);
  if (cached) return cached;

  // Create a new Razorpay customer keyed by sessionId
  const customer = await razorpay.customers.create({
    name: `Session ${sessionId.slice(0, 16)}`,
    email: `${sessionId.slice(5, 20).replace(/[^a-z0-9]/gi, '')}@agent.test`,
    contact: '9999999999',
    fail_existing: '0', // don't fail if email already exists in test mode
  });

  setSessionCustomer(sessionId, customer.id);
  return customer.id;
}

/**
 * Create a Razorpay order for a product purchase.
 * Records the order in the local DB immediately (status=pending).
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.productId
 * @param {number} params.quantity
 * @param {number} params.priceInr
 * @param {string} params.productName
 *
 * @returns {{ success: boolean, orderId?: string, razorpayOrder?: object, error?: string, dbOrderId?: number }}
 */
export async function createOrder({ sessionId, productId, quantity, priceInr, productName, addonProduct, addonPriceInr }) {
  const addonAmountPaise = addonProduct ? ((addonPriceInr || addonProduct.price) * 100) : 0;
  const amountPaise = (priceInr * quantity * 100) + addonAmountPaise; // Razorpay expects paise
  const db = getDb();
  const now = new Date().toISOString();
  const addonId = addonProduct ? addonProduct.id : null;

  // Insert order in DB as pending BEFORE calling Razorpay (no orphan orders)
  const insertResult = db.prepare(`
    INSERT INTO orders (session_id, product_id, addon_product_id, quantity, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(sessionId, productId, addonId, quantity, amountPaise, now, now);

  const dbOrderId = insertResult.lastInsertRowid;

  const itemDescription = addonProduct
    ? `"${productName}" x${quantity} + Add-on: "${addonProduct.name}" = ₹${(priceInr * quantity) + (addonPriceInr || addonProduct.price)}`
    : `"${productName}" x${quantity} = ₹${priceInr * quantity}`;

  logAction({
    sessionId,
    action: 'PAYMENT_INIT',
    reasoning: `Creating Razorpay order for ${itemDescription}`,
    result: 'pending',
    metadata: { dbOrderId, productId, addonProductId: addonId, quantity, amountPaise },
  });

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `order_${dbOrderId}`,
      notes: {
        session_id: sessionId,
        product_name: addonProduct ? `${productName} + ${addonProduct.name}` : productName,
        quantity: String(quantity),
        addon_product_id: addonId ? String(addonId) : '',
      },
    });

    // Update DB with Razorpay order ID
    db.prepare(`
      UPDATE orders SET razorpay_order_id = ?, updated_at = ? WHERE id = ?
    `).run(razorpayOrder.id, new Date().toISOString(), dbOrderId);

    logAction({
      sessionId,
      action: 'PAYMENT_CREATED',
      reasoning: 'Razorpay order created successfully',
      result: 'ok',
      metadata: { razorpayOrderId: razorpayOrder.id, dbOrderId, amountPaise },
    });

    return { success: true, orderId: razorpayOrder.id, razorpayOrder, dbOrderId };
  } catch (err) {
    db.prepare(`
      UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), dbOrderId);

    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: `Razorpay order creation failed: ${err.message}`,
      result: 'failed',
      metadata: { error: err.message, dbOrderId },
    });

    return { success: false, error: err.message, dbOrderId };
  }
}

/**
 * Confirm a payment after the Razorpay checkout popup completes.
 *
 * For a REAL payment: razorpayPaymentId, razorpayOrderId, and razorpaySignature
 * MUST be provided. The signature is verified server-side with HMAC-SHA256 before
 * any order is marked as paid.
 *
 * For a SIMULATED failure: only simulateFailure=true is needed.
 *
 * @param {object} params
 * @param {number}  params.dbOrderId
 * @param {string}  params.sessionId
 * @param {string}  [params.razorpayPaymentId]   - from Razorpay handler.payment_id
 * @param {string}  [params.razorpayOrderId]     - from Razorpay handler.order_id
 * @param {string}  [params.razorpaySignature]   - from Razorpay handler.signature
 * @param {boolean} [params.simulateFailure]     - deliberate failure demo
 */
export async function confirmPayment({
  dbOrderId,
  sessionId,
  razorpayPaymentId,
  razorpayOrderId,
  razorpaySignature,
  simulateFailure = false,
}) {
  const db = getDb();

  // ── 1. Look up order by dbOrderId ──────────────────────────────────────────
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dbOrderId);
  if (!order) {
    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: `Order ID #${dbOrderId} not found in database`,
      result: 'failed',
      metadata: { dbOrderId },
    });
    return { success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found.' };
  }

  // ── 2. Verify order belongs to the session ─────────────────────────────────
  if (order.session_id !== sessionId) {
    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: `Order ID #${dbOrderId} does not belong to session ${sessionId}`,
      result: 'failed',
      metadata: { dbOrderId, orderSessionId: order.session_id, requestSessionId: sessionId },
    });
    return { success: false, error: 'SESSION_MISMATCH', message: 'Order does not belong to this session.' };
  }

  // ── 3. Cross-verify Razorpay Order ID ──────────────────────────────────────
  if (!simulateFailure && order.razorpay_order_id && razorpayOrderId && order.razorpay_order_id !== razorpayOrderId) {
    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: `Razorpay Order ID mismatch for order #${dbOrderId} (expected ${order.razorpay_order_id}, got ${razorpayOrderId})`,
      result: 'failed',
      metadata: { dbOrderId, expectedRazorpayOrderId: order.razorpay_order_id, razorpayOrderId },
    });
    return { success: false, error: 'ORDER_ID_MISMATCH', message: 'Razorpay order ID does not match payment record.' };
  }

  // ── Deliberate failure simulation ───────────────────────────────────────────
  if (simulateFailure) {
    db.prepare(`
      UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), dbOrderId);

    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: 'Deliberate failure simulation triggered',
      result: 'failed',
      metadata: { dbOrderId },
    });

    return {
      success: false,
      error: 'PAYMENT_FAILED',
      message: 'Payment was declined by the bank. No charge was made.',
    };
  }

  // ── Real payment — all three fields are required ────────────────────────────
  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: 'Missing Razorpay payment credentials — cannot verify payment',
      result: 'failed',
      metadata: { dbOrderId, razorpayPaymentId, razorpayOrderId },
    });
    return { success: false, error: 'MISSING_CREDENTIALS', message: 'Payment verification failed — missing credentials.' };
  }

  // ── Server-side HMAC-SHA256 signature verification ─────────────────────────
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    db.prepare(`
      UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), dbOrderId);

    logAction({
      sessionId,
      action: 'PAYMENT_FAILED',
      reasoning: 'Razorpay signature verification FAILED — order rejected',
      result: 'failed',
      metadata: { dbOrderId, razorpayPaymentId, razorpayOrderId },
    });

    return { success: false, error: 'INVALID_SIGNATURE', message: 'Payment verification failed. No charge was made.' };
  }

  // ── Signature verified — mark order as paid and decrement stock ─────────────
  db.prepare(`
    UPDATE orders
    SET status = 'paid', razorpay_payment_id = ?, updated_at = ?
    WHERE id = ?
  `).run(razorpayPaymentId, new Date().toISOString(), dbOrderId);

  // Decrement stock using quantity from order
  db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(order.quantity, order.product_id);
  if (order.addon_product_id) {
    db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(order.addon_product_id);
  }

  // Set cancellation deadline: 24 hours from now
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE orders SET cancellation_deadline = ? WHERE id = ?').run(deadline, dbOrderId);

  logAction({
    sessionId,
    action: 'PAYMENT_SUCCESS',
    reasoning: 'Signature verified — payment confirmed, stock decremented',
    result: 'paid',
    metadata: { dbOrderId, razorpayPaymentId, razorpayOrderId, cancellationDeadline: deadline },
  });

  return {
    success: true,
    message: 'Payment confirmed! Your order has been placed.',
    cancellationDeadline: deadline,
  };
}

/**
 * Cancel a paid order within the cancellation window.
 */
export async function cancelOrder({ dbOrderId, sessionId }) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dbOrderId);

  if (!order) return { success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found.' };
  if (order.session_id !== sessionId) return { success: false, error: 'SESSION_MISMATCH', message: 'Order does not belong to this session.' };
  if (order.status !== 'paid') return { success: false, error: 'NOT_PAID', message: 'Only paid orders can be cancelled.' };

  const deadline = order.cancellation_deadline ? new Date(order.cancellation_deadline) : null;
  if (!deadline || Date.now() > deadline.getTime()) {
    return { success: false, error: 'WINDOW_EXPIRED', message: 'Cancellation window has expired.' };
  }

  db.prepare('UPDATE orders SET status = \'cancelled\', updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), dbOrderId);
  db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(order.quantity, order.product_id);
  if (order.addon_product_id) {
    db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(order.addon_product_id);
  }

  logAction({
    sessionId,
    action: 'ORDER_CANCELLED',
    reasoning: `Order #${dbOrderId} cancelled by user within window`,
    result: 'cancelled',
    metadata: { dbOrderId },
  });

  return { success: true, message: 'Order cancelled successfully. Refund will be processed in 5–7 business days.' };
}

/**
 * Mark an order as checkout_dismissed when the user closes the Razorpay popup
 * without completing payment. This is semantically distinct from a payment failure.
 */
export function dismissCheckout({ dbOrderId, sessionId }) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dbOrderId);

  if (!order || order.session_id !== sessionId) return;
  if (order.status !== 'pending') return; // already resolved, don't overwrite

  db.prepare("UPDATE orders SET status = 'checkout_dismissed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), dbOrderId);

  logAction({
    sessionId,
    action: 'CHECKOUT_DISMISSED',
    reasoning: `User closed Razorpay checkout for order #${dbOrderId} — no charge made`,
    result: 'dismissed',
    metadata: { dbOrderId },
  });
}

/**
 * Get an order by its DB id.
 */
export function getOrderById(dbOrderId) {
  const db = getDb();
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(dbOrderId);
}
