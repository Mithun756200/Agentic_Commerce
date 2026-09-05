import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  });
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const models = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite'
];

console.log('════════════════════════════════════════════════════════════════════════════════════');
console.log('  Live Gemini Models Benchmark (Time: ' + new Date().toLocaleString('en-IN') + ')');
console.log('════════════════════════════════════════════════════════════════════════════════════\n');

for (const m of models) {
  const t0 = Date.now();
  try {
    const res = await ai.models.generateContent({ model: m, contents: 'ping' });
    const latency = Date.now() - t0;
    const output = (res.text || '').trim().replace(/\n/g, ' ').slice(0, 45);
    console.log(`✓ SUCCESS | MODEL: ${m.padEnd(24)} | LATENCY: ${latency.toString().padStart(5)}ms | OUTPUT: "${output}"`);
  } catch (err) {
    const latency = Date.now() - t0;
    const code = err.status || err.code || 'ERR';
    const msg = (err.message || '').slice(0, 60).replace(/\n/g, ' ');
    console.log(`✗ FAILED  | MODEL: ${m.padEnd(24)} | LATENCY: ${latency.toString().padStart(5)}ms | CODE: ${code} | ERROR: "${msg}"`);
  }
}
console.log('\n════════════════════════════════════════════════════════════════════════════════════\n');
