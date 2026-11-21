'use strict';
/*
 * Tests the real API route handlers and business logic against an in-memory stand-in for
 * the Prisma client (it implements only the calls lib/logic.js makes). This checks OUR logic;
 * it does not exercise Prisma or Postgres themselves.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.API_TOKEN = 'test-token-0123456789abcdef';
process.env.MIN_RIDE_SECONDS = '1';
const TOKEN = process.env.API_TOKEN;

const Geo = require('../public/geo.js');
const { setClientForTests } = require('../lib/db');

/* ---------- fake Prisma ---------- */
function makeFake() {
  const defaults = {
    parking: () => ({ accuracy: null, note: '', leftAt: null, parkedAt: new Date() }),
    ride: () => ({ startedAt: new Date(), endedAt: null, startLat: null, startLng: null, endLat: null, endLng: null, durationS: null, distanceM: null }),
  };
  const matches = (row, where = {}) => Object.entries(where).every(([k, cond]) => {
    if (cond === null) return row[k] == null;
    if (cond && typeof cond === 'object' && 'not' in cond) return cond.not === null ? row[k] != null : row[k] !== cond.not;
    return row[k] === cond;
  });
  const model = (name) => {
    const rows = [];
    return {
      rows,
      async findFirst({ where, orderBy } = {}) { return (await this.findMany({ where, orderBy, take: 1 }))[0] || null; },
      async findMany({ where, orderBy, take } = {}) {
        let out = rows.filter((r) => matches(r, where));
        if (orderBy) {
          const [[f, dir]] = Object.entries(orderBy);
          out = out.slice().sort((a, b) => (a[f] - b[f]) * (dir === 'desc' ? -1 : 1));
        }
        return (take ? out.slice(0, take) : out).map((r) => ({ ...r }));
      },
      async create({ data }) { const r = { id: crypto.randomUUID(), ...defaults[name](), ...data }; rows.push(r); return { ...r }; },
      async update({ where, data }) {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('Record not found');
        Object.assign(r, data); return { ...r };
      },
      async updateMany({ where, data }) { const hit = rows.filter((r) => matches(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
      async deleteMany({ where }) {
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length; rows.length = 0; rows.push(...keep); return { count };
      },
    };
  };
  const db = { parking: model('parking'), ride: model('ride') };
  db.$transaction = async (fn) => fn(db);
  return db;
}

const fake = makeFake();
setClientForTests(fake);

/* ---------- invoke handlers like Vercel would ---------- */
const routes = {
  state: require('../api/state'), event: require('../api/event'), parked: require('../api/parked'),
  moved: require('../api/moved'), parking: require('../api/parkings/[id]'), ride: require('../api/rides/[id]'),
};

async function call(route, method, body, { query, token = TOKEN, rawBody } = {}) {
  const req = {
    method, query: query || {}, body: rawBody !== undefined ? rawBody : body,
    headers: token ? { authorization: 'Bearer ' + token } : {},
  };
  const res = {
    headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s; },
  };
  await routes[route](req, res);
  return { status: res.statusCode, json: JSON.parse(res.body), headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

(async () => {
  await t('parseLocation handles coordinates and map links', () => {
    assert.deepEqual(Geo.parseLocation('32.0853, 34.7818'), { lat: 32.0853, lng: 34.7818 });
    assert.deepEqual(Geo.parseLocation('https://www.google.com/maps/place/X/@32.0853,34.7818,17z'), { lat: 32.0853, lng: 34.7818 });
    assert.equal(Geo.parseLocation('95, 34'), null);
  });

  await t('auth: no/wrong token is 401, missing server token is a clear 500', async () => {
    assert.equal((await call('state', 'GET', null, { token: '' })).status, 401);
    assert.equal((await call('state', 'GET', null, { token: 'wrong' })).status, 401);
    assert.equal((await call('state', 'GET')).status, 200);
    const saved = process.env.API_TOKEN;
    delete process.env.API_TOKEN;
    const r = await call('state', 'GET');
    process.env.API_TOKEN = saved;
    assert.equal(r.status, 500);
    assert.match(r.json.error, /API_TOKEN/);
  });

  await t('wrong HTTP method is 405', async () => {
    assert.equal((await call('state', 'POST', {})).status, 405);
    assert.equal((await call('event', 'GET')).status, 405);
  });

  await t('fresh state is empty and has the shape the web app expects', async () => {
    const { json } = await call('state', 'GET');
    assert.equal(json.current, null);
    assert.equal(json.ride, null);
    assert.deepEqual(json.parkings, []);
    assert.deepEqual(json.rides, []);
    assert.equal(typeof json.serverTime, 'number');
  });

  await t('manual parking: validates, trims note, returns numeric timestamps', async () => {
    assert.equal((await call('parked', 'POST', { lat: 999, lng: 1 })).status, 400);
    assert.equal((await call('parked', 'POST', { lat: 'abc', lng: 1 })).status, 400);
    const r = await call('parked', 'POST', { lat: 32.0853, lng: 34.7818, accuracy: 12.4, note: ' level 2 ' });
    assert.equal(r.status, 200);
    const c = r.json.current;
    assert.equal(c.note, 'level 2');
    assert.equal(c.source, 'manual');
    assert.equal(c.accuracy, 12);
    assert.equal(typeof c.ts, 'number');
    assert.equal(c.leftTs, undefined);
  });

  await t('note can be edited', async () => {
    const r = await call('parked', 'PATCH', { note: 'near the elevator' });
    assert.equal(r.json.current.note, 'near the elevator');
  });

  await t('car connects -> old spot goes to history with leftTs, ride starts', async () => {
    const r = await call('event', 'POST', { type: 'connect', latitude: 32.0853, longitude: 34.7818 });
    assert.equal(r.status, 200);
    assert.equal(r.json.current, null);
    assert.ok(r.json.ride && typeof r.json.ride.startTs === 'number');
    assert.equal(r.json.parkings.length, 1);
    assert.equal(typeof r.json.parkings[0].leftTs, 'number');
    assert.equal(r.json.parkings[0].note, 'near the elevator');
  });

  await t('duplicate connect keeps the original ride start', async () => {
    const a = (await call('state', 'GET')).json.ride.startTs;
    const r = await call('event', 'POST', { type: 'connect', latitude: 1, longitude: 1 });
    assert.equal(r.json.ride.startTs, a);
    assert.equal(fake.ride.rows.filter((x) => !x.endedAt).length, 1);
  });

  await t('Bluetooth blip: no ride logged, but the spot is saved', async () => {
    const r = await call('event', 'POST', { type: 'disconnect', latitude: 32.09, longitude: 34.79 });
    assert.equal(r.json.ride, null);
    assert.equal(r.json.rides.length, 0);
    assert.equal(r.json.current.source, 'auto');
  });

  await t('repeated disconnect within 5 min replaces the spot instead of duplicating; accepts "32,1" strings', async () => {
    const before = (await call('state', 'GET')).json.parkings.length;
    const r = await call('event', 'POST', { type: 'disconnect', latitude: '32,1000', longitude: '34.8000' });
    assert.equal(r.json.current.lat, 32.1);
    assert.equal(r.json.parkings.length, before);
    assert.equal(fake.parking.rows.filter((x) => !x.leftAt).length, 1);
  });

  await t('bad event input is rejected', async () => {
    assert.equal((await call('event', 'POST', { type: 'disconnect' })).status, 400);
    assert.equal((await call('event', 'POST', { type: 'banana' })).status, 400);
  });

  await t('full ride: duration and straight-line distance are logged', async () => {
    await call('event', 'POST', { type: 'connect', latitude: 32.0853, longitude: 34.7818 });
    await sleep(1200);
    const r = await call('event', 'POST', { type: 'disconnect', latitude: 31.7683, longitude: 35.2137 });
    assert.equal(r.json.ride, null);
    assert.equal(r.json.current.lat, 31.7683);
    assert.equal(r.json.rides.length, 1);
    const ride = r.json.rides[0];
    assert.ok(ride.durationS >= 1);
    assert.ok(ride.distanceM > 52000 && ride.distanceM < 56000, 'distance ' + ride.distanceM);
    assert.equal(typeof ride.endTs, 'number');
  });

  await t('manual parking while a ride is active ends the ride', async () => {
    await call('event', 'POST', { type: 'connect', latitude: 31.7683, longitude: 35.2137 });
    await sleep(1200);
    const r = await call('parked', 'POST', { lat: 31.77, lng: 35.22 });
    assert.equal(r.json.ride, null);
    assert.equal(r.json.rides.length, 2);
    assert.equal(r.json.current.source, 'manual');
  });

  await t('only one current spot and at most one active ride exist at any time', () => {
    assert.equal(fake.parking.rows.filter((x) => !x.leftAt).length, 1);
    assert.equal(fake.ride.rows.filter((x) => !x.endedAt).length, 0);
  });

  await t('deleting history works; current spot and unknown ids are protected', async () => {
    const st = (await call('state', 'GET')).json;
    const pid = st.parkings[0].id;
    const r = await call('parking', 'DELETE', null, { query: { id: pid } });
    assert.ok(!r.json.parkings.some((p) => p.id === pid));
    assert.equal((await call('parking', 'DELETE', null, { query: { id: st.current.id } })).status, 404);
    assert.equal((await call('parking', 'DELETE', null, { query: { id: 'nope' } })).status, 404);
    const rid = st.rides[0].id;
    assert.ok(!(await call('ride', 'DELETE', null, { query: { id: rid } })).json.rides.some((x) => x.id === rid));
  });

  await t('"I took the car" clears the spot, keeps it in history, and is idempotent', async () => {
    const r = await call('moved', 'POST');
    assert.equal(r.json.current, null);
    assert.ok(r.json.parkings.length >= 1);
    assert.equal((await call('moved', 'POST')).status, 200);
    assert.equal((await call('parked', 'PATCH', { note: 'x' })).status, 404);
  });

  await t('body handling: JSON string, Buffer, invalid JSON', async () => {
    const asString = await call('event', 'POST', null, { rawBody: JSON.stringify({ type: 'disconnect', latitude: 1, longitude: 2 }) });
    assert.equal(asString.json.current.lat, 1);
    const asBuffer = await call('event', 'POST', null, { rawBody: Buffer.from(JSON.stringify({ type: 'disconnect', latitude: 3, longitude: 4 })) });
    assert.equal(asBuffer.json.current.lat, 3);
    assert.equal((await call('event', 'POST', null, { rawBody: '{nope' })).status, 400);
  });

  await t('API responses are never cached', async () => {
    assert.equal((await call('state', 'GET')).headers['cache-control'], 'no-store');
  });

  console.log('\n' + passed + ' tests passed');
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
