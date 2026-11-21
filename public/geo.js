/* Shared helpers: used by the browser (window.Geo) and by the server (require). */
(function (root) {
  'use strict';

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function validLatLng(lat, lng) {
    return (
      Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    );
  }

  // Accepts "32.0853, 34.7818", Google Maps / Apple Maps / OSM links that contain
  // coordinates, and geo: URIs. Short links (maps.app.goo.gl) can't be resolved offline.
  function parseLocation(text) {
    if (!text) return null;
    let s = String(text).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    const n = '(-?\\d{1,3}(?:\\.\\d+)?)';
    const patterns = [
      new RegExp('@' + n + ',' + n),
      new RegExp('!3d' + n + '!4d' + n),
      new RegExp('[?&](?:q|ll|daddr|destination|query|sll|center|mlat)=' + n + '[,;]\\s*' + n, 'i'),
      new RegExp('mlat=' + n + '&mlon=' + n, 'i'),
      new RegExp('^geo:' + n + ',' + n, 'i'),
      new RegExp('^\\s*' + n + '\\s*[,;\\s]\\s*' + n + '\\s*$'),
    ];
    for (const p of patterns) {
      const m = s.match(p);
      if (m) {
        const lat = Number(m[1]);
        const lng = Number(m[2]);
        if (validLatLng(lat, lng)) return { lat, lng };
      }
    }
    return null;
  }

  const api = { haversine, validLatLng, parseLocation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof self !== 'undefined' ? self : this);
