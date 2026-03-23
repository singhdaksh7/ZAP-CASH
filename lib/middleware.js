/**
 * lib/middleware.js
 * Helper wrappers used by every API route.
 */

const { auth } = require("./firebase");

// ─── In-memory sliding-window rate limiter ────────────────────────────────────
// NOTE: Each Vercel serverless instance has its own memory, so this limits
// per-instance. For full distributed limiting, swap the Map for Upstash Redis.
const _rl = new Map(); // key → [timestamps]

/**
 * Throw 429 if the given key exceeds maxReqs within windowMs.
 * @param {string} key      - usually IP or uid
 * @param {number} maxReqs  - max requests allowed in the window
 * @param {number} windowMs - rolling window in ms (default 60 s)
 */
function rateLimit(key, maxReqs = 60, windowMs = 60_000) {
  const now = Date.now();
  const hits = (_rl.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= maxReqs) {
    throw { status: 429, message: "Too many requests — please slow down." };
  }
  hits.push(now);
  _rl.set(key, hits);

  // Periodic cleanup to prevent unbounded memory growth
  if (_rl.size > 5000) {
    for (const [k, v] of _rl) {
      if (v.every((t) => now - t >= windowMs)) _rl.delete(k);
    }
  }
}

/**
 * Extract the best available client IP from Vercel request headers.
 */
function clientIp(req) {
  return (
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Verify Firebase ID token from Authorization: Bearer <token>
 * Returns decoded token or throws.
 */
async function verifyToken(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw { status: 401, message: "Missing auth token" };
  try {
    return await auth.verifyIdToken(token);
  } catch {
    throw { status: 401, message: "Invalid or expired token" };
  }
}

/**
 * Verify token AND check admin custom claim.
 */
async function verifyAdmin(req) {
  const decoded = await verifyToken(req);
  if (!decoded.admin) throw { status: 403, message: "Admin access required" };
  return decoded;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

// ─── Main handler wrapper ─────────────────────────────────────────────────────

/**
 * Wrap a handler with CORS, rate limiting, and error handling.
 *
 * Options:
 *   maxReqs  {number}  – requests per window (default 60)
 *   windowMs {number}  – window in ms (default 60 000)
 *   limitBy  {string}  – "ip" (default) | "none"
 *
 * Usage:
 *   module.exports = handle(async (req, res) => { ... }, { maxReqs: 20 });
 */
function handle(fn, { maxReqs = 60, windowMs = 60_000, limitBy = "ip" } = {}) {
  return async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
      if (limitBy === "ip") {
        rateLimit(clientIp(req), maxReqs, windowMs);
      }
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      const message = err.message || "Internal server error";
      if (status === 500) console.error(`[${req.url}]`, err);
      res.status(status).json({ error: message });
    }
  };
}

module.exports = { verifyToken, verifyAdmin, handle, rateLimit, clientIp };
