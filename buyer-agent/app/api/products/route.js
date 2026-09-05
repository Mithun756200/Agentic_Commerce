/**
 * GET /api/products — returns full catalog
 */

import { NextResponse } from 'next/server';
import { getAllProducts } from '@/lib/productSearch';

export async function GET() {
  try {
    const products = getAllProducts();
    return NextResponse.json({ success: true, products });
  } catch (err) {
    console.error('[/api/products]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
