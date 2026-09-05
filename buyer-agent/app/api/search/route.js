/**
 * GET /api/search?query=...&category=...&maxPrice=...
 * Returns matching products from the catalog.
 */

import { NextResponse } from 'next/server';
import { searchProducts } from '@/lib/productSearch';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query') || '';
  const category = searchParams.get('category') || '';
  const maxPrice = searchParams.get('maxPrice') ? Number(searchParams.get('maxPrice')) : Infinity;

  try {
    const products = searchProducts({ query, category, maxPrice });
    return NextResponse.json({ success: true, products, count: products.length });
  } catch (err) {
    console.error('[/api/search]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
