/**
 * productSearch.js — Product catalog search logic
 * Used by the agent tool-runner to query the local SQLite catalog.
 */

import { getDb } from './database.js';


/**
 * Search products by keyword, category, and/or max price.
 *
 * Improvements over the original single-LIKE version:
 *  1. Word-by-word matching — splits the query into individual words and
 *     requires EACH word to appear in name OR key_features (AND across words,
 *     OR across the two fields).  "wireless gaming mouse" now reliably matches
 *     a product with key_features "wireless, gaming" and name containing
 *     "Mouse", regardless of word order.
 *  2. Category fallback — if a category-filtered search returns zero results,
 *     the function automatically retries the same query without the category
 *     constraint so that LLM category-mismatch errors don't silently swallow
 *     real products.  The fallback is logged as SEARCH_FALLBACK_NO_CATEGORY.
 *
 * @param {object} filters
 * @param {string}  [filters.query]       - free-text match against name + key_features
 * @param {string}  [filters.category]    - filter by category
 * @param {number}  [filters.maxPrice]    - filter by max price in INR
 * @param {number}  [filters.limit=10]
 * @param {string}  [filters.sessionId]   - passed through for fallback audit logging
 *
 * @returns {Array<object>} matching products
 */
export function searchProducts({ query = '', category = '', maxPrice = Infinity, limit = 10, sessionId = '' } = {}) {
  const results = _runSearch({ query, category, maxPrice, limit });

  // ── Category fallback ──────────────────────────────────────────────────────
  // If we got zero results AND a category was specified, the LLM may have
  // guessed the wrong category.  Retry without the category constraint so
  // real products aren't silently dropped.
  if (results.length === 0 && category) {
    if (sessionId) {
      // Import lazily to avoid circular dependency concerns
      import('./audit.js').then(({ logAction }) => {
        logAction({
          sessionId,
          action: 'SEARCH_FALLBACK_NO_CATEGORY',
          reasoning: `Zero results for category="${category}" query="${query}" — retrying without category filter`,
          result: 'fallback',
          metadata: { originalCategory: category, query, maxPrice },
        });
      }).catch(() => {});
    }
    return _runSearch({ query, category: '', maxPrice, limit });
  }

  return results;
}

/**
 * Internal: execute the actual SQL query.
 * Kept private so the public searchProducts can transparently apply fallback logic.
 */
function _runSearch({ query = '', category = '', maxPrice = Infinity, limit = 10 } = {}) {
  const db = getDb();

  let sql = 'SELECT * FROM products WHERE stock > 0';
  const params = [];

  if (category) {
    sql += ' AND LOWER(category) = LOWER(?)';
    params.push(category);
  }

  if (maxPrice !== Infinity && !isNaN(maxPrice)) {
    sql += ' AND price <= ?';
    params.push(maxPrice);
  }

  // Word-by-word matching:
  // For each word in the query, require it to appear in name OR key_features.
  // This means "wireless gaming mouse" matches products that contain ALL three
  // words spread across the two fields — regardless of word order.
  if (query) {
    const words = query.trim().split(/\s+/).filter(Boolean);
    for (const word of words) {
      sql += ' AND (LOWER(name) LIKE LOWER(?) OR LOWER(key_features) LIKE LOWER(?))';
      const likeWord = `%${word}%`;
      params.push(likeWord, likeWord);
    }
  }

  sql += ' ORDER BY rating DESC, price ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get a single product by ID.
 */
export function getProductById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

/**
 * Get all products (for catalog display).
 */
export function getAllProducts() {
  const db = getDb();
  return db.prepare('SELECT * FROM products ORDER BY category, rating DESC').all();
}
