'use strict';

require('dotenv').config();

const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');

// ── Validate required environment variables ──────────────────────────────────
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, PORT = 3000 } = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error(
    '[ERROR] Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in .env'
  );
  process.exit(1);
}

// ── Razorpay client ───────────────────────────────────────────────────────────
const maskedKeyId = RAZORPAY_KEY_ID && RAZORPAY_KEY_ID.length > 8
  ? `${RAZORPAY_KEY_ID.slice(0, 8)}...${RAZORPAY_KEY_ID.slice(-4)}`
  : (RAZORPAY_KEY_ID ? 'CONFIGURED' : 'MISSING');

console.log(`[Payvault Boot] Gateway: Razorpay Test Mode | Key ID: ${maskedKeyId} | Key Secret: ${RAZORPAY_KEY_SECRET ? 'CONFIGURED' : 'MISSING'}`);

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ── Chunk 1: Reconciliation Foundation routes ─────────────────────────────────
const reconciliationRoutes = require('./src/routes/reconciliation');
const exceptionsRoutes     = require('./src/routes/exceptions');
const demoRoutes           = require('./src/routes/demo');
const investigationsRoutes = require('./src/routes/investigations');
const store                = require('./src/store/dataStore');
const postgres             = require('./src/db/postgres');
const redis                = require('./src/db/redis');
const migrator             = require('./src/db/migrator');

app.use('/api/reconciliation', reconciliationRoutes);
app.use('/api/exceptions',     exceptionsRoutes);
app.use('/api/demo',           demoRoutes);
app.use('/api/investigations', investigationsRoutes);

// ── GET /api/health — System & Infrastructure Health Check ────────────────────
const handleHealth = (req, res) => {
  const pgConnected = postgres.isAvailable();
  const redisConnected = redis.isAvailable();

  return res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    database: {
      status: pgConnected ? 'connected' : 'unavailable',
      mode: postgres.getMode(),
    },
    redis: {
      status: redisConnected ? 'connected' : 'unavailable',
      mode: redis.getMode(),
    },
    razorpay: {
      configured: !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
      mode: 'test',
    },
  });
};

app.get('/api/health', handleHealth);
app.get('/health',     handleHealth);

// ── GET /api/config/status — Safe diagnostic status ──────────────────────────
app.get('/api/config/status', (req, res) => {
  const currentStore = store.getStore();
  return res.json({
    razorpay_configured: !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
    razorpay_key_id_masked: maskedKeyId,
    razorpay_key_secret_present: !!RAZORPAY_KEY_SECRET,
    mode: currentStore.mode,
    active_records_count: currentStore.settlementRecords.length,
    active_exceptions_count: currentStore.exceptions.length,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ── GET /api/payments — List user/synced payments ────────────────────────────
app.get('/api/payments', (req, res) => {
  try {
    const payments = store.getPayments();
    return res.json({ count: payments.length, payments });
  } catch (err) {
    console.error('[GET /api/payments] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch payments.' });
  }
});

// ── GET /api/settlements — List settlement batches with aggregate financials ──
app.get('/api/settlements', (req, res) => {
  try {
    const batches = store.getSettlementBatches();
    const records = store.getSettlementRecords();

    const batchesWithDetails = batches.map(b => {
      const batchRecords = records.filter(r => r.settlement_id === b.id);
      const gross = batchRecords.reduce((s, r) => s + (r.amount || 0), 0);
      const credit = batchRecords.reduce((s, r) => s + (r.credit || 0), 0);
      const fee = batchRecords.reduce((s, r) => s + (r.fee || 0), 0);
      const tax = batchRecords.reduce((s, r) => s + (r.tax || 0), 0);

      return {
        ...b,
        records_count: batchRecords.length,
        total_gross_paise: gross,
        total_gross_inr: (gross / 100).toFixed(2),
        total_credit_paise: credit,
        total_credit_inr: (credit / 100).toFixed(2),
        total_fee_paise: fee,
        total_fee_inr: (fee / 100).toFixed(2),
        total_tax_paise: tax,
        total_tax_inr: (tax / 100).toFixed(2),
        records: batchRecords,
      };
    });

    return res.json({ count: batches.length, batches: batchesWithDetails, records });
  } catch (err) {
    console.error('[GET /api/settlements] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch settlements.' });
  }
});

// ── LOCAL DEMO PAYMENT (Offline / Zero-Credential Flow) ──────────────────────
/**
 * POST /api/payments/local
 * Body: { amount: number (in paise), payment_method, customer_ref, description, anomaly_type }
 * Immediately creates payment, generates settlement record, and runs reconciliation.
 */
app.post('/api/payments/local', (req, res) => {
  try {
    const {
      amount,
      payment_method = 'card',
      customer_ref,
      description,
      anomaly_type = 'CLEAN_MATCH',
    } = req.body;

    if (!amount || typeof amount !== 'number' || isNaN(amount) || amount < 100 || amount > 50000000) {
      return res.status(400).json({
        error: 'Amount must be a valid number between ₹1.00 (100 paise) and ₹5,00,000.00 (50,000,000 paise).',
      });
    }

    const amountPaise = Math.round(amount);
    const timeSuffix = Date.now().toString(36);
    const randSuffix = Math.random().toString(36).slice(2, 6);
    const paymentId = `pay_local_${timeSuffix}_${randSuffix}`;
    const orderId = customer_ref || `order_local_${timeSuffix}`;

    // Ingest directly into Payvault's deterministic pipeline
    const ingested = store.addPaymentTransaction({
      payment_id:   paymentId,
      id:           paymentId,
      order_id:     orderId,
      amount_paise: amountPaise,
      currency:     'INR',
      method:       payment_method,
      receipt:      `rcpt_local_${timeSuffix}`,
      description:  description || `Local payment for ${orderId}`,
      anomaly:      anomaly_type,
      created_at:   Math.floor(Date.now() / 1000),
    });

    const isException = !!ingested.exception || ingested.reconciliation_result?.status === 'EXCEPTION';

    return res.status(200).json({
      success:               true,
      mode:                  'LOCAL_DEMO',
      id:                    paymentId,
      payment_id:            paymentId,
      order_id:              orderId,
      amount:                amountPaise,
      amount_paise:          amountPaise,
      gross_amount_inr:      (amountPaise / 100).toFixed(2),
      settlement_record:     ingested.settlement_record,
      reconciliation_result: ingested.reconciliation_result,
      is_exception:          isException,
      exception:             ingested.exception,
      message:               isException
        ? `Payment processed with discrepancy (${ingested.exception?.category || 'Exception'}). Investigation created.`
        : 'Payment successfully processed and cleanly reconciled.',
      summary:               store.getSummary(),
    });
  } catch (err) {
    console.error('[payments/local] Error:', err);
    return res.status(500).json({ error: 'Failed to process local demo payment.' });
  }
});

// ── STEP 1: Create Order (Razorpay Gateway Flow) ─────────────────────────────
/**
 * POST /api/create-order
 * Body: { amount: number (in paise), currency?: string, receipt?: string }
 * Returns: { key_id, order_id, amount, currency }
 */
app.post('/api/create-order', async (req, res) => {
  const hasKey = !!RAZORPAY_KEY_ID;
  const hasSecret = !!RAZORPAY_KEY_SECRET;
  console.log(`[create-order] Gateway Credentials Check: Key ID=${hasKey ? 'DETECTED' : 'MISSING'}, Key Secret=${hasSecret ? 'DETECTED' : 'MISSING'}`);

  try {
    const { amount, currency = 'INR', receipt } = req.body;

    // Validate amount — Razorpay minimum is 100 paise (₹1) and max ₹5,00,000
    if (!amount || typeof amount !== 'number' || isNaN(amount) || amount < 100 || amount > 50000000) {
      console.warn(`[create-order] Invalid amount specified: ${amount}`);
      return res.status(400).json({
        error: 'Amount must be a valid number between ₹1.00 (100 paise) and ₹5,00,000.00 (50,000,000 paise).',
      });
    }

    const orderReceipt = receipt || `rcpt_${Date.now()}`;
    const options = {
      amount: Math.round(amount),
      currency,
      receipt: orderReceipt,
      payment_capture: 1,
    };

    console.log(`[create-order] Attempting Razorpay order creation: amount=${options.amount} paise (₹${(options.amount / 100).toFixed(2)}), receipt=${orderReceipt}`);

    const order = await razorpay.orders.create(options);

    console.log(`[create-order] Razorpay order created successfully: order_id=${order.id}, amount=${order.amount} ${order.currency}`);

    return res.status(200).json({
      key_id: RAZORPAY_KEY_ID, // Essential: needed by frontend Razorpay Checkout SDK
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
    });
  } catch (err) {
    console.error(`[create-order] Razorpay order creation failed: status=${err.statusCode || 500}, message=${err.error?.description || err.message}`);

    if (err.statusCode === 401) {
      return res.status(401).json({ error: 'Razorpay authentication failed. Check your API keys in .env.' });
    }

    return res.status(500).json({ error: err.error?.description || err.message || 'Failed to create Razorpay order.' });
  }
});

// ── STEP 3: Verify Payment Signature & Ingest into Settlement Pipeline ────────
/**
 * POST /api/verify-payment
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, simulate_exception }
 * Returns: { success: true, payment_id, order_id, settlement_status, ... }
 */
app.post('/api/verify-payment', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    amount,
    receipt,
    description,
    simulate_exception,
  } = req.body;

  // Validate required fields
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({
      error: 'Missing required fields: razorpay_order_id, razorpay_payment_id, razorpay_signature.',
    });
  }

  // HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  const signaturesMatch =
    expectedSignature.length === razorpay_signature.length &&
    crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(razorpay_signature, 'hex')
    );

  if (!signaturesMatch) {
    console.warn('[verify-payment] Signature mismatch — potential tampered response.');
    return res.status(400).json({ error: 'Payment verification failed. Signature mismatch.' });
  }

  console.log(`[verify-payment] Payment verified ✓  payment_id=${razorpay_payment_id}`);

  // Fetch real payment metadata from Razorpay API
  let payMeta = null;
  try {
    payMeta = await razorpay.payments.fetch(razorpay_payment_id);
  } catch {
    payMeta = {
      id: razorpay_payment_id,
      order_id: razorpay_order_id,
      amount: typeof amount === 'number' ? Math.round(amount) : 125000,
      currency: 'INR',
      method: 'card',
      email: 'customer@example.com',
    };
  }

  const paymentAmountPaise = (payMeta && typeof payMeta.amount === 'number')
    ? payMeta.amount
    : (typeof amount === 'number' ? Math.round(amount) : 125000);

  // Ingest into Payvault settlement & reconciliation engine
  const ingested = store.addPaymentTransaction({
    payment_id:   razorpay_payment_id,
    order_id:     razorpay_order_id,
    amount_paise: paymentAmountPaise,
    currency:     payMeta.currency || 'INR',
    method:       payMeta.method || 'card',
    receipt:      receipt || payMeta.receipt || null,
    description:  description || payMeta.description || null,
    email:        payMeta.email || null,
    anomaly:      simulate_exception || null,
    created_at:   payMeta.created_at || Math.floor(Date.now() / 1000),
  });

  return res.status(200).json({
    success:                true,
    payment_id:             razorpay_payment_id,
    order_id:               razorpay_order_id,
    amount_paise:           paymentAmountPaise,
    gross_amount_inr:       (paymentAmountPaise / 100).toFixed(2),
    net_credit_paise:       ingested.settlement_record.credit,
    net_credit_inr:         (ingested.settlement_record.credit / 100).toFixed(2),
    fee_paise:              ingested.settlement_record.fee,
    tax_paise:              ingested.settlement_record.tax,
    settlement_id:          ingested.settlement_record.settlement_id,
    settlement_utr:         ingested.settlement_record.settlement_utr,
    settlement_status:      'EXPECTED_T2',
    reconciliation_status:  ingested.reconciliation_status || (ingested.exception ? ingested.exception.category : ingested.status),
    exception:              ingested.exception,
    message:                'Payment verified, settlement simulated, and reconciliation updated.',
    summary:                store.getSummary(),
  });
});

async function initDatabases() {
  const pgConnected = await postgres.checkConnection();
  if (pgConnected) {
    try {
      await migrator.runMigrations();
      console.log('[Payvault Boot] Database migrations verified.');
    } catch (err) {
      console.error('[Payvault Boot] Error running migrations:', err.message);
    }
  }
  await redis.checkConnection();
}

async function handleShutdown(signal) {
  console.log(`\n[Payvault] Received ${signal}. Shutting down gracefully...`);
  try {
    await postgres.close();
    await redis.close();
    console.log('[Payvault] Database connections cleanly closed.');
  } catch (err) {
    console.error('[Payvault] Error during database shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ── Start server ──────────────────────────────────────────────────────────────
if (require.main === module) {
  initDatabases().finally(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀  Razorpay checkout server running at http://localhost:${PORT}\n`);
    });
  });
}

module.exports = app;
module.exports.initDatabases = initDatabases;
