/**
 * lib/constants.js
 * Centralised constants – import instead of scattering literals across routes.
 */

/** TRC-20 USDT contract address on Tron mainnet */
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/** TronGrid REST base URL */
const TRONGRID_BASE = "https://api.trongrid.io";

/** Default USDT → INR rate (used when Firestore config is missing) */
const DEFAULT_RATE = 87.42;

/** Default platform fee percentage (0.5 %) */
const DEFAULT_FEE_PCT = 0.005;

/** Minimum deposit / withdrawal amount in USDT */
const MIN_AMOUNT_USDT = 10;

/** Google Apps Script webhook – set in env instead if you prefer */
const SHEET_WEBHOOK =
  process.env.SHEET_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbzvGYlfKeXXewlZrW-1dHKkAXkVDkHBMoLU1O5SAOOW819plZFZJHK7f7kUYAWlfZx1Xg/exec";

module.exports = {
  USDT_CONTRACT,
  TRONGRID_BASE,
  DEFAULT_RATE,
  DEFAULT_FEE_PCT,
  MIN_AMOUNT_USDT,
  SHEET_WEBHOOK,
};
