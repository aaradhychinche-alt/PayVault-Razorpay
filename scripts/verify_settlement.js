'use strict';
/**
 * Razorpay Test Mode — Settlement Reconciliation Verification Script
 * 
 * Purpose: Determine whether test-mode transactions appear in the
 *          /v1/settlements/recon/combined endpoint and document
 *          the exact schema returned.
 *
 * Run: node scripts/verify_settlement.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Razorpay = require('razorpay');
const https    = require('https');

const KEY_ID     = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.error('Missing credentials in .env'); process.exit(1);
}

const rzp = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });

// ── Utility: raw HTTPS GET against Razorpay API ───────────────────────────────
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
    const opts = {
      hostname: 'api.razorpay.com',
      path,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Utility: raw HTTPS POST ───────────────────────────────────────────────────
function rawPost(path, payload) {
  return new Promise((resolve, reject) => {
    const auth   = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
    const data   = JSON.stringify(payload);
    const opts = {
      hostname: 'api.razorpay.com',
      path,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Pretty print section ──────────────────────────────────────────────────────
function section(title) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function dump(label, obj) {
  console.log(`\n▶ ${label}:`);
  console.log(JSON.stringify(obj, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const day   = now.getDate();

  console.log('\n🔬  RAZORPAY TEST MODE — SETTLEMENT RECONCILIATION VERIFICATION');
  console.log(`    Account key prefix : ${KEY_ID.slice(0, 14)}…`);
  console.log(`    Date under test    : ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
  console.log(`    Run timestamp      : ${now.toISOString()}`);

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 1: Create test orders
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 1 — Create Test Orders');

  const orderInputs = [
    { amount: 50000,  currency: 'INR', receipt: `recon_test_${Date.now()}_A`, notes: { purpose: 'recon_research', tier: 'basic'    } },
    { amount: 125000, currency: 'INR', receipt: `recon_test_${Date.now()}_B`, notes: { purpose: 'recon_research', tier: 'pro'       } },
    { amount: 299900, currency: 'INR', receipt: `recon_test_${Date.now()}_C`, notes: { purpose: 'recon_research', tier: 'enterprise'} },
  ];

  const createdOrders = [];
  for (const inp of orderInputs) {
    try {
      const order = await rzp.orders.create({ ...inp, payment_capture: 1 });
      createdOrders.push(order);
      console.log(`  ✓ Created order  id=${order.id}  amount=${order.amount}  receipt=${order.receipt}  status=${order.status}`);
    } catch (e) {
      console.error(`  ✗ Failed to create order:`, e.error || e);
    }
  }
  dump('Raw sample order object (first)', createdOrders[0]);

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 2: List ALL payments on the account (last 20)
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 2 — Fetch Existing Payments (last 20)');

  const paymentsResp = await rawGet('/v1/payments?count=20&expand[]=card&expand[]=emi');
  console.log(`  HTTP status : ${paymentsResp.status}`);
  const allPayments  = paymentsResp.body?.items || [];
  console.log(`  Total fetched : ${allPayments.length}`);

  if (allPayments.length > 0) {
    console.log('\n  Payments summary:');
    allPayments.forEach((p, i) => {
      console.log(`  [${i+1}] id=${p.id}  status=${p.status}  amount=${p.amount}  method=${p.method}  order_id=${p.order_id || '—'}  captured=${p.captured}`);
    });
    dump('Raw first payment object (full schema)', allPayments[0]);
  } else {
    console.log('  ⚠  No payments found on this test account.');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 3: Fetch captured payments — candidate for refund
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 3 — Identify Captured Payments for Refund');

  const capturedPayments = allPayments.filter(p => p.status === 'captured' && p.amount_refunded < p.amount);
  console.log(`  Captured & refundable payments: ${capturedPayments.length}`);

  let refundResult = null;
  let refundedPaymentId = null;

  if (capturedPayments.length > 0) {
    const target = capturedPayments[0];
    refundedPaymentId = target.id;
    console.log(`\n  → Attempting refund on payment ${target.id} (amount=${target.amount})`);
    try {
      // Partial refund: ₹1 (100 paise) to avoid depleting full amount
      const refundAmt = Math.min(10000, target.amount - target.amount_refunded);
      const refundPayload = { amount: refundAmt, notes: { reason: 'recon_research_test_refund' } };
      const r = await rawPost(`/v1/payments/${target.id}/refund`, refundPayload);
      refundResult = r;
      console.log(`  HTTP status: ${r.status}`);
      dump('Refund response', r.body);
    } catch (e) {
      console.error('  ✗ Refund error:', e);
    }
  } else {
    console.log('  ⚠  No captured payments available — skipping refund step.');
    console.log('     (Orders were created but payments must be authorized via Checkout modal first.)');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 4: Fetch ALL refunds on account
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 4 — Fetch All Refunds (last 20)');

  const refundsResp = await rawGet('/v1/refunds?count=20');
  console.log(`  HTTP status : ${refundsResp.status}`);
  const allRefunds = refundsResp.body?.items || [];
  console.log(`  Total refunds: ${allRefunds.length}`);
  if (allRefunds.length > 0) {
    allRefunds.forEach((r, i) => {
      console.log(`  [${i+1}] id=${r.id}  payment_id=${r.payment_id}  amount=${r.amount}  status=${r.status}  speed_processed=${r.speed_processed}`);
    });
    dump('Raw first refund object (full schema)', allRefunds[0]);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 5: Fetch Settlements list
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 5 — Fetch Settlements List');

  const settlementsResp = await rawGet('/v1/settlements?count=20');
  console.log(`  HTTP status : ${settlementsResp.status}`);
  dump('Settlements list response', settlementsResp.body);

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 6: Settlement Recon — TODAY
  // ────────────────────────────────────────────────────────────────────────────
  section(`PHASE 6 — Settlement Recon /v1/settlements/recon/combined  [TODAY: ${year}-${month}-${day}]`);

  const reconToday = await rawGet(
    `/v1/settlements/recon/combined?year=${year}&month=${month}&day=${day}&count=25`
  );
  console.log(`  HTTP status : ${reconToday.status}`);
  dump('Full recon response (today)', reconToday.body);

  // Check which target fields are present
  const targetFields = [
    'entity_id','type','amount','debit','credit','fee','tax',
    'settlement_id','settlement_utr','order_id','order_receipt',
    'created_at','settled_at','dispute_id'
  ];

  const reconItems = reconToday.body?.items || [];
  console.log(`\n  Recon items count: ${reconItems.length}`);

  if (reconItems.length > 0) {
    console.log('\n  Field presence audit (first recon item):');
    const sample = reconItems[0];
    targetFields.forEach(f => {
      const present = f in sample;
      const val     = sample[f];
      console.log(`    ${present ? '✓' : '✗'} ${f.padEnd(20)} = ${present ? JSON.stringify(val) : 'MISSING'}`);
    });
    dump('Full first recon item', sample);
  } else {
    console.log('  → Zero items in today\'s recon window.');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 7: Settlement Recon — YESTERDAY (in case settlement cycle is D-1)
  // ────────────────────────────────────────────────────────────────────────────
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const yy = yesterday.getFullYear(), ym = yesterday.getMonth()+1, yd = yesterday.getDate();
  section(`PHASE 7 — Settlement Recon  [YESTERDAY: ${yy}-${ym}-${yd}]`);

  const reconYest = await rawGet(
    `/v1/settlements/recon/combined?year=${yy}&month=${ym}&day=${yd}&count=25`
  );
  console.log(`  HTTP status : ${reconYest.status}`);
  dump('Full recon response (yesterday)', reconYest.body);

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 8: Demand Settlement (test-mode only) — attempt to trigger a settlement
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 8 — Attempt Demand Settlement (test-mode)');

  // This API is only available in test mode and instantly settles pending amounts
  const demandResp = await rawPost('/v1/settlements/demand', {});
  console.log(`  HTTP status : ${demandResp.status}`);
  dump('Demand settlement response', demandResp.body);

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 9: Re-probe recon after demand settlement attempt
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 9 — Re-probe Recon After Demand Settlement');

  const reconAfter = await rawGet(
    `/v1/settlements/recon/combined?year=${year}&month=${month}&day=${day}&count=25`
  );
  console.log(`  HTTP status : ${reconAfter.status}`);
  const itemsAfter = reconAfter.body?.items || [];
  console.log(`  Items count : ${itemsAfter.length}`);
  if (itemsAfter.length > 0) {
    dump('Recon items after demand settlement', reconAfter.body);
    console.log('\n  Field presence audit (first item post-demand):');
    const sample = itemsAfter[0];
    targetFields.forEach(f => {
      const present = f in sample;
      console.log(`    ${present ? '✓' : '✗'} ${f.padEnd(20)} = ${present ? JSON.stringify(sample[f]) : 'MISSING'}`);
    });
  } else {
    dump('Response body', reconAfter.body);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 10: Settlements list — re-check after demand
  // ────────────────────────────────────────────────────────────────────────────
  section('PHASE 10 — Settlements List After Demand');
  const settlements2 = await rawGet('/v1/settlements?count=20');
  console.log(`  HTTP status : ${settlements2.status}`);
  dump('Settlements after demand', settlements2.body);

  // ────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ────────────────────────────────────────────────────────────────────────────
  section('VERIFICATION SUMMARY');
  console.log(`  Orders created               : ${createdOrders.length}`);
  console.log(`  Payments found (captured)    : ${capturedPayments.length}`);
  console.log(`  Refunds found                : ${allRefunds.length}`);
  console.log(`  Refund attempted             : ${refundedPaymentId ? 'Yes — ' + refundedPaymentId : 'No (no captured payments)'}`);
  console.log(`  Settlements list items       : ${settlementsResp.body?.count ?? settlementsResp.body?.items?.length ?? 'see dump'}`);
  console.log(`  Recon items today (before)   : ${reconItems.length}`);
  console.log(`  Recon items today (after)    : ${itemsAfter.length}`);
  console.log(`  Demand settlement HTTP status: ${demandResp.status}`);
  console.log('');
}

main().catch(console.error);
