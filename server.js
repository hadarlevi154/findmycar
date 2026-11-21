'use strict';
/*
 * Where's my car - tiny dependency-free server.
 *  - serves the PWA from ./public
 *  - JSON API (single user, protected by a secret token)
 *  - stores everything in one JSON file under DATA_DIR
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { haversine, validLatLng } = require('./public/geo.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN = process.env.API_TOKEN || '';

if (TOKEN.length < 16) {
  console.error('API_TOKEN must be set to a secret of at least 16 characters.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}

const FLICKER_MS = 5 * 60 * 1000;   // a second "disconnect" within 5 min just updates the spot
const MIN_RIDE_S = Number(process.env.MIN_RIDE_SECONDS ?? 30); // ignore Bluetooth blips shorter than this
const MAX_PARKINGS = 200;
const MAX_RIDES = 500;

/* ---------- storage ---------- */
function emptyDb() { return { current: null, ride: null, parkings: [], rides: [] }; }

function loadDb() {
  try {
    return Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read db, starting empty:', e.message);
    return emptyDb();
  }
}

function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

let db = loadDb();

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    let s = v.trim();
    if (s === '') return NaN;
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.'); // "32,0853" from some locales
    return Number(s);
  }
  return NaN;
}

function readLoc(body) {
  const lat = num(body.lat ?? body.latitude);
  const lng = num(body.lng ?? body.lon ?? body.longitude);
  if (!validLatLng(lat, lng)) return null;
  const acc = num(body.accuracy);
  return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
}

function cleanNote(v) {
  return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}

function archiveCurrent(now) {
  if (!db.current) return;
  db.parkings.unshift({ ...db.current, leftTs: now });
  db.parkings.length = Math.min(db.parkings.length, MAX_PARKINGS);
  db.current = null;
}

function setCurrent(loc, source, note, now) {
  if (db.current && now - db.current.ts < FLICKER_MS) {
    db.current = null; // same stop reported twice: replace silently
  } else {
    archiveCurrent(now);
  }
  db.current = {
    id: crypto.randomUUID(), lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy,
    note: note || '', ts: now, source,
  };
}

function startRide(loc, now) {
  if (db.ride) return; // already driving (duplicate "connect")
  db.ride = {
    id: crypto.randomUUID(), startTs: now,
    startLat: loc ? loc.lat : null, startLng: loc ? loc.lng : null,
  };
}

function finishRide(loc, now) {
  const r = db.ride;
  if (!r) return;
  db.ride = null;
  const durationS = Math.round((now - r.startTs) / 1000);
  if (durationS < MIN_RIDE_S) return;
  const hasStart = r.startLat != null && r.startLng != null;
  db.rides.unshift({
    id: r.id, startTs: r.startTs, endTs: now, durationS,
    startLat: r.startLat, startLng: r.startLng,
    endLat: loc ? loc.lat : null, endLng: loc ? loc.lng : null,
    distanceM: hasStart && loc ? Math.round(haversine(r.startLat, r.startLng, loc.lat, loc.lng)) : null,
  });
  db.rides.length = Math.min(db.rides.length, MAX_RIDES);
}

/* ---------- auth ---------- */
const failures = new Map(); // ip -> {count, since}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function checkAuth(req) {
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && Date.now() - f.since < 10 * 60 * 1000 && f.count >= 10) throw new HttpError(429, 'Too many attempts');

  const header = String(req.headers['authorization'] || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-token'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    const cur = f && Date.now() - f.since < 10 * 60 * 1000 ? f : { count: 0, since: Date.now() };
    cur.count += 1;
    failures.set(ip, cur);
    throw new HttpError(401, 'Unauthorized');
  }
  failures.delete(ip);
}

/* ---------- API ---------- */
function stateResponse() {
  return {
    serverTime: Date.now(),
    current: db.current,
    ride: db.ride,
    parkings: db.parkings.slice(0, 50),
    rides: db.rides.slice(0, 50),
  };
}

function handleApi(req, method, pathname, body) {
  const now = Date.now();

  if (method === 'GET' && pathname === '/api/state') return stateResponse();

  // Called by the iPhone Shortcuts automations
  if (method === 'POST' && pathname === '/api/event') {
    const type = String(body.type || '').toLowerCase();
    const loc = readLoc(body);
    if (type === 'connect' || type === 'start') {
      archiveCurrent(now);       // car is moving, old parking spot is no longer valid
      startRide(loc, now);
    } else if (type === 'disconnect' || type === 'park' || type === 'end') {
      if (!loc) throw new HttpError(400, 'latitude and longitude are required for disconnect');
      finishRide(loc, now);
      setCurrent(loc, 'auto', '', now);
    } else {
      throw new HttpError(400, 'type must be "connect" or "disconnect"');
    }
    saveDb(db);
    return stateResponse();
  }

  // Manual entry from the web app
  if (method === 'POST' && pathname === '/api/parked') {
    const loc = readLoc(body);
    if (!loc) throw new HttpError(400, 'Valid lat and lng are required');
    finishRide(loc, now);
    setCurrent(loc, 'manual', cleanNote(body.note), now);
    saveDb(db);
    return stateResponse();
  }

  if (method === 'PATCH' && pathname === '/api/parked') {
    if (!db.current) throw new HttpError(404, 'No parking spot saved');
    db.current.note = cleanNote(body.note);
    saveDb(db);
    return stateResponse();
  }

  // "I took the car" without a ride event
  if (method === 'POST' && pathname === '/api/moved') {
    archiveCurrent(now);
    saveDb(db);
    return stateResponse();
  }

  let m = pathname.match(/^\/api\/(parkings|rides)\/([0-9a-f-]{36})$/);
  if (method === 'DELETE' && m) {
    db[m[1]] = db[m[1]].filter((x) => x.id !== m[2]);
    saveDb(db);
    return stateResponse();
  }

  throw new HttpError(404, 'Not found');
}

/* ---------- http ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

function baseHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  }, extra);
}

function sendJson(res, status, obj) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch (e) { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel))); } catch (e) { file = ''; }
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain' }));
    return res.end('Not found');
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, baseHeaders({
    'Content-Type': type,
    'Cache-Control': file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
  }));
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

    if (url.pathname.startsWith('/api/')) {
      checkAuth(req);
      const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {};
      return sendJson(res, 200, handleApi(req, method, url.pathname, body));
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Parking app listening on :${PORT}, data in ${DATA_DIR}`));
