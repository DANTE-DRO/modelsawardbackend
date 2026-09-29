// mpesa.js — M-Pesa STK Push via Paystack (Kenya mobile_money channel)
// ---------------------------------------------------------------------------
// GATEWAY CHANGE (2026-09-28): KCB Buni replaced with Paystack.
// This module intentionally keeps the EXACT same exported interface and
// response shapes as before ({ stkPush, simulateConfirm, queryStkStatus,
// getAccessToken, MODE } and { MerchantRequestID, CheckoutRequestID, ... }),
// so server.js, the STK panel, the frontend, and the database layer remain
// completely untouched. Internally every call now goes to Paystack:
//   - STK push  : POST https://api.paystack.co/charge  (mobile_money/mpesa)
//   - Status    : GET  https://api.paystack.co/charge/:reference
//   - Reference : Paystack charge reference is used as the CheckoutRequestID
// Falls back to a simulated flow when mode is sandbox and no secret key.
// ---------------------------------------------------------------------------

const { v4: uuid } = require('uuid');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const PAYSTACK_BASE_URL = (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/$/, '');
const PAYSTACK_CHARGE_ENDPOINT = `${PAYSTACK_BASE_URL}/charge`;
const PAYSTACK_CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL || process.env.MPESA_CALLBACK_URL || 'https://modelsawardbackend.onrender.com/callback';

// MODE semantics preserved for server.js:
//   'live'    → real Paystack STK pushes, simulate-confirm disabled
//   'sandbox' → simulated flow allowed (only when no secret key configured)
const MODE = (process.env.PAYSTACK_MODE || process.env.MPESA_MODE || (PAYSTACK_SECRET_KEY ? 'live' : 'sandbox')).toLowerCase();

// In-memory state for pending simulated transactions (sandbox mode only)
const pending = new Map();

/**
 * Normalise a Kenyan phone to the 2547XXXXXXXX / 2541XXXXXXXX format
 * Paystack expects for mobile_money charges.
 */
function toPaystackPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  // Paystack Kenya mobile_money requires E.164 with a leading '+'
  // (verified against the live API: bare "254..." is rejected).
  return '+' + p;
}

/**
 * Paystack requires an email on every charge. Voting is phone-based, so we
 * derive a stable, valid placeholder email from the phone number.
 */
function placeholderEmail(phone) {
  return `vote-${phone}@galla-awards.co.ke`;
}

/**
 * Trigger an STK push (customer receives a prompt on their phone).
 *
 * Real Paystack M-Pesa charge. If the call fails (network / credentials
 * unavailable) and mode is sandbox, we fall back to a simulated push so the
 * frontend still functions end-to-end for testing.
 *
 * Returns the same shape server.js already consumes:
 *   { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription,
 *     CustomerMessage, _simulated? }
 * where CheckoutRequestID = the Paystack charge reference.
 */
async function stkPush({ phone, amount, accountRef, description }) {
  // Sandbox / simulated path (used when explicitly requested or when creds are missing)
  const simulated = () => {
    const checkoutId = 'ws_CO_' + Date.now() + '_' + uuid().slice(0, 8);
    const merchantId = uuid().slice(0, 12);
    console.log(`[paystack:sim] STK push (fallback) phone=${phone} amount=${amount} checkoutId=${checkoutId}`);
    pending.set(checkoutId, { phone, amount, at: Date.now() });
    return {
      MerchantRequestID: merchantId,
      CheckoutRequestID: checkoutId,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
      _simulated: true,
    };
  };

  if (MODE === 'sandbox' && !PAYSTACK_SECRET_KEY) {
    return simulated();
  }

  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('Paystack secret key not configured (PAYSTACK_SECRET_KEY)');
  }

  try {
    const msisdn = toPaystackPhone(phone);
    // Paystack amounts are in the currency's smallest unit (KES cents).
    const amountInCents = Math.round(Number(amount) * 100);
    const reference = `GALLA-${Date.now()}-${uuid().slice(0, 8).toUpperCase()}`;

    const payload = {
      email: placeholderEmail(msisdn),
      amount: amountInCents,
      currency: 'KES',
      reference,
      mobile_money: {
        phone: msisdn,
        provider: 'mpesa',
      },
      callback_url: PAYSTACK_CALLBACK_URL,
      metadata: {
        account_ref: String(accountRef || 'GALLA').slice(0, 40),
        description: (description || 'Galla Awards vote').slice(0, 80),
        custom_fields: [],
      },
    };

    const resp = await fetch(PAYSTACK_CHARGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    // Paystack shape: { status: true, message: "...", data: { reference, status, ... } }
    const ok = resp.ok && body && body.status === true && body.data;

    if (!ok) {
      console.error('[paystack] STK push failed', resp.status, text.slice(0, 300));
      if (MODE === 'sandbox') return simulated();
      throw new Error((body && body.message) || 'stk_push_failed');
    }

    const data = body.data;
    console.log(`[paystack] STK push OK phone=${msisdn} amount=${amount} reference=${data.reference} status=${data.status}`);
    // Track live push for reference; no auto-resolve.
    pending.set(data.reference, { phone: msisdn, amount, at: Date.now(), live: true });

    return {
      MerchantRequestID: String(data.id || reference),
      CheckoutRequestID: data.reference || reference,
      ResponseCode: '0',
      ResponseDescription: body.message || 'Success. Request accepted for processing',
      CustomerMessage: data.display_text || body.message || 'Success. Request accepted for processing',
    };
  } catch (e) {
    console.error('[paystack] error:', e.message);
    if (MODE === 'sandbox') return simulated();
    throw e;
  }
}

/**
 * Query the live status of an STK push by its Paystack reference
 * (stored as checkout_id in the transactions table).
 * Returns the same normalised object the KCB version returned:
 *   { resultCode, resultDesc, receipt, raw }
 * resultCode: 0 = success, non-zero = failed/cancelled, null = still pending
 */
async function queryStkStatus(checkoutId) {
  if (!checkoutId) return { resultCode: null, resultDesc: 'no_checkout', raw: null };
  if (MODE === 'sandbox' && !PAYSTACK_SECRET_KEY) {
    return { resultCode: null, resultDesc: 'sandbox_mode', raw: null };
  }
  if (!PAYSTACK_SECRET_KEY) {
    return { resultCode: null, resultDesc: 'no_credentials', raw: null };
  }
  try {
    const resp = await fetch(`${PAYSTACK_CHARGE_ENDPOINT}/${encodeURIComponent(checkoutId)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Accept': 'application/json',
      },
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    if (!resp.ok || !body || body.status !== true || !body.data) {
      // Charge not yet readable / transient API issue → treat as still pending.
      return { resultCode: null, resultDesc: (body && body.message) || `http_${resp.status}`, raw: body };
    }

    const data = body.data;
    const st = String(data.status || '').toLowerCase();

    if (st === 'success') {
      return {
        resultCode: 0,
        resultDesc: data.gateway_response || 'The service request is processed successfully.',
        receipt: 'PS' + String(data.reference || checkoutId),
        raw: body,
      };
    }
    if (st === 'failed' || st === 'abandoned' || st === 'reversed') {
      return {
        resultCode: 1,
        resultDesc: data.gateway_response || 'Payment failed or was cancelled.',
        receipt: null,
        raw: body,
      };
    }
    // 'pending' / 'send_otp' / 'ongoing' / anything else → still waiting on the phone.
    return { resultCode: null, resultDesc: st || 'pending', receipt: null, raw: body };
  } catch (e) {
    return { resultCode: null, resultDesc: e.message, raw: null };
  }
}

/**
 * Simulates the customer entering their PIN and paying (sandbox only).
 * In production the confirmation comes via status polling of the Paystack
 * charge endpoint, not this method. Unchanged from the previous gateway.
 */
function simulateConfirm(checkoutId, success = true) {
  const item = pending.get(checkoutId);
  if (!item) return null;
  pending.delete(checkoutId);
  return {
    checkoutId,
    success,
    receipt: success ? 'TEST' + Date.now().toString(36).toUpperCase() : null,
    resultCode: success ? 0 : 1032,
    resultDesc: success ? 'The service request is processed successfully.' : 'Request cancelled by user',
  };
}

/**
 * Legacy export kept for interface compatibility with server.js.
 * Paystack uses a static secret key (no OAuth token exchange), so this is a
 * no-op that simply confirms credentials are present.
 */
async function getAccessToken() {
  if (!PAYSTACK_SECRET_KEY) throw new Error('Paystack secret key not configured');
  return PAYSTACK_SECRET_KEY;
}

module.exports = { stkPush, simulateConfirm, queryStkStatus, getAccessToken, MODE };
