(function () {
  'use strict';

  const TOKEN_KEY = 'parkingToken';
  const $ = (s) => document.querySelector(s);

  let token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* private mode */ }

  let state = null;
  let pending = null;
  let map = null, currentMarker = null, pendingMarker = null, lastFocusedId = null;

  /* ---------- tiny DOM helper (text is always set as text, never HTML) ---------- */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) e.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
    return e;
  }

  /* ---------- formatting ---------- */
  function fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    if (m < 1) return '<1 min';
    if (m < 60) return m + ' min';
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + 'h ' + (m % 60) + 'm';
    const d = Math.floor(hrs / 24);
    return d + 'd ' + (hrs % 24) + 'h';
  }
  function fmtAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    return s < 60 ? 'just now' : fmtDuration(s) + ' ago';
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtFull = (ts) => fmtDay(ts) + ', ' + fmtTime(ts);
  function fmtDist(m) {
    if (m == null) return null;
    return m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km';
  }
  const fmtCoords = (lat, lng) => lat.toFixed(5) + ', ' + lng.toFixed(5);
  const appleUrl = (lat, lng) => 'https://maps.apple.com/?daddr=' + lat + ',' + lng + '&dirflg=w';
  const googleUrl = (lat, lng) =>
    'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=walking';
  const googlePlaceUrl = (lat, lng) => 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /* ---------- api ---------- */
  async function api(method, url, body) {
    const headers = { Authorization: 'Bearer ' + token };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 401) {
      signOut('That token was not accepted.');
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
    return data;
  }

  function signOut(message) {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    state = null;
    $('#app').hidden = true;
    $('#gate').hidden = false;
    const err = $('#gate-error');
    err.textContent = message || '';
    err.hidden = !message;
  }

  async function refresh(quiet) {
    if (!token) return;
    try {
      state = await api('GET', '/api/state');
      render();
    } catch (e) {
      if (!quiet && e.message !== 'Unauthorized') toast('Could not refresh: ' + e.message);
    }
  }

  async function mutate(method, url, body, okMsg) {
    try {
      state = await api(method, url, body);
      render();
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      if (e.message !== 'Unauthorized') toast(e.message);
      return false;
    }
  }

  /* ---------- map ---------- */
  function pinIcon(cls) {
    return L.divIcon({
      className: '', html: '<div class="pin ' + (cls || '') + '"></div>',
      iconSize: [30, 30], iconAnchor: [15, 36],
    });
  }

  function initMap() {
    if (map) return;
    if (!window.L) { $('#map').hidden = true; $('#map-fallback').hidden = false; return; }
    map = L.map('map', { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    map.on('click', (e) => setPending({ lat: e.latlng.lat, lng: e.latlng.lng, accuracy: null }));
  }

  function updateMap() {
    if (!map) return;
    if (currentMarker) { map.removeLayer(currentMarker); currentMarker = null; }
    const c = state && state.current;
    if (c) {
      currentMarker = L.marker([c.lat, c.lng], { icon: pinIcon() }).addTo(map);
      if (lastFocusedId !== c.id && !pending) {
        map.setView([c.lat, c.lng], 17);
        lastFocusedId = c.id;
      }
    }
    setTimeout(() => map.invalidateSize(), 0);
  }

  /* ---------- manual selection ---------- */
  function setPending(loc) {
    pending = loc;
    $('#pending').hidden = false;
    $('#pending-coords').textContent =
      fmtCoords(loc.lat, loc.lng) + (loc.accuracy ? ' (±' + loc.accuracy + ' m)' : '');
    if (map) {
      if (pendingMarker) map.removeLayer(pendingMarker);
      pendingMarker = L.marker([loc.lat, loc.lng], { icon: pinIcon('pick') }).addTo(map);
      map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 17));
    }
    $('#pending').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function clearPending() {
    pending = null;
    $('#pending').hidden = true;
    $('#pending-note').value = '';
    if (map && pendingMarker) { map.removeLayer(pendingMarker); pendingMarker = null; }
  }

  /* ---------- render ---------- */
  function mapLinks(lat, lng) {
    return [
      h('a', { class: 'btn primary', href: appleUrl(lat, lng), target: '_blank', rel: 'noopener' }, 'Walk there (Apple Maps)'),
      h('a', { class: 'btn', href: googleUrl(lat, lng), target: '_blank', rel: 'noopener' }, 'Google Maps'),
    ];
  }

  function renderStatus() {
    const box = $('#status');
    box.replaceChildren();
    if (!state) return;

    if (state.ride) {
      const r = state.ride;
      box.append(
        h('p', { class: 'big' }, '\u{1F697} On the road ', h('span', { class: 'badge driving' }, 'ride in progress')),
        h('p', { class: 'sub' }, 'Since ' + fmtTime(r.startTs) + ' · ' + fmtDuration((Date.now() - r.startTs) / 1000)),
        h('p', { class: 'muted small' }, 'Your parking spot will be saved when the phone disconnects from the car, or save it manually below.'),
      );
      return;
    }

    const c = state.current;
    if (!c) {
      box.append(
        h('p', { class: 'big' }, 'No parking saved'),
        h('p', { class: 'sub' }, 'Save a spot below, or let the Shortcuts automation do it when you leave the car.'),
      );
      return;
    }

    box.append(
      h('p', { class: 'big' }, '\u{1F17F}️ Parked ', h('span', { class: 'badge parked' }, c.source === 'auto' ? 'automatic' : 'manual')),
      h('p', { class: 'sub' }, fmtAgo(c.ts) + ' · ' + fmtFull(c.ts)),
      c.note ? h('p', { class: 'note' }, c.note) : null,
      h('p', { class: 'muted small' }, fmtCoords(c.lat, c.lng) + (c.accuracy ? ' (±' + c.accuracy + ' m)' : '')),
      h('div', { class: 'actions' },
        mapLinks(c.lat, c.lng),
        h('button', { class: 'btn', onclick: editNote }, c.note ? 'Edit note' : 'Add note'),
        h('button', { class: 'btn danger', onclick: markMoved }, 'I took the car'),
      ),
    );
  }

  function delBtn(kind, id, label) {
    return h('button', {
      class: 'btn small danger', title: 'Delete', 'aria-label': 'Delete ' + label,
      onclick: () => {
        if (confirm('Delete this entry?')) mutate('DELETE', '/api/' + kind + '/' + id, null, 'Deleted');
      },
    }, '×');
  }

  function renderRides() {
    const ul = $('#rides');
    ul.replaceChildren();
    const rides = (state && state.rides) || [];
    if (!rides.length) { ul.append(h('li', { class: 'empty' }, 'No rides logged yet.')); return; }
    for (const r of rides) {
      const dist = fmtDist(r.distanceM);
      ul.append(h('li', null,
        h('div', null,
          h('div', null, fmtDay(r.startTs) + ', ' + fmtTime(r.startTs) + ' → ' + fmtTime(r.endTs)),
          h('div', { class: 'meta' }, fmtDuration(r.durationS) + (dist ? ' · ~' + dist + ' straight line' : '')),
        ),
        delBtn('rides', r.id, 'ride'),
      ));
    }
  }

  function renderParkings() {
    const ul = $('#parkings');
    ul.replaceChildren();
    const items = (state && state.parkings) || [];
    if (!items.length) { ul.append(h('li', { class: 'empty' }, 'Nothing here yet. Past spots appear after you move the car.')); return; }
    for (const p of items) {
      const stay = p.leftTs ? fmtDuration((p.leftTs - p.ts) / 1000) : null;
      ul.append(h('li', null,
        h('div', null,
          h('div', null, fmtFull(p.ts) + (p.leftTs ? ' → ' + fmtFull(p.leftTs) : '')),
          h('div', { class: 'meta' },
            [stay ? 'Stayed ' + stay : null, p.source === 'auto' ? 'automatic' : 'manual', p.note || null]
              .filter(Boolean).join(' · ') + ' · ',
            h('a', { href: googlePlaceUrl(p.lat, p.lng), target: '_blank', rel: 'noopener' }, 'open map'),
          ),
        ),
        delBtn('parkings', p.id, 'parking spot'),
      ));
    }
  }

  function render() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#event-url').textContent = location.origin + '/api/event';
    initMap();
    renderStatus();
    renderRides();
    renderParkings();
    updateMap();
  }

  /* ---------- actions ---------- */
  function editNote() {
    const note = window.prompt('Note for this parking spot (e.g. level 2, near the elevator):', state.current.note || '');
    if (note === null) return;
    mutate('PATCH', '/api/parked', { note }, 'Note saved');
  }

  function markMoved() {
    if (!confirm('Clear the saved parking spot? (It stays in your history.)')) return;
    mutate('POST', '/api/moved', null, 'Parking spot cleared');
  }

  function useMyLocation() {
    if (!navigator.geolocation) { toast('Location is not available in this browser.'); return; }
    const btn = $('#btn-here');
    btn.disabled = true;
    btn.textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        btn.textContent = '\u{1F4CD} Use my current location';
        setPending({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
      },
      (err) => {
        btn.disabled = false;
        btn.textContent = '\u{1F4CD} Use my current location';
        toast(err.code === 1 ? 'Location permission denied. Allow it in your browser settings.' : 'Could not get your location.');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }

  /* ---------- wiring ---------- */
  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#token-input').value.trim();
    if (!token) return;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (err) { /* ignore */ }
    $('#token-input').value = '';
    await refresh(false);
  });

  $('#btn-refresh').addEventListener('click', () => refresh(false));
  $('#btn-here').addEventListener('click', useMyLocation);
  $('#btn-cancel').addEventListener('click', clearPending);
  $('#btn-logout').addEventListener('click', () => signOut(''));

  $('#paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#paste-error');
    const loc = Geo.parseLocation($('#paste-input').value);
    if (!loc) {
      err.textContent = 'Could not find coordinates in that. Short links (maps.app.goo.gl) are not supported: open the link and copy the full address bar URL, or paste "lat, lng".';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    $('#paste-input').value = '';
    setPending({ lat: loc.lat, lng: loc.lng, accuracy: null });
  });

  $('#btn-save').addEventListener('click', async () => {
    if (!pending) return;
    const ok = await mutate('POST', '/api/parked', {
      lat: pending.lat, lng: pending.lng, accuracy: pending.accuracy, note: $('#pending-note').value,
    }, 'Parking spot saved');
    if (ok) clearPending();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
  setInterval(() => { if (!document.hidden && state) { refresh(true); } }, 30000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* not fatal */ });
  }

  if (token) refresh(false);
  else signOut('');
})();
