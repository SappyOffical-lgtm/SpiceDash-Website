'use strict';
/*
  SpiceDash server – no npm packages needed (Node 18+).

  Run:   OLA_MAPS_API_KEY=your_key node server.js
  Open:  http://localhost:3000   (geolocation works on localhost and HTTPS only)

  ALL pricing logic lives here. The browser only ever receives final prices,
  never the time windows, zone multipliers or distance formula.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OLA_KEY = (process.env.OLA_MAPS_API_KEY || '').trim() || null;
const TZ = 'Asia/Kolkata';

/* ---------------- menu (base prices in ₹) ---------------- */
const MENU = {
  butter_chicken:  { name: 'Butter Chicken Thali',  base: 249 },
  paneer_wrap:     { name: 'Paneer Tikka Wrap',     base: 169 },
  veg_biryani:     { name: 'Veg Dum Biryani',       base: 199 },
  masala_dosa:     { name: 'Masala Dosa',           base: 119 },
  chicken_biryani: { name: 'Chicken Dum Biryani',   base: 279 },
  gulab_jamun:     { name: 'Gulab Jamun Box',       base: 99  },
};

/* ---------------- private pricing rules ---------------- */
const TIME_WINDOWS = [            // hour ranges in TZ
  { from: 0,  to: 6,  mult: 1.15 },
  { from: 6,  to: 11, mult: 1.00 },
  { from: 11, to: 14, mult: 1.20 },
  { from: 14, to: 17, mult: 0.85 },
  { from: 17, to: 19, mult: 1.00 },
  { from: 19, to: 22, mult: 1.30 },
  { from: 22, to: 24, mult: 1.15 },
];
const ZONES = [                   // centre points; nearest centre wins
  { id: 1, lat: 18.5204, lng: 73.8567, mult: 1.00 },   // core city
  { id: 2, lat: 18.5515, lng: 73.9348, mult: 1.10 },   // east side
  { id: 3, lat: 18.5912, lng: 73.7389, mult: 1.20 },   // west outskirts
];
const MAX_ZONE_RADIUS_KM = 30;    // beyond this from every centre: not serviceable
const MAX_TRIP_KM = 35;           // pickup -> dropoff
const ROAD_FACTOR = 1.3;          // straight-line -> approx. road distance
const FEE_BASE = 25, FEE_FREE_KM = 2, FEE_PER_KM = 9, FEE_CAP = 250;

/* ---------------- helpers ---------------- */
function hourNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour').value);
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h + m / 60;
}
function timeMult() {
  const h = hourNow();
  return (TIME_WINDOWS.find(w => h >= w.from && h < w.to) || { mult: 1 }).mult;
}
function km(a, b) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function zoneOf(p) {
  let best = null, bestD = Infinity;
  for (const z of ZONES) {
    const d = km(p, z);
    if (d < bestD) { best = z; bestD = d; }
  }
  return bestD <= MAX_ZONE_RADIUS_KM ? best : null;
}
function validPoint(p) {
  return p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/* ---------------- quote ---------------- */
function quote(input) {
  const qty = {};
  for (const id of Object.keys(MENU)) {
    qty[id] = Math.min(9, Math.max(0, parseInt((input.items || {})[id], 10) || 0));
  }
  const tm = timeMult();
  const havePoints = validPoint(input.pickup) && validPoint(input.dropoff);

  let zoneMult = 1, fee = 0, error = null;
  if (havePoints) {
    const zp = zoneOf(input.pickup), zd = zoneOf(input.dropoff);
    const trip = km(input.pickup, input.dropoff) * ROAD_FACTOR;
    if (!zp || !zd) error = 'Sorry, we do not deliver to that area yet.';
    else if (trip > MAX_TRIP_KM) error = 'That pickup and drop-off are too far apart.';
    else {
      zoneMult = Math.max(zp.mult, zd.mult);
      fee = Math.min(FEE_CAP, Math.round((FEE_BASE + Math.max(0, trip - FEE_FREE_KM) * FEE_PER_KM) * tm));
    }
  }
  if (error) return { error };

  const prices = {};
  let subtotal = 0;
  for (const [id, item] of Object.entries(MENU)) {
    prices[id] = Math.round(item.base * tm * zoneMult);
    subtotal += prices[id] * qty[id];
  }
  return {
    ready: havePoints,
    prices, subtotal, fee,
    total: subtotal > 0 ? subtotal + fee : 0,
    qty,
  };
}

/* ---------------- http ---------------- */
const STATIC = {
  '/':           ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js':     ['app.js',     'text/javascript; charset=utf-8'],
};
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const clean = (s, n = 200) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type);
    }
    if (req.method === 'GET' && url.pathname === '/health') {   // for uptime monitors; reveals nothing
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { olaKey: OLA_KEY });
    }
    if (req.method === 'POST' && url.pathname === '/api/quote') {
      const q = quote(await readJson(req));
      return send(res, q.error ? 422 : 200, q);
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const o = await readJson(req);
      const q = quote(o);
      if (q.error) return send(res, 422, q);
      if (!q.ready) return send(res, 400, { error: 'Please set your pickup and drop-off locations.' });
      if (q.total <= 0) return send(res, 400, { error: 'Please add at least one item.' });
      const name = clean(o.name, 80), phone = clean(o.phone, 20);
      if (!name || !phone) {
        return send(res, 400, { error: 'Please fill in your name and phone number.' });
      }
      // The price may have moved since the customer last saw it: make them confirm the new one.
      if (Number(o.expectedTotal) !== q.total) {
        return send(res, 409, { error: 'The price was just updated. Please check the new total and confirm.', quote: q });
      }
      const order = {
        id: crypto.randomBytes(4).toString('hex').toUpperCase(),
        at: new Date().toISOString(),
        name, phone,
        pickupAddress: clean(o.pickupAddress), dropoffAddress: clean(o.dropoffAddress),
        pickup: o.pickup, dropoff: o.dropoff,
        items: q.qty, subtotal: q.subtotal, fee: q.fee, total: q.total,
      };
      fs.appendFile(path.join(__dirname, 'orders.jsonl'), JSON.stringify(order) + '\n', () => {});
      return send(res, 200, { orderId: order.id, total: order.total });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: 'Bad request' });
  }
}).listen(PORT, () => {
  console.log(`SpiceDash running on http://localhost:${PORT}`);
  if (!OLA_KEY) console.log('OLA_MAPS_API_KEY is not set: map and address search are disabled.');
});
