/**
 * database.js — SQLite singleton using better-sqlite3
 * Initialises tables on first run and seeds product catalog.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'db', 'store.db');

// Use globalThis so the singleton survives Next.js dev hot-reloads.
// In production there is only one module instance, so this is a no-op.
const g = globalThis;

export function getDb() {
  if (!g._buyerAgentDb) {
    g._buyerAgentDb = new Database(DB_PATH);
    g._buyerAgentDb.pragma('journal_mode = WAL');
    g._buyerAgentDb.pragma('foreign_keys = ON');
    initSchema(g._buyerAgentDb);
    g._schemaV2 = true;
  } else if (!g._schemaV2) {
    initSchema(g._buyerAgentDb);
    g._schemaV2 = true;
  }
  return g._buyerAgentDb;
}


function initSchema(db) {
  // Products table
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      price       INTEGER NOT NULL,          -- price in INR (paise * 100 stored as rupees)
      stock       INTEGER NOT NULL DEFAULT 0,
      category    TEXT    NOT NULL,
      key_features TEXT   NOT NULL,          -- comma-separated short tags
      rating      REAL    NOT NULL DEFAULT 4.0
    );
  `);

  // Audit log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      timestamp   TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      reasoning   TEXT,
      result      TEXT,
      metadata    TEXT                        -- JSON blob
    );
  `);

  // Orders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id            TEXT    NOT NULL,
      razorpay_order_id     TEXT,
      razorpay_payment_id   TEXT,
      product_id            INTEGER NOT NULL,
      quantity              INTEGER NOT NULL DEFAULT 1,
      amount                INTEGER NOT NULL,
      status                TEXT    NOT NULL DEFAULT 'pending',
      cancellation_deadline TEXT,
      created_at            TEXT    NOT NULL,
      updated_at            TEXT    NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // Settings table for user-adjustable, server-enforced safety limits
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      max_budget_inr      INTEGER NOT NULL DEFAULT 5000,
      allowed_categories  TEXT    NOT NULL DEFAULT 'electronics,accessories,peripherals',
      max_quantity        INTEGER NOT NULL DEFAULT 3,
      updated_at          TEXT    NOT NULL
    );
  `);

  // Initialize settings row if not present
  const existingSettings = db.prepare('SELECT id FROM settings WHERE id = 1').get();
  if (!existingSettings) {
    const defaultBudget = parseInt(process.env.MAX_BUDGET_INR || '5000', 10);
    const defaultCategories = process.env.ALLOWED_CATEGORIES || 'electronics,accessories,peripherals';
    const defaultQuantity = parseInt(process.env.MAX_QUANTITY || '3', 10);
    db.prepare(`
      INSERT INTO settings (id, max_budget_inr, allowed_categories, max_quantity, updated_at)
      VALUES (1, ?, ?, ?, ?)
    `).run(defaultBudget, defaultCategories, defaultQuantity, new Date().toISOString());
  }

  // Session → Razorpay customer mapping (for save-card / tokenization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_customers (
      session_id          TEXT PRIMARY KEY,
      razorpay_customer_id TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );
  `);

  // Safe migrations for existing DBs
  for (const col of [
    'ALTER TABLE orders ADD COLUMN razorpay_payment_id TEXT',
    'ALTER TABLE orders ADD COLUMN cancellation_deadline TEXT',
  ]) {
    try { db.exec(col); } catch (_) {}
  }

  // Seed products if the table is empty
  const count = db.prepare('SELECT COUNT(*) as cnt FROM products').get();
  if (count.cnt === 0) {
    seedProducts(db);
  }

  // Ensure a disallowed-category product exists for safety policy testing
  const furnitureCheck = db.prepare("SELECT id FROM products WHERE category = 'furniture'").get();
  if (!furnitureCheck) {
    db.prepare(`
      INSERT INTO products (name, price, stock, category, key_features, rating)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Ergonomic Executive Office Chair', 3499, 12, 'furniture', 'office chair, ergonomic, lumbar support', 4.4);
  }
}

export function getSettings() {
  const db = getDb();
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

export function updateSettings({ max_budget_inr, allowed_categories, max_quantity }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE settings
    SET max_budget_inr = ?, allowed_categories = ?, max_quantity = ?, updated_at = ?
    WHERE id = 1
  `).run(max_budget_inr, allowed_categories, max_quantity, now);
  return getSettings();
}

/**
 * Get the cached Razorpay customer_id for a session, or null if not yet created.
 */
export function getSessionCustomer(sessionId) {
  const db = getDb();
  const row = db.prepare('SELECT razorpay_customer_id FROM session_customers WHERE session_id = ?').get(sessionId);
  return row ? row.razorpay_customer_id : null;
}

/**
 * Store a Razorpay customer_id against a session.
 */
export function setSessionCustomer(sessionId, razorpayCustomerId) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO session_customers (session_id, razorpay_customer_id, created_at)
    VALUES (?, ?, ?)
  `).run(sessionId, razorpayCustomerId, new Date().toISOString());
}



function seedProducts(db) {
  const insert = db.prepare(`
    INSERT INTO products (name, price, stock, category, key_features, rating)
    VALUES (@name, @price, @stock, @category, @key_features, @rating)
  `);

  const products = [
    // ── Electronics ───────────────────────────────────────────────────────────
    {
      name: 'Logitech G305 LIGHTSPEED Wireless Gaming Mouse',
      price: 1895,
      stock: 15,
      category: 'electronics',
      key_features: 'wireless, gaming',
      rating: 4.6,
    },
    {
      name: 'Portronics Toad 23 Wireless Mouse',
      price: 499,
      stock: 40,
      category: 'electronics',
      key_features: 'wireless, budget',
      rating: 4.1,
    },
    {
      name: 'HP X200 Wired Optical Mouse',
      price: 349,
      stock: 60,
      category: 'electronics',
      key_features: 'wired, budget',
      rating: 4.0,
    },
    {
      name: 'Dell MS116 Wired Optical Mouse',
      price: 299,
      stock: 55,
      category: 'electronics',
      key_features: 'wired, basic',
      rating: 3.9,
    },
    {
      name: 'Zebronics Zeb-Transformer-M Gaming Mouse',
      price: 649,
      stock: 25,
      category: 'electronics',
      key_features: 'wired, gaming RGB',
      rating: 4.2,
    },
    {
      name: 'boAt Rockerz 450 Bluetooth Headphones',
      price: 1499,
      stock: 30,
      category: 'electronics',
      key_features: 'wireless, 15h battery',
      rating: 4.3,
    },
    {
      name: 'JBL Tune 510BT Wireless Headphones',
      price: 2999,
      stock: 18,
      category: 'electronics',
      key_features: 'wireless, JBL Pure Bass',
      rating: 4.5,
    },
    {
      name: 'Noise Shots X5 Pro TWS Earbuds',
      price: 1299,
      stock: 35,
      category: 'electronics',
      key_features: 'true wireless, 30h total',
      rating: 4.2,
    },
    // ── Accessories ───────────────────────────────────────────────────────────
    {
      name: 'AmazonBasics Type-C to Type-A USB 3.1 Cable 1m',
      price: 349,
      stock: 100,
      category: 'accessories',
      key_features: 'USB-C, fast charge',
      rating: 4.4,
    },
    {
      name: 'Anker 65W GaN USB-C Charger',
      price: 2499,
      stock: 20,
      category: 'accessories',
      key_features: 'GaN, foldable plug',
      rating: 4.7,
    },
    {
      name: 'Portronics Modesk 2 Wireless Charging Pad',
      price: 799,
      stock: 22,
      category: 'accessories',
      key_features: '10W, Qi compatible',
      rating: 4.1,
    },
    {
      name: 'Ugreen USB Hub 4-Port USB 3.0',
      price: 899,
      stock: 30,
      category: 'accessories',
      key_features: '4-port, USB 3.0',
      rating: 4.5,
    },
    {
      name: 'WD 1TB My Passport Portable HDD',
      price: 3999,
      stock: 10,
      category: 'accessories',
      key_features: '1TB, USB 3.0',
      rating: 4.6,
    },
    // ── Peripherals ────────────────────────────────────────────────────────────
    {
      name: 'Keychron K2 Wireless Mechanical Keyboard',
      price: 6999,
      stock: 8,
      category: 'peripherals',
      key_features: 'mechanical, Bluetooth',
      rating: 4.7,
    },
    {
      name: 'Zebronics Zeb-K11 USB Wired Keyboard',
      price: 449,
      stock: 50,
      category: 'peripherals',
      key_features: 'membrane, wired',
      rating: 4.0,
    },
    // ── Furniture (Disallowed category — for safety validation testing) ───────────
    {
      name: 'Ergonomic Executive Office Chair',
      price: 3499,
      stock: 12,
      category: 'furniture',
      key_features: 'office chair, ergonomic, lumbar support',
      rating: 4.4,
    },
  ];


  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });
  insertMany(products);
  console.log(`[DB] Seeded ${products.length} products.`);
}
