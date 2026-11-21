'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function checkAuth(req) {
  const token = process.env.API_TOKEN || '';
  if (token.length < 16) throw new HttpError(500, 'Server is missing API_TOKEN (set a random secret of 16+ characters in Vercel env vars)');
  const header = String(req.headers['authorization'] || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-token'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
}

function parseBody(req) {
  let b = req.body;
  if (b == null || b === '') return {};
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { throw new HttpError(400, 'Invalid JSON'); }
  }
  return b && typeof b === 'object' ? b : {};
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/** Wraps handlers per HTTP method: handle({ GET: async ({body, query}) => obj, ... }) */
function handle(methods) {
  return async function (req, res) {
    try {
      const fn = methods[req.method];
      if (!fn) throw new HttpError(405, 'Method not allowed');
      checkAuth(req);
      const out = await fn({ body: parseBody(req), query: req.query || {} });
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Server error (is the database connected and the schema pushed?)' });
    }
  };
}

module.exports = { HttpError, handle };
