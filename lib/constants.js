/**
 * lib/constants.js — Centralised constants for ZAP-CASH
 */

module.exports = {
  DEFAULT_RATE:         87.42,
  DEFAULT_FEE_PCT:      0,       // No percentage fee — selling app mechanism handles margin
  DEFAULT_SELLING_RATE: 105,     // Admin's selling app rate (₹ per USDT)
  MIN_AMOUNT_USDT:      10,

  SHEET_WEBHOOK: "https://script.google.com/macros/s/AKfycbzvGYlfKeXXewlZrW-1dHKkAXkVDkHBMoLU1O5SAOOW819plZFZJHK7f7kUYAWlfZx1Xg/exec",
};
