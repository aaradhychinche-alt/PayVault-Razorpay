# Payvault Investigation Intelligence Fix - Testing Checklist

## Summary of Changes

### Backend Changes
1. **ModelRouter** (`src/investigation/ai/model/modelRouter.js`)
   - Fixed `qwenEnabled` default: Now requires explicit `ENABLE_OLLAMA=true` or `AI_QWEN_ENABLED=true`
   - Fixed routing logic: Qwen only invoked when enabled AND (forceQwen OR shouldEscalate)
   - Added clear logging when Qwen is disabled

2. **Formatter** (`src/investigation/ai/formatter.js`)
   - Added `qwen_escalated` flag to `ai_metadata`
   - Added `routing` object with detailed routing information
   - Ensures provenance accuracy

3. **Environment** (`.env`)
   - Set `ENABLE_OLLAMA=false` as default
   - Set `AI_QWEN_ENABLED=false` for backward compatibility
   - Added comprehensive documentation

### Frontend Changes
4. **Provenance Display** (`public/checkout.js` lines 1243-1271)
   - Fixed to check THREE conditions before showing Qwen:
     - `ai.ai_analysis.provider === 'OLLAMA_QWEN'`
     - `ai.ai_metadata.qwen_escalated === true`
     - `ai.routing.qwen_invoked === true`
   - Only shows "Qwen via Ollama" if all three are true
   - Otherwise shows "Payvault Local Intelligence"

---

## Automated Test Status

### ✅ Unit Tests
```bash
cd /Users/aaradhychinche/RazorPay
npm test
```

**Expected Output:**
```
[AI Trace] Qwen/Ollama disabled (ENABLE_OLLAMA not set to 'true'). 
Using Payvault Local Intelligence for case exc_XXXXX.
```

**Status:** ✅ PASSING (confirmed)

---

## Manual Testing Required

### TEST 1: Default Investigation (Ollama Disabled) ⚠️ REQUIRED

**Setup:**
```bash
# Verify .env has:
ENABLE_OLLAMA=false
AI_QWEN_ENABLED=false

# Server is running at http://localhost:3000
```

**Steps:**
1. Open http://localhost:3000 in browser
2. Open browser DevTools Console
3. Click "New Payment"
4. Fill in:
   - Amount: ₹5,000
   - Merchant Order Reference: TEST001
   - Select any anomaly (e.g., "Fee/Tax Variance")
   - Execution Mode: Local Demo
5. Click "Create Payment"
6. Navigate to "Investigations" tab
7. Click "Run Payvault Investigation" on the new case
8. Wait for investigation to complete
9. Verify the provenance panel

**Expected Results:**
- ✅ Investigation completes successfully
- ✅ Browser console shows: `[AI Trace] Qwen/Ollama disabled. Using Payvault Local Intelligence`
- ✅ NO Ollama HTTP requests in Network tab
- ✅ Provenance shows:
  ```
  INVESTIGATION INTELLIGENCE PROVENANCE
  
  DETERMINISTIC RECONCILIATION
  ✓ Verified (Integer-Paise Engine)
  
  HISTORICAL PATTERN ANALYSIS
  ✓ X similar cases · Y pattern(s)
  
  LOCAL INTELLIGENCE
  ✓ Payvault Local Intelligence
  LOCAL IN-PROCESS
  ```
- ✅ NO mention of "Qwen" or "Ollama" anywhere in the UI
- ✅ Investigation findings are complete with:
  - What Happened?
  - Why Does It Matter?
  - What Should I Do?
  - Evidence chips
  - Financial breakdown

**If This Fails:**
- Check server console for errors
- Verify .env was loaded (restart server if needed)
- Check browser console for JavaScript errors

---

### TEST 2: Multiple Investigations Without Ollama ⚠️ REQUIRED

**Setup:**
Same as TEST 1

**Steps:**
1. Create 5 different payments with different anomalies:
   - Payment 1: Fee/Tax Variance, ₹5,000
   - Payment 2: Duplicate, ₹10,000
   - Payment 3: Settlement Mismatch, ₹7,500
   - Payment 4: Refund Reconciliation, ₹3,000
   - Payment 5: Fee/Tax Variance, ₹15,000
2. Run investigation on all 5 cases
3. Verify each investigation completes successfully

**Expected Results:**
- ✅ All 5 investigations complete
- ✅ All show "Payvault Local Intelligence" in provenance
- ✅ None invoke Ollama
- ✅ All have complete findings
- ✅ No crashes or errors

---

### TEST 3: Ollama Enabled (Optional Enhancement) 🔵 OPTIONAL

**Setup:**
```bash
# Modify .env:
ENABLE_OLLAMA=true
AI_QWEN_ENABLED=true

# Ensure Ollama is running:
ollama serve
# In another terminal:
ollama pull qwen2.5:1.5b

# Restart server:
npm start
```

**Steps:**
1. Create a payment with complex anomaly
2. Run investigation
3. Check provenance display

**Expected Results:**
- ✅ Investigation completes (with or without Qwen depending on difficulty)
- ✅ If Qwen runs: Provenance shows "✓ Qwen 2.5 (1.5B) via Ollama"
- ✅ If Qwen doesn't run: Provenance shows "✓ Payvault Local Intelligence"
- ✅ Deterministic findings remain authoritative
- ✅ Financial calculations are exact (integer-paise)

---

### TEST 4: Graceful Degradation (Ollama Enabled but Unavailable) ⚠️ REQUIRED

**Setup:**
```bash
# Modify .env:
ENABLE_OLLAMA=true

# Stop Ollama if running:
pkill ollama

# Restart server:
npm start
```

**Steps:**
1. Create payment with anomaly
2. Run investigation
3. Check behavior

**Expected Results:**
- ✅ Investigation completes successfully (NO CRASH)
- ✅ Console shows: `[AI Trace] Ollama runtime not available. Using Payvault Local Intelligence`
- ✅ Provenance shows "✓ Payvault Local Intelligence"
- ✅ Investigation findings are complete
- ✅ Application remains fully functional

**This Proves:**
- Payvault does NOT require Ollama to function
- Graceful fallback works correctly
- No blocking errors

---

### TEST 5: Payment Issues Verification ⚠️ CRITICAL

From the previous bug report, verify these are fixed:

#### A. Payment Verification Error

**Steps:**
1. ENABLE_OLLAMA=false
2. Create payment via Razorpay Test Mode
3. Complete payment in Razorpay Checkout modal
4. Verify payment success flow

**Expected:**
- ✅ NO error: "amount_paise is not defined"
- ✅ Payment appears in transaction list immediately
- ✅ Investigation count updates
- ✅ Reconciliation data updates
- ✅ Form resets automatically

**If "amount_paise is not defined" still occurs:**
- Open browser DevTools
- Check Console for error stack trace
- Note exact line number and function
- Report back for further debugging

#### B. Form Reset After Payment

**Expected:**
- ✅ Amount field clears
- ✅ Merchant Order Reference clears
- ✅ Anomaly selection resets
- ✅ Execution mode returns to default
- ✅ NO page refresh required

#### C. Razorpay Test Mode Behavior

**Verify:**
- ✅ Razorpay Checkout modal opens
- ✅ Uses actual Razorpay test credentials
- ✅ Does NOT silently simulate
- ✅ Payment ID generated by Razorpay
- ✅ Settlement created after payment

---

### TEST 6: Investigation Lifecycle ⚠️ REQUIRED

**Steps:**
1. Create payment → Run investigation (should be OPEN → IN_REVIEW)
2. Click "Resolve" on investigation
3. Verify case moves to "Resolved" tab
4. Check "All" tab - resolved case should NOT appear
5. Check investigation count badge in navigation

**Expected:**
- ✅ OPEN → IN_REVIEW transition on investigation start
- ✅ IN_REVIEW → RESOLVED transition on resolve
- ✅ Resolved cases disappear from "All" active view
- ✅ Resolved cases appear in "Resolved" tab
- ✅ Investigation badge count updates immediately
- ✅ NO page refresh required

---

## Test Results Template

Please test and report results:

```
## TEST RESULTS - [Date]

Environment:
- ENABLE_OLLAMA: [false/true]
- Ollama Running: [yes/no]
- Browser: [Chrome/Firefox/Safari]

### TEST 1: Default Investigation ✅ / ❌
- Investigation completed: ✅ / ❌
- Console log correct: ✅ / ❌
- Provenance shows "Payvault Local Intelligence": ✅ / ❌
- No Qwen mentioned: ✅ / ❌
- Notes: [any observations]

### TEST 2: Multiple Investigations ✅ / ❌
- All 5 completed: ✅ / ❌
- All show Payvault: ✅ / ❌
- Notes: [any observations]

### TEST 4: Graceful Degradation ✅ / ❌
- No crash: ✅ / ❌
- Fallback message correct: ✅ / ❌
- Investigation complete: ✅ / ❌
- Notes: [any observations]

### TEST 5A: Payment Verification ✅ / ❌
- No "amount_paise" error: ✅ / ❌
- Payment success flow works: ✅ / ❌
- If error occurred, stack trace: [paste here]

### TEST 5B: Form Reset ✅ / ❌
- Form clears after payment: ✅ / ❌
- Notes: [any observations]

### TEST 6: Investigation Lifecycle ✅ / ❌
- Status transitions correct: ✅ / ❌
- Resolved cases move correctly: ✅ / ❌
- Counts update: ✅ / ❌
- Notes: [any observations]
```

---

## Server Commands

```bash
# Start server
cd /Users/aaradhychinche/RazorPay
npm start
# Access: http://localhost:3000

# Run tests
npm test

# Check environment
cat .env | grep OLLAMA

# Restart server (if .env changed)
# Stop: Ctrl+C in terminal
# Start: npm start
```

---

## Key Success Metrics

1. ✅ **Investigations work WITHOUT Ollama** (most important)
2. ✅ **Provenance is honest** (only shows Qwen if it actually ran)
3. ✅ **No crashes when Ollama unavailable**
4. ✅ **Deterministic engine remains authoritative**
5. ✅ **Payment flow completes without "amount_paise" error**
6. ✅ **UI updates immediately without refresh**

---

## Current Status

- ✅ Code changes complete
- ✅ Unit tests passing
- ⚠️ Manual testing required
- 📊 Awaiting test results

**Next Steps:**
1. Run TEST 1 (Default Investigation)
2. Run TEST 4 (Graceful Degradation)
3. Run TEST 5A (Payment Verification)
4. Report results

If all tests pass, the fix is complete and working correctly.
