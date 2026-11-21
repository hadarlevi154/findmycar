'use strict';
const { haversine, validLatLng } = require('../public/geo.js');
const { HttpError } = require('./http');
const { prisma } = require('./db');

const FLICKER_MS = 5 * 60 * 1000;                                // repeated "disconnect" within 5 min = same stop
const minRideSeconds = () => Number(process.env.MIN_RIDE_SECONDS ?? 30); // ignore Bluetooth blips

/* ---------- input helpers ---------- */
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

const cleanNote = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

/* ---------- DB rows -> the JSON shape the web app expects ---------- */
function parkingDto(p) {
  if (!p) return null;
  const o = {
    id: p.id, lat: p.lat, lng: p.lng, accuracy: p.accuracy, note: p.note,
    ts: p.parkedAt.getTime(), source: p.source,
  };
  if (p.leftAt) o.leftTs = p.leftAt.getTime();
  return o;
}

const activeRideDto = (r) => r && ({
  id: r.id, startTs: r.startedAt.getTime(), startLat: r.startLat, startLng: r.startLng,
});

const doneRideDto = (r) => ({
  id: r.id, startTs: r.startedAt.getTime(), endTs: r.endedAt.getTime(), durationS: r.durationS,
  startLat: r.startLat, startLng: r.startLng, endLat: r.endLat, endLng: r.endLng, distanceM: r.distanceM,
});

async function readState(db) {
  const current = await db.parking.findFirst({ where: { leftAt: null }, orderBy: { parkedAt: 'desc' } });
  const ride = await db.ride.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } });
  const parkings = await db.parking.findMany({ where: { leftAt: { not: null } }, orderBy: { parkedAt: 'desc' }, take: 50 });
  const rides = await db.ride.findMany({ where: { endedAt: { not: null } }, orderBy: { startedAt: 'desc' }, take: 50 });
  return {
    serverTime: Date.now(),
    current: parkingDto(current),
    ride: activeRideDto(ride),
    parkings: parkings.map(parkingDto),
    rides: rides.map(doneRideDto),
  };
}

/* ---------- mutations (all take a transaction client) ---------- */
async function archiveCurrent(tx, now) {
  await tx.parking.updateMany({ where: { leftAt: null }, data: { leftAt: now } });
}

async function setCurrent(tx, loc, source, note, now) {
  const cur = await tx.parking.findFirst({ where: { leftAt: null }, orderBy: { parkedAt: 'desc' } });
  if (cur && now.getTime() - cur.parkedAt.getTime() < FLICKER_MS) {
    await tx.parking.deleteMany({ where: { leftAt: null } }); // same stop reported twice: replace silently
  } else if (cur) {
    await archiveCurrent(tx, now);
  }
  await tx.parking.create({
    data: { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, note: note || '', source, parkedAt: now },
  });
}

async function startRide(tx, loc, now) {
  const active = await tx.ride.findFirst({ where: { endedAt: null } });
  if (active) return; // duplicate "connect": keep the original start
  await tx.ride.create({
    data: { startedAt: now, startLat: loc ? loc.lat : null, startLng: loc ? loc.lng : null },
  });
}

async function finishRide(tx, loc, now) {
  const r = await tx.ride.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } });
  if (!r) return;
  const durationS = Math.round((now.getTime() - r.startedAt.getTime()) / 1000);
  if (durationS < minRideSeconds()) {
    await tx.ride.deleteMany({ where: { endedAt: null } }); // Bluetooth blip, not a real ride
    return;
  }
  const hasStart = r.startLat != null && r.startLng != null;
  await tx.ride.update({
    where: { id: r.id },
    data: {
      endedAt: now, durationS,
      endLat: loc ? loc.lat : null, endLng: loc ? loc.lng : null,
      distanceM: hasStart && loc ? Math.round(haversine(r.startLat, r.startLng, loc.lat, loc.lng)) : null,
    },
  });
}

/* ---------- operations used by the API routes ---------- */
async function getState() {
  return readState(prisma());
}

async function applyEvent(body) {
  const type = String(body.type || '').toLowerCase();
  const loc = readLoc(body);
  const isStart = type === 'connect' || type === 'start';
  const isEnd = type === 'disconnect' || type === 'park' || type === 'end';
  if (!isStart && !isEnd) throw new HttpError(400, 'type must be "connect" or "disconnect"');
  if (isEnd && !loc) throw new HttpError(400, 'latitude and longitude are required for disconnect');

  const db = prisma();
  const now = new Date();
  await db.$transaction(async (tx) => {
    if (isStart) {
      await archiveCurrent(tx, now); // car is moving, the old spot is no longer valid
      await startRide(tx, loc, now);
    } else {
      await finishRide(tx, loc, now);
      await setCurrent(tx, loc, 'auto', '', now);
    }
  });
  return readState(db);
}

async function saveManual(body) {
  const loc = readLoc(body);
  if (!loc) throw new HttpError(400, 'Valid lat and lng are required');
  const db = prisma();
  const now = new Date();
  await db.$transaction(async (tx) => {
    await finishRide(tx, loc, now);
    await setCurrent(tx, loc, 'manual', cleanNote(body.note), now);
  });
  return readState(db);
}

async function updateNote(body) {
  const db = prisma();
  const cur = await db.parking.findFirst({ where: { leftAt: null }, orderBy: { parkedAt: 'desc' } });
  if (!cur) throw new HttpError(404, 'No parking spot saved');
  await db.parking.update({ where: { id: cur.id }, data: { note: cleanNote(body.note) } });
  return readState(db);
}

async function markMoved() {
  const db = prisma();
  await archiveCurrent(db, new Date());
  return readState(db);
}

async function deleteParking(id) {
  const db = prisma();
  if (typeof id !== 'string' || !id || id.length > 64) throw new HttpError(404, 'Not found');
  const r = await db.parking.deleteMany({ where: { id, leftAt: { not: null } } });
  if (!r.count) throw new HttpError(404, 'Not found');
  return readState(db);
}

async function deleteRide(id) {
  const db = prisma();
  if (typeof id !== 'string' || !id || id.length > 64) throw new HttpError(404, 'Not found');
  const r = await db.ride.deleteMany({ where: { id, endedAt: { not: null } } });
  if (!r.count) throw new HttpError(404, 'Not found');
  return readState(db);
}

module.exports = { getState, applyEvent, saveManual, updateNote, markMoved, deleteParking, deleteRide };
