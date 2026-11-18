'use strict';
/*
  Browser side. It reads the live location, collects quantities, asks the server
  for the price, and shows the result. No pricing rules exist in this file.

  Map, address lookup and address search use Ola Maps.
*/
(() => {
  const $ = s => document.querySelector(s);
  const rupee = n => '₹' + Number(n).toLocaleString('en-IN');

  /* ---------- Ola Maps settings: the only place Ola-specific details live ----------
     If Ola's docs differ from these, fix them here and nothing else needs to change.
     Docs: https://maps.olakrutrim.com  (Web SDK, Geocoding, Places) */
  const OLA = {
    sdk:   'https://www.unpkg.com/olamaps-web-sdk@latest/dist/olamaps-web-sdk.umd.js',
    api:   'https://api.olamaps.io',
    style: 'https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json',
    reverseGeocode: '/places/v1/reverse-geocode',   // query: latlng=<lat>,<lng>   -> results[0].formatted_address
    autocomplete:   '/places/v1/autocomplete',      // query: input=<text>         -> predictions[].description / place_id
    details:        '/places/v1/details',           // query: place_id=<id>        -> result.geometry.location {lat,lng}
    center: [73.8567, 18.5204],                     // [lng, lat] shown before a location is known
  };

  const state = {
    live: null,            // { lat, lng, address } latest live location reading
    pickup: null,          // always the live reading
    drop: null,            // live reading, or a searched place when dropManual
    dropManual: false,
    quote: null,
    olaKey: null,          // set when the server provides a key
    maps: null,            // set when the Ola map is created
  };

  /* ---------- talking to our server ---------- */
  const SERVER_DOWN =
    'Cannot reach the ordering server. In the project folder run "node server.js", ' +
    'then open http://localhost:3000 (do not open index.html directly or through another preview server).';

  // fetch wrapper: anything that is not a JSON answer from our server counts as "server not running"
  async function api(path, body) {
    let r;
    try {
      r = await fetch(path, body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(SERVER_DOWN);
    }
    if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error(SERVER_DOWN);
    return { status: r.status, ok: r.ok, data: await r.json() };
  }

  /* ---------- quote ---------- */
  const qtyInputs = [...document.querySelectorAll('[data-qty]')];
  const items = () => Object.fromEntries(qtyInputs.map(i => [i.dataset.qty, Number(i.value) || 0]));
  const point = p => (p ? { lat: p.lat, lng: p.lng } : null);

  let timer;
  const scheduleQuote = () => { clearTimeout(timer); timer = setTimeout(getQuote, 250); };

  async function getQuote() {
    try {
      const { ok, data } = await api('/api/quote', { items: items(), pickup: point(state.pickup), dropoff: point(state.drop) });
      if (!ok) { state.quote = null; showMsg(data.error || 'Could not get a price.', true); }
      else { state.quote = data; showMsg(''); }
    } catch (e) {
      state.quote = null;
      showMsg(e.message, true);
    }
    render();
  }

  function render() {
    const q = state.quote;
    document.querySelectorAll('[data-price]').forEach(el => {
      el.textContent = q ? rupee(q.prices[el.dataset.price]) : '—';
    });
    $('#sum-items').textContent = q ? rupee(q.subtotal) : '₹0';
    $('#sum-fee').textContent = q && q.ready ? rupee(q.fee) : '—';
    $('#sum-total').textContent = q ? rupee(q.total) : '₹0';
    $('#submit').disabled = !(q && q.ready && q.total > 0);
  }

  function showMsg(text, isError) {
    const m = $('#msg');
    m.hidden = !text;
    m.textContent = text;
    m.className = 'msg' + (isError ? ' error' : '');
  }

  qtyInputs.forEach(i => i.addEventListener('input', scheduleQuote));
  setInterval(getQuote, 60000);  // keep shown prices current

  /* ---------- Ola Maps REST calls ---------- */
  async function ola(path, params) {
    const url = new URL(OLA.api + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    url.searchParams.set('api_key', state.olaKey);
    const r = await fetch(url);
    if (!r.ok) {
      const err = new Error('Ola Maps request failed (HTTP ' + r.status + ')');
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  const olaProblem = e => (e && e.status === 401) || (e && e.status === 403)
    ? 'Ola Maps rejected the API key (HTTP ' + e.status + '). Check the key and the domains it allows.'
    : (e && e.message ? e.message : 'Ola Maps request failed') + '. Check your Ola Maps key and internet connection.';

  async function describe(p) {                      // coordinates -> address text
    if (!state.olaKey) return null;
    try {
      const d = await ola(OLA.reverseGeocode, { latlng: p.lat + ',' + p.lng });
      return d.results && d.results[0] ? d.results[0].formatted_address : null;
    } catch (e) {
      mapWarn('Address lookup failed: ' + olaProblem(e));
      return null;
    }
  }

  /* ---------- live location (one watch feeds pickup and, by default, drop-off) ---------- */
  const km = (a, b) => {
    const rad = d => d * Math.PI / 180, R = 6371;
    const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  // High accuracy is off on purpose: desktops have no GPS and asking for it makes the lookup time out.
  const geoOpts = { enableHighAccuracy: false, maximumAge: 10000, timeout: 20000 };

  function geoMessage(e) {
    if (!window.isSecureContext) {
      return 'Live location needs a secure page. Open the site at http://localhost:3000 or over HTTPS.';
    }
    switch (e && e.code) {
      case 1: return 'Location is blocked for this site. Click the lock icon in the address bar, allow Location, then press Retry.';
      case 2: return 'Your device could not work out its location. Turn on Location Services (Windows: Settings > Privacy & security > Location), then press Retry.';
      case 3: return 'Finding your location took too long. Press Retry.';
      default: return 'Could not get your location. Press Retry.';
    }
  }

  function setPickupReadout(text, mode) {   // mode: '' (ok) | 'wait' | 'error'
    $('#pickup-status').textContent = text;
    $('#pickup-readout').className = 'readout' + (mode ? ' ' + mode : '');
  }

  let watchId = null;

  function startLive() {
    if (!navigator.geolocation) {
      setPickupReadout('This browser does not support live location.', 'error');
      $('#drop-status').textContent = 'Live location is not supported in this browser.';
      return;
    }
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    state.dropManual = false;
    $('#drop-live').hidden = true;
    setPickupReadout('Detecting your live location…', 'wait');
    $('#drop-status').textContent = 'Detecting your live location…';
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, geoOpts);
  }

  function onGeoError(e) {
    const msg = geoMessage(e);
    state.live = null;
    state.pickup = null;
    if (!state.dropManual) state.drop = null;
    setPickupReadout(msg, 'error');
    if (!state.dropManual) {
      $('#drop-status').textContent = 'Live location unavailable.';
      $('#drop-live').textContent = '📍 Retry';
      $('#drop-live').hidden = false;
    }
    updateMap();
    scheduleQuote();
  }

  async function onPosition(pos) {
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (state.live && km(state.live, p) < 0.03) return;      // ignore <30 m jitter
    const live = { ...p, address: null };
    const acc = Math.round(pos.coords.accuracy || 0);
    const accText = acc ? ' (±' + acc + ' m)' : '';
    const coords = p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + accText;

    state.live = live;
    state.pickup = live;
    setPickupReadout(coords, '');
    if (!state.dropManual) {
      state.drop = live;
      $('#drop-status').textContent = 'Using your live location';
      $('#drop-live').hidden = true;
    }
    updateMap();
    scheduleQuote();

    const addr = await describe(p);            // address text is a bonus; coordinates are already shown
    if (addr && state.live === live) {
      live.address = addr;
      setPickupReadout(addr + accText, '');
      showAddress(addr);
      if (!state.dropManual) $('#drop-status').textContent = 'Live location: ' + addr;
    }
  }

  $('#drop-live').addEventListener('click', startLive);

  /* ---------- drop-off address search (Ola autocomplete) ---------- */
  const searchBox = $('#drop-search'), results = $('#drop-results');
  let searchTimer;

  const hideResults = () => { results.hidden = true; results.textContent = ''; };

  function showResults(list) {
    results.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'No matching addresses';
      results.appendChild(li);
    }
    list.slice(0, 6).forEach(pred => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = pred.description || pred.name || 'Unnamed place';
      b.addEventListener('click', () => pickPlace(pred));
      li.appendChild(b);
      results.appendChild(li);
    });
    results.hidden = false;
  }

  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchBox.value.trim();
    if (q.length < 3) { hideResults(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const d = await ola(OLA.autocomplete, { input: q });
        showResults(d.predictions || []);
      } catch (e) {
        hideResults();
        mapWarn('Address search failed: ' + olaProblem(e));
      }
    }, 300);                                  // wait for the person to pause typing
  });

  document.addEventListener('click', ev => {   // click elsewhere closes the list
    if (!$('#drop-ac').contains(ev.target)) hideResults();
  });

  async function pickPlace(pred) {
    hideResults();
    const label = pred.description || pred.name || 'Selected address';
    searchBox.value = label;
    let loc = pred.geometry && pred.geometry.location;
    try {
      if (!loc && pred.place_id) {
        const d = await ola(OLA.details, { place_id: pred.place_id });
        loc = d.result && d.result.geometry && d.result.geometry.location;
      }
    } catch (e) {
      mapWarn('Could not load that address: ' + olaProblem(e));
      return;
    }
    if (!loc) { mapWarn('Could not find coordinates for that address. Try another one.'); return; }

    state.dropManual = true;
    state.drop = { lat: loc.lat, lng: loc.lng, address: label };
    $('#drop-status').textContent = label;
    $('#drop-live').textContent = '📍 Use my live location';
    $('#drop-live').hidden = false;
    updateMap();
    showAddress(label);
    scheduleQuote();
  }

  /* ---------- Ola map ---------- */
  function mapNote(text) {                       // fatal: nothing to draw, hide the empty box
    $('#mapbox').classList.add('nomap');
    mapWarn(text);
  }

  function mapWarn(text) {                       // non-fatal: keep the map, show a note under it
    const n = $('#map-note');
    n.hidden = false;
    n.textContent = text;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadMaps() {
    let cfg;
    try { cfg = (await api('/api/config')).data; }
    catch (e) { mapNote('Map unavailable: ' + e.message); return; }

    if (!cfg.olaKey) {
      mapNote('Map is off because the server has no Ola Maps API key. Set OLA_MAPS_API_KEY and restart "node server.js". Live location and ordering still work.');
      return;
    }
    state.olaKey = cfg.olaKey;
    $('#drop-ac').hidden = false;                // address search needs the key

    try {
      await loadScript(OLA.sdk);
      const g = window.OlaMapsWebSDK || window.OlaMaps || {};
      const OlaMaps = g.OlaMaps || g;
      if (typeof OlaMaps !== 'function') throw new Error('Ola Maps SDK loaded but was not found');

      $('#mapbox').classList.remove('nomap');    // the container must be visible before the map is created
      const olaMaps = new OlaMaps({ apiKey: state.olaKey });
      const map = olaMaps.init({ style: OLA.style, container: 'map', center: OLA.center, zoom: 12 });

      let authWarned = false;
      map.on('error', ev => {
        const status = ev && ev.error && (ev.error.status || ev.error.statusCode);
        if ((status === 401 || status === 403) && !authWarned) {
          authWarned = true;
          mapWarn(olaProblem({ status }));
        }
      });

      state.maps = { olaMaps, map, markers: {} };
      $('#map-note').hidden = true;
      updateMap();
    } catch (e) {
      mapNote('Ola Maps failed to load: ' + e.message);
      return;
    }

    if (state.live && !state.live.address) {     // geocode a reading that arrived before the key did
      const live = state.live, addr = await describe(live);
      if (addr && state.live === live) {
        live.address = addr;
        const m = /\(±\d+ m\)$/.exec($('#pickup-status').textContent);
        setPickupReadout(addr + (m ? ' ' + m[0] : ''), '');
        showAddress(addr);
        if (!state.dropManual) $('#drop-status').textContent = 'Live location: ' + addr;
      }
    }
  }

  // Open a popup with the address on the pin (like an info window)
  function showAddress(addr) {
    const m = state.maps;
    if (!m || !addr) return;
    const marker = m.markers.drop || m.markers.pickup;
    const popup = marker && marker.getPopup && marker.getPopup();
    if (!popup) return;
    popup.setText(addr);                          // text, not HTML
    if (!popup.isOpen()) marker.togglePopup();
  }

  function updateMap() {
    const m = state.maps;
    if (!m) return;

    // pickup and drop-off are the same reading by default: show one pin, not two stacked ones
    const same = state.pickup && state.pickup === state.drop;
    const wanted = {};
    if (same) wanted.drop = state.drop;
    else {
      if (state.pickup) wanted.pickup = state.pickup;
      if (state.drop) wanted.drop = state.drop;
    }

    for (const k of Object.keys(m.markers)) {
      if (!wanted[k]) { m.markers[k].remove(); delete m.markers[k]; }
    }
    for (const [k, p] of Object.entries(wanted)) {
      const lngLat = [p.lng, p.lat];
      if (!m.markers[k]) {
        const tag = document.createElement('div');
        tag.className = 'pin ' + k;
        tag.textContent = k === 'pickup' ? 'P' : 'D';
        const popup = m.olaMaps.addPopup({ offset: [0, -22] });
        m.markers[k] = m.olaMaps.addMarker({ element: tag }).setLngLat(lngLat).setPopup(popup).addTo(m.map);
      } else m.markers[k].setLngLat(lngLat);
    }

    const pts = Object.values(wanted);
    if (pts.length === 2 && km(pts[0], pts[1]) > 0.05) {
      const lngs = pts.map(p => p.lng), lats = pts.map(p => p.lat);
      m.map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60 });
    } else if (pts.length) {
      m.map.setCenter([pts[0].lng, pts[0].lat]);
      m.map.setZoom(16);
    }
  }

  /* ---------- order ---------- */
  $('#order-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = $('#name').value.trim(), phone = $('#phone').value.trim();
    if (!name || !phone) {
      showMsg('Please fill in your name and phone number.', true);
      return;
    }
    const btn = $('#submit');
    btn.disabled = true;
    try {
      const { status, ok, data } = await api('/api/orders', {
        name, phone,
        items: items(),
        pickup: point(state.pickup), dropoff: point(state.drop),
        pickupAddress: state.pickup && state.pickup.address,
        dropoffAddress: state.drop && state.drop.address,
        expectedTotal: state.quote && state.quote.total,
      });
      if (status === 409 && data.quote) {       // price changed: show the new total and ask again
        state.quote = data.quote; render(); showMsg(data.error, true);
        return;
      }
      if (!ok) { showMsg(data.error || 'Could not place the order.', true); render(); return; }
      showMsg('Order ' + data.orderId + ' placed. Total ' + rupee(data.total) + '. Thank you!');
      qtyInputs.forEach(i => { i.value = 0; });
      scheduleQuote();
    } catch (e) {
      showMsg(e.message, true);
    }
    render();
  });

  /* ---------- init ---------- */
  startLive();
  loadMaps();
  getQuote();
})();
