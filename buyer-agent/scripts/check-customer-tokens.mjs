import fs from 'fs';

// Load .env.local
const envConfig = fs.readFileSync('.env.local', 'utf8');
envConfig.split('\n').forEach(l => {
  const [k, ...v] = l.trim().split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
});

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const auth = Buffer.from(keyId + ':' + keySecret).toString('base64');

const customerId = process.argv[2] || 'cust_TXt2k8rt3yyinW';

console.log(`Checking tokens for customer: ${customerId}`);
const res = await fetch(`https://api.razorpay.com/v1/customers/${customerId}/tokens`, {
  headers: { 'Authorization': 'Basic ' + auth }
});

console.log('HTTP Status:', res.status);
const data = await res.json();
console.log('Tokens result:', JSON.stringify(data, null, 2));
