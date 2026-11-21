'use strict';
// End-to-end test: starts the real server on a temp dir and walks through a realistic week.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Geo = require('../public/geo.js');

const TOKEN = 'test-token-0123456789abcdef';
const PORT = 3999;
const BASE = 'http://127.0.0.1:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-test-'));

async function call(method, url, body, token = TOKEN) {
  const res = await fetch(BASE + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* static */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

(async () => {
  // --- pure helper tests ---
  await t('parseLocation handles plain coordinates', () => {
    assert.deepEqual(Geo.parseLocation('32.0853, 34.7818'), { lat: 32.0853, lng: 34.7818 });
    assert.deepEqual(Geo.parseLocation('-33.86 151.21'), { lat: -33.86, lng: 151.21 });
  });
  await t('parseLocation handles map links', () => {
    assert.deepEqual(Geo.parseLocation('https://www.google.com/maps/place/X/@32.0853,34.7818,17z/data=!3m1'), { lat: 32.0853, lng: 34.7818 });
    assert.deepEqual(Geo.parseLocation('https://www.google.com/maps?q=32.1,34.8'), { lat: 32.1, lng: 34.8 });
    assert.deepEqual(Geo.parseLocation('https://maps.apple.com/?ll=32.1%2C34.8&z=16'), { lat: 32.1, lng: 34.8 });
    assert.deepEqual(Geo.parseLocation('https://www.openstreetmap.org/?mlat=32.1&mlon=34.8#map=17/32.1/34.8'), { lat: 32.1, lng: 34.8 });
    assert.deepEqual(Geo.parseLocation('geo:32.1,34.8'), { lat: 32.1, lng: 34.8 });
  });
  await t('parseLocation rejects junk and out-of-range values', () => {
    assert.equal(Geo.parseLocation('hello'), null);
    assert.equal(Geo.parseLocation('95, 34'), null);
    assert.equal(Geo.parseLocation('https://maps.app.goo.gl/abc123'), null);
    assert.equal(Geo.parseLocation(''), null);
  });
  await t('haversine is roughly right (Tel Aviv -> Jerusalem ~54 km)', () => {
    const d = Geo.haversine(32.0853, 34.7818, 31.7683, 35.2137);
    assert.ok(d > 52000 && d < 56000, 'got ' + d);
  });

  // --- server ---
  async function startServer() {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, API_TOKEN: TOKEN, MIN_RIDE_SECONDS: '1' }),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let up = false;
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) up = true; });
    for (let i = 0; i < 50 && !up; i++) await sleep(100);
    assert.ok(up, 'server did not start');
    return p;
  }
  let srv = await startServer();

  try {
    await t('refuses to start without a strong token', async () => {
      const bad = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: Object.assign({}, process.env, { PORT: '3998', DATA_DIR: dataDir, API_TOKEN: 'short' }), stdio: 'ignore',
      });
      const code = await new Promise((r) => bad.on('exit', r));
      assert.equal(code, 1);
    });

    await t('healthz is public, API needs the token', async () => {
      assert.equal((await call('GET', '/healthz', null, '')).status, 200);
      assert.equal((await call('GET', '/api/state', null, '')).status, 401);
      assert.equal((await call('GET', '/api/state', null, 'wrong')).status, 401);
      assert.equal((await call('GET', '/api/state')).status, 200);
    });

    await t('serves the app and blocks path traversal', async () => {
      const html = await fetch(BASE + '/');
      assert.equal(html.status, 200);
      assert.match(await html.text(), /Where's my car/);
      assert.equal((await fetch(BASE + '/app.js')).status, 200);
      assert.equal((await fetch(BASE + '/icon-192.png')).headers.get('content-type'), 'image/png');
      assert.equal((await fetch(BASE + '/..%2Fserver.js')).status, 404);
      assert.equal((await fetch(BASE + '/%2e%2e/server.js')).status, 404);
      assert.equal((await fetch(BASE + '/nope')).status, 404);
    });

    await t('fresh state is empty', async () => {
      const { json } = await call('GET', '/api/state');
      assert.equal(json.current, null);
      assert.equal(json.ride, null);
    });

    await t('manual parking saves location + note and validates input', async () => {
      assert.equal((await call('POST', '/api/parked', { lat: 999, lng: 1 })).status, 400);
      assert.equal((await call('POST', '/api/parked', { lat: 'abc', lng: 1 })).status, 400);
      const r = await call('POST', '/api/parked', { lat: 32.0853, lng: 34.7818, accuracy: 12.4, note: ' level 2 ' });
      assert.equal(r.status, 200);
      assert.equal(r.json.current.note, 'level 2');
      assert.equal(r.json.current.source, 'manual');
      assert.equal(r.json.current.accuracy, 12);
    });

    await t('note can be edited', async () => {
      const r = await call('PATCH', '/api/parked', { note: 'near the elevator' });
      assert.equal(r.json.current.note, 'near the elevator');
    });

    await t('parking persists across a real server restart (weeks-long memory)', async () => {
      srv.kill();
      await new Promise((r) => srv.on('exit', r));
      srv = await startServer();
      const { json } = await call('GET', '/api/state');
      assert.equal(json.current.lat, 32.0853);
      assert.equal(json.current.note, 'near the elevator');
    });

    await t('car connects -> old spot moves to history, ride starts', async () => {
      const r = await call('POST', '/api/event', { type: 'connect', latitude: 32.0853, longitude: 34.7818 });
      assert.equal(r.status, 200);
      assert.equal(r.json.current, null);
      assert.ok(r.json.ride);
      assert.equal(r.json.parkings.length, 1);
      assert.ok(r.json.parkings[0].leftTs);
    });

    await t('duplicate connect keeps the original ride start', async () => {
      const a = (await call('GET', '/api/state')).json.ride.startTs;
      const r = await call('POST', '/api/event', { type: 'connect', latitude: 1, longitude: 1 });
      assert.equal(r.json.ride.startTs, a);
    });

    await t('short Bluetooth blip is not logged as a ride, but spot is saved', async () => {
      const r = await call('POST', '/api/event', { type: 'disconnect', latitude: 32.09, longitude: 34.79 });
      assert.equal(r.json.ride, null);
      assert.equal(r.json.rides.length, 0);
      assert.equal(r.json.current.source, 'auto');
    });

    await t('accepts string coordinates incl. comma decimals (Shortcuts locales)', async () => {
      const r = await call('POST', '/api/event', { type: 'disconnect', latitude: '32,1000', longitude: '34.8000' });
      assert.equal(r.json.current.lat, 32.1);
      assert.equal(r.json.current.lng, 34.8);
    });

    await t('disconnect without location is rejected; unknown type is rejected', async () => {
      assert.equal((await call('POST', '/api/event', { type: 'disconnect' })).status, 400);
      assert.equal((await call('POST', '/api/event', { type: 'banana' })).status, 400);
    });

    await t('full ride: connect, drive, disconnect -> ride logged with duration and distance', async () => {
      await call('POST', '/api/event', { type: 'connect', latitude: 32.0853, longitude: 34.7818 });
      await sleep(1300);
      const r = await call('POST', '/api/event', { type: 'disconnect', latitude: 31.7683, longitude: 35.2137 });
      assert.equal(r.status, 200);
      assert.equal(r.json.ride, null);
      assert.equal(r.json.current.lat, 31.7683);
      assert.equal(r.json.rides.length, 1);
      assert.ok(r.json.rides[0].durationS >= 1);
      assert.ok(r.json.rides[0].distanceM > 52000 && r.json.rides[0].distanceM < 56000);
    });

    await t('manual parking while a ride is active ends the ride', async () => {
      await call('POST', '/api/event', { type: 'connect', latitude: 31.7683, longitude: 35.2137 });
      await sleep(1300);
      const r = await call('POST', '/api/parked', { lat: 31.77, lng: 35.22 });
      assert.equal(r.json.ride, null);
      assert.equal(r.json.rides.length, 2);
      assert.equal(r.json.current.source, 'manual');
    });

    await t('deleting history entries works', async () => {
      const st = (await call('GET', '/api/state')).json;
      assert.ok(st.parkings.length >= 1);
      const id = st.parkings[0].id;
      const r = await call('DELETE', '/api/parkings/' + id);
      assert.ok(!r.json.parkings.some((p) => p.id === id));
      assert.equal((await call('DELETE', '/api/parkings/not-a-uuid')).status, 404);
    });

    await t('"I took the car" clears current spot and archives it', async () => {
      const r = await call('POST', '/api/moved');
      assert.equal(r.json.current, null);
      assert.ok(r.json.parkings.length >= 1);
      assert.equal((await call('POST', '/api/moved')).status, 200); // idempotent
    });

    await t('bad JSON and oversized bodies are rejected', async () => {
      const res = await fetch(BASE + '/api/event', {
        method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: '{nope',
      });
      assert.equal(res.status, 400);
      const big = await fetch(BASE + '/api/event', {
        method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'connect', pad: 'x'.repeat(40000) }),
      }).then((r) => r.status).catch(() => 'closed');
      assert.ok(big === 413 || big === 'closed', 'got ' + big);
    });

    await t('brute force is rate limited', async () => {
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await call('GET', '/api/state', null, 'guess' + i)).status;
      assert.equal(last, 429);
      // even the right token is blocked from that IP for the window: expected behaviour
      assert.equal((await call('GET', '/api/state')).status, 429);
    });
  } finally {
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('\n' + passed + ' tests passed');
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
