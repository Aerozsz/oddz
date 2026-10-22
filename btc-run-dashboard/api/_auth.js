// Shared passcode check for the API routes. The page sends the passcode in the x-dashboard-key header.
// When DASHBOARD_KEY is unset the routes are open, which is only meant for local development.
const crypto = require('crypto');

function passcodeOk(req) {
  const key = process.env.DASHBOARD_KEY;
  if (!key) return true;
  const got = String(req.headers['x-dashboard-key'] || '');
  const a = Buffer.from(got), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers || {})) if (v != null) res.setHeader(k, v);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

module.exports = { passcodeOk, send };
