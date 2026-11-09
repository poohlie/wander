/* Wander — Singapore park walk planner (prototype v2)
 * Routing: OSM foot routing (routing.openstreetmap.de). Amenities/POIs: OpenStreetMap via Overpass.
 * Anchors: curated NParks parks (parks.js). Saved walks live in this browser's localStorage. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const WALK_KMH = 4.8;
  const ROUTE_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  const STORE_KEY = "wander.walks.v1";
  const MAX_KM = 150;

  /* ---------- state ---------- */
  const state = { start: null, end: null, interests: new Set(), restMode: "count", alts: [], active: 0, editing: true, data: null, view: "form" };
  const cur = () => state.alts[state.active];

  /* ---------- geometry ---------- */
  const rad = Math.PI / 180;
  function hav(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  const est = (a, b) => hav(a, b) * 1.3;
  const toXY = (p, lat0) => ({ x: p.lng * 111320 * Math.cos(lat0 * rad), y: p.lat * 110540 });
  const destPoint = (S, bearing, m) => ({ lat: S.lat + (m * Math.cos(bearing)) / 110540, lng: S.lng + (m * Math.sin(bearing)) / (111320 * Math.cos(S.lat * rad)) });

  /* ---------- time (Singapore, UTC+8) ---------- */
  const SG = 8 * 3600e3;
  const fmtTime = (d) => d.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
  const sgDay = (ms) => Math.floor((ms + SG) / 864e5);
  const sgMinutes = (ms) => ((((ms + SG) % 864e5) + 864e5) % 864e5) / 6e4;
  const sgNowISO = () => new Date(Date.now() + SG).toISOString().slice(0, 16);
  function sunTimes(y, m, d, lat, lng) {
    const N = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5), lngHour = lng / 15;
    const dayStart = Date.UTC(y, m - 1, d) - SG;
    const calc = (rising) => {
      const t = N + ((rising ? 6 : 18) - lngHour) / 24, M = 0.9856 * t - 3.289;
      let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634; L = ((L % 360) + 360) % 360;
      let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = ((RA % 360) + 360) % 360;
      RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90; RA /= 15;
      const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
      const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
      const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
      const T = H + RA - 0.06571 * t - 6.622, UT = (((T - lngHour) % 24) + 24) % 24;
      let ms = Date.UTC(y, m - 1, d) + UT * 3600e3;
      while (ms < dayStart) ms += 864e5;
      while (ms >= dayStart + 864e5) ms -= 864e5;
      return new Date(ms);
    };
    return { rise: calc(true), set: calc(false) };
  }
  const parseWhen = () => { const v = $("when").value; return v ? new Date(v + ":00+08:00") : new Date(); };
  const sunFor = (date) => {
    const s = new Date(date.getTime() + SG).toISOString().slice(0, 10).split("-").map(Number);
    return sunTimes(s[0], s[1], s[2], 1.35, 103.82);
  };
  const whenOf = (plan) => new Date((plan.when || sgNowISO()) + ":00+08:00");
  const etaText = (startMs, meters) => {
    const ms = startMs + (meters / 1000 / WALK_KMH) * 3600e3, d = sgDay(ms) - sgDay(startMs);
    return fmtTime(new Date(ms)) + (d === 1 ? " (next day)" : d > 1 ? ` (+${d} days)` : "");
  };
  const km = (m) => (m / 1000).toFixed(1);
  const durText = (m) => { const mins = Math.round((m / 1000 / WALK_KMH) * 60); return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`; };

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
  }
  function setStatus(msg, err) { $("status").textContent = msg; $("status").classList.toggle("err", !!err); }

  /* ---------- map ---------- */
  const map = L.map("map").setView([1.3521, 103.8198], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
  const layerGroup = L.layerGroup().addTo(map);
  let startMarker = null;
  const pin = (color, label, cls = "") => L.divIcon({ className: "", html: `<div class="pinm ${cls}" style="background:${color}"><span>${esc(label)}</span></div>`, iconSize: [0, 0] });
  const dot = L.divIcon({ className: "", html: '<div style="width:10px;height:10px;border-radius:50%;background:#fff;border:2.5px solid #3f7d45;margin:-5px 0 0 -5px"></div>', iconSize: [0, 0] });

  function setStart(lat, lng, name, note) {
    state.start = { lat, lng, name };
    drawStartMarker();
    $("startNote").textContent = note || "";
    $("mapHint").classList.add("hide");
  }
  function drawStartMarker() {
    if (startMarker) { startMarker.remove(); startMarker = null; }
    if (state.start && state.view === "form") startMarker = L.marker([state.start.lat, state.start.lng], { icon: pin("#4f7a4a", "S") }).addTo(map);
  }
  map.on("click", (e) => {
    if (state.view === "results" && state.editing && state.addMode) { addPinAt(e.latlng); return; }
    if (state.view !== "form") return;
    $("startSel").value = "";
    setStart(e.latlng.lat, e.latlng.lng, "Dropped pin", `Pin dropped at ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`);
  });

  /* ---------- views & tabs ---------- */
  function showView(v) {
    state.view = v;
    $("form").hidden = v !== "form";
    $("results").hidden = v !== "results";
    $("saved").hidden = v !== "saved";
    $("tabPlan").classList.toggle("on", v !== "saved" && !(v === "results" && cur() && cur().id));
    $("tabSaved").classList.toggle("on", v === "saved" || (v === "results" && !!(cur() && cur().id)));
    if (v !== "results") state.addMode = false;
    drawStartMarker();
    updateMapHint();
  }
  function updateMapHint() {
    const adding = state.view === "results" && state.editing && state.addMode;
    $("mapHint").textContent = adding ? "Tap the map to add a pin · Esc to finish" : "Tap the map to set a start point";
    $("mapHint").classList.toggle("hide", adding ? false : state.view !== "form" || !!state.start);
    $("map").classList.toggle("add-mode", adding);
  }
  $("tabPlan").addEventListener("click", () => {
    const p = cur();
    if (p && !p.id) { showView("results"); drawPlan(false); }
    else { layerGroup.clearLayers(); showView("form"); }
  });
  $("tabSaved").addEventListener("click", () => { layerGroup.clearLayers(); renderSaved(); showView("saved"); });

  /* ---------- form wiring ---------- */
  function fillSelect(sel, firstLabel) {
    const opts = [`<option value="">${firstLabel}</option>`];
    for (const a of [...new Set(PARKS.map((p) => p.area))].sort())
      opts.push(`<optgroup label="${esc(a)}">` + PARKS.filter((p) => p.area === a).sort((x, y) => x.name.localeCompare(y.name)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("") + "</optgroup>");
    sel.innerHTML = opts.join("");
  }
  fillSelect($("startSel"), "Tap the map, or choose a park…");
  fillSelect($("endSel"), "Loop back to start");
  $("startSel").addEventListener("change", (e) => {
    const p = PARKS.find((x) => x.id === e.target.value);
    if (!p) return;
    setStart(p.lat, p.lng, p.name, "");
    map.flyTo([p.lat, p.lng], 14, { duration: 0.8 });
  });
  $("locBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return setStatus("Location isn't available in this browser.", true);
    setStatus("Finding you…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("startSel").value = "";
        setStart(pos.coords.latitude, pos.coords.longitude, "My location", "Using your current location");
        map.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 0.8 });
        setStatus("");
      },
      () => setStatus("Couldn't get your location — tap the map instead.", true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
  $("chips").innerHTML = INTERESTS.map((i) => `<button type="button" class="chip" data-k="${i.key}">${i.icon} ${i.label}</button>`).join("");
  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.interests.has(b.dataset.k) ? state.interests.delete(b.dataset.k) : state.interests.add(b.dataset.k);
    b.classList.toggle("on");
  });
  function syncDist(v, from) {
    v = Math.max(1, Math.min(MAX_KM, +v || 1));
    if (from !== "range") $("dist").value = v;
    if (from !== "num") $("distNum").value = v;
    $("distOut").textContent = `${v} km`;
    const hrs = v / WALK_KMH;
    $("distNote").textContent = v > 20 ? `≈ ${hrs.toFixed(1)} h of continuous walking${v > 40 ? " — bring plenty of water and food, and plan your breaks." : ""}` : "";
  }
  $("dist").addEventListener("input", (e) => syncDist(e.target.value, "range"));
  $("distNum").addEventListener("input", (e) => e.target.value !== "" && syncDist(e.target.value, "num"));
  $("restMode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.restMode = b.dataset.mode;
    [...$("restMode").children].forEach((c) => c.classList.toggle("on", c === b));
    $("restCountRow").hidden = state.restMode !== "count";
    $("restEveryRow").hidden = state.restMode !== "every";
  });
  $("when").value = sgNowISO();
  const updateSky = () => { const s = sunFor(parseWhen()); $("skyNote").textContent = `🌅 ${fmtTime(s.rise)} · 🌇 ${fmtTime(s.set)}`; };
  $("when").addEventListener("change", updateSky);
  updateSky();

  /* ---------- routing ---------- */
  async function routeVia(points, tries = 2) {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(`${ROUTE_URL}${coords}?overview=full&geometries=geojson&continue_straight=false`);
        if (!r.ok) throw new Error("routing " + r.status);
        const j = await r.json();
        if (j.code !== "Ok" || !j.routes[0]) throw new Error(j.code);
        const rt = mkRoute(j.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
        rt.engine = "osm"; rt.trail = emptyTrail(rt.length);
        return rt;
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((res) => setTimeout(res, 700));
      }
    }
  }
  const emptyTrail = (len) => ({ parks: [], loops: [], stairsRuns: 0, stairM: 0, trailM: 0, linkM: 0, osmM: len, cycleM: 0, serviceM: 0, linkRanges: [], osmRanges: [[0, len]], onTrailPct: 0 });

  /* NParks-trail routing first; OpenStreetMap router only for gaps and as a fallback */
  const legCache = new Map();
  async function osrmLeg(w) {
    const k = w.map((p) => p.lat.toFixed(4) + "," + p.lng.toFixed(4)).join(";");
    if (!legCache.has(k)) legCache.set(k, (await routeVia(w)).pts);
    return legCache.get(k);
  }
  const netOpts = (plan) => ({ avoidStairs: plan ? !!plan.avoidStairs : $("avoidStairs").checked, preferTrails: plan ? !!plan.preferTrails : state.interests.has("trail"), osrm: osrmLeg });
  async function routePlan(wps, plan, extra) {
    if (window.NET && NET.ready) {
      try { const r = await NET.route(wps, { ...netOpts(plan), ...(extra || {}) }); if (r) return r; } catch (e) { console.warn("trail routing failed, using OSM router", e); }
    }
    return routeVia(wps);
  }
  function applySnap(wps, route) { // move pins onto the path they were snapped to
    if (!route || !route.snapped || route.snapped.length !== wps.length) return;
    route.snapped.forEach((s, i) => { if (s.d != null && s.d > 0.5) { wps[i].lat = s.lat; wps[i].lng = s.lng; } });
  }
  function mkRoute(pts) {
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + hav(pts[k - 1], pts[k]));
    return { pts, cum, length: cum[cum.length - 1] };
  }

  /* ---------- retrace detection ---------- */
  function sampleRoute(route, step) {
    const out = [];
    let i = 1;
    for (let d = 0; d <= route.length; d += step) {
      while (i < route.cum.length - 1 && route.cum[i] < d) i++;
      const a = route.pts[i - 1], b = route.pts[i], t = (d - route.cum[i - 1]) / (route.cum[i] - route.cum[i - 1] || 1);
      out.push({ lat: a.lat + (b.lat - a.lat) * Math.min(1, Math.max(0, t)), lng: a.lng + (b.lng - a.lng) * Math.min(1, Math.max(0, t)), d });
    }
    return out;
  }
  function overlapOf(route) {
    if (route.pts.length < 2 || route.length < 300) return { ratio: 0, pts: [] };
    const S = sampleRoute(route, 20), kx = 111320 * Math.cos(S[0].lat * rad), ky = 110540, cell = 25, grid = new Map(), flagged = [];
    for (const p of S) {
      const x = p.lng * kx, y = p.lat * ky, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      let over = false;
      for (let dx = -1; dx <= 1 && !over; dx++) for (let dy = -1; dy <= 1 && !over; dy++) {
        const arr = grid.get(`${cx + dx},${cy + dy}`);
        if (arr) for (const q of arr) if (p.d - q.d > 120 && Math.hypot(x - q.x, y - q.y) < 12) { over = true; break; }
      }
      if (over) flagged.push(p);
      const k = `${cx},${cy}`;
      (grid.get(k) || grid.set(k, []).get(k)).push({ x, y, d: p.d });
    }
    return { ratio: flagged.length / S.length, pts: flagged.filter((_, i) => i % 2 === 0).slice(0, 400).map((p) => [p.lat, p.lng]) };
  }

  /* ---------- candidate generation (no out-and-back) ---------- */
  function interestScore(a) {
    if (!state.interests.size) return 0.5;
    let n = 0;
    state.interests.forEach((k) => a.tags.includes(k) && n++);
    return n / state.interests.size;
  }
  const near = (a, p, m) => hav(a, p) < m;
  function weightedPick(items, w) {
    let t = w.reduce((s, x) => s + x, 0) * Math.random();
    for (let i = 0; i < items.length; i++) { t -= w[i]; if (t <= 0) return items[i]; }
    return items[items.length - 1];
  }
  function genTours(S, E, D, count) {
    const target = E || S;
    const haveNet = window.NET && NET.ready;
    const sSn = haveNet ? NET.snap(S.lat, S.lng, 1500) : null, eSn = haveNet && E ? NET.snap(E.lat, E.lng, 1500) : null;
    const startComp = sSn ? NET.compOf(sSn.node) : null;
    let anchors = PARKS.filter((a) => !near(a, S, 300) && !(E && near(a, E, 300)));
    if (startComp != null) { const inside = anchors.filter((a) => a.comp === startComp); if (inside.length >= 6) anchors = inside; }
    // Use real path distances when we have the trail network; otherwise straight-line guesses.
    const graph = sSn && (!E || (eSn && NET.compOf(eSn.node) === startComp)) && anchors.every((a) => a.node != null || a.comp !== startComp);
    let d = est;
    if (graph) {
      const radius = Math.min(D * 0.8, 80000);
      anchors = anchors.filter((a) => a.node != null && hav(a, S) <= radius).sort((a, b) => hav(a, S) - hav(b, S)).slice(0, 70);
      const cache = new Map(), nodeOf = (p) => (p === S ? sSn.node : E && p === E ? eSn.node : p.node);
      const lens = (p) => { const k = nodeOf(p); if (!cache.has(k)) cache.set(k, NET.lengthsFrom(k, { avoidStairs: $("avoidStairs").checked, preferTrails: state.interests.has("trail") }, D * 1.2)); return cache.get(k); };
      d = (x, y) => lens(x)[nodeOf(y)];
    }
    const found = new Map();
    for (let trial = 0; trial < (graph ? 1200 : 500); trial++) {
      const via = [], left = new Set(anchors);
      let cur = S, used = 0;
      for (let step = 0; step < 40; step++) {
        if (used + d(cur, target) >= D * 0.97) break;
        const opts = [];
        for (const a of left) { const d1 = d(cur, a), tot = used + d1 + d(a, target); if (tot <= D * (graph ? 1.08 : 1.12)) opts.push({ a, d1 }); }
        if (!opts.length) break;
        const pick = weightedPick(opts, opts.map((o) => (0.25 + interestScore(o.a)) * (startComp != null && o.a.comp === startComp ? 3 : 1) * (1 / (1 + o.d1 / 3000)) * (0.4 + Math.random())));
        via.push(pick.a); left.delete(pick.a); used += pick.d1; cur = pick.a;
      }
      if (!via.length || (!E && via.length < 2)) continue;
      const total = used + d(cur, target), err = Math.abs(total - D) / D;
      if (!isFinite(total) || err > 0.3) continue;
      const sc = via.reduce((s, a) => s + interestScore(a), 0) / via.length;
      let shape = 0;
      if (!E && via.length >= 2) { // a loop should wrap around the start, not run out in a line
        const br = via.map((a) => Math.atan2(a.lng - S.lng, a.lat - S.lat) / rad).map((x) => (x + 360) % 360).sort((x, y) => x - y);
        let gap = 360 - br[br.length - 1] + br[0];
        for (let i = 1; i < br.length; i++) gap = Math.max(gap, br[i] - br[i - 1]);
        const spread = 360 - gap;
        shape = spread < 120 ? (0.25 * (120 - spread)) / 120 : 0;
      }
      const key = via.map((a) => a.id).join(",");
      if (!found.has(key)) found.set(key, { via, est: total, score: err + (1 - sc) * 0.3 + shape });
    }
    const sorted = [...found.values()].sort((a, b) => a.score - b.score), out = [];
    for (const c of sorted) {
      const ids = new Set(c.via.map((a) => a.id));
      const similar = out.some((o) => { const inter = o.via.filter((a) => ids.has(a.id)).length; return inter / Math.min(ids.size, o.via.length) > 0.6; });
      if (!similar) out.push(c);
      if (out.length >= count) break;
    }
    return out;
  }
  function onNet(S, p) { // nearest path in the same connected piece as S, within 3 km
    if (!(window.NET && NET.ready)) return p;
    const sSn = NET.snap(S.lat, S.lng, 1500);
    const q = sSn && NET.snap(p.lat, p.lng, 3000, NET.compOf(sSn.node));
    return q ? { lat: q.lat, lng: q.lng } : p;
  }
  async function explorerLoop(S, D, bearing0) {
    let r = D / 3.9, best = null;
    for (let i = 0; i < 4; i++) {
      const p1 = onNet(S, destPoint(S, bearing0, r)), p2 = onNet(S, destPoint(S, bearing0 + Math.PI / 3, r));
      const wps = [S, { ...p1, name: "Waypoint", kind: "via" }, { ...p2, name: "Waypoint", kind: "via" }, S];
      const route = await routePlan(wps);
      best = { route, wps };
      const ratio = D / route.length;
      if (Math.abs(1 - ratio) < 0.1) break;
      r *= Math.min(2.2, Math.max(0.45, ratio));
    }
    return best;
  }
  const mkWp = (p, kind, name) => ({ lat: p.lat, lng: p.lng, kind, name: name ?? p.name });
  const shortName = (n) => n.replace(/ \(.*\)/, "");

  const planScore = (p) => p.err * 2 + p.overlap.ratio * 3 + (1 - (p.route.trail ? p.route.trail.onTrailPct : 0)) * 0.25 + (p.interestPen || 0) + (p.explorer ? 0.05 : 0);

  // Trail routing is fast, so test many candidate tours for real, then improve the best by dropping
  // stops that cause doubling back.
  async function refineTours(S, E, D, startWp, endWp) {
    const base = { avoidStairs: $("avoidStairs").checked, preferTrails: state.interests.has("trail") };
    const ev = async (via) => {
      const wps = [{ ...startWp }, ...via.map((a) => mkWp(a, "via", a.name)), { ...endWp }];
      const route = await NET.route(wps, base);
      if (!route) return null;
      const interest = via.length ? via.reduce((a, p) => a + interestScore(p), 0) / via.length : 0.4;
      return { via, wps, route, score: (Math.abs(route.length - D) / D) * 2 + (route.dupM / route.length) * 3 + (1 - interest) * 0.3 };
    };
    const cands = genTours(S, E, D, 50);
    let scored = (await Promise.all(cands.map((c) => ev(c.via)))).filter(Boolean).sort((a, b) => a.score - b.score);
    const minVia = E ? 1 : 2;
    const pool = PARKS.filter((a) => a.node != null && !near(a, S, 300) && !(E && near(a, E, 300)) && (scored[0] ? true : false));
    for (const t of scored.slice(0, 4)) {
      for (let i = 0; i < t.via.length; i++) {
        if (t.via.length > minVia) { const r2 = await ev(t.via.filter((_, k) => k !== i)); if (r2 && r2.score < t.score - 0.01) scored.push(r2); }   // drop a stop
        for (let k = 0; k < 6; k++) {                                                                                                             // or swap it for a nearby one
          const a = pool[Math.floor(Math.random() * pool.length)];
          if (!a || t.via.includes(a) || hav(a, t.via[i]) > Math.max(6000, D * 0.25)) continue;
          const r3 = await ev(t.via.map((v, j) => (j === i ? a : v)));
          if (r3 && r3.score < t.score - 0.01) scored.push(r3);
        }
      }
    }
    scored.sort((a, b) => a.score - b.score);
    const out = [];
    for (const c of scored) {
      const ids = new Set(c.via.map((a) => a.id));
      if (out.some((o) => o.via.filter((a) => ids.has(a.id)).length / Math.min(ids.size, o.via.length || 1) > 0.7)) continue;
      out.push(c);
      if (out.length >= 5) break;
    }
    return out;
  }

  async function buildAlternatives(S, E, D) {
    const startWp = mkWp(S, "start", S.name), endWp = E ? mkWp(E, "end", E.name) : mkWp(S, "end", S.name);
    const clone = (w) => ({ ...w });
    const tourJob = (c) => async () => {
      const wps = [clone(startWp), ...c.via.map((a) => mkWp(a, "via", a.name)), clone(endWp)];
      return { wps, route: await routePlan(wps), est: c.est, label: "via " + c.via.slice(0, 3).map((a) => shortName(a.name)).join(" → ") + (c.via.length > 3 ? " …" : ""), via: c.via };
    };
    const jobs = [];
    if (E && est(S, E) >= D * 0.85) jobs.push(async () => { const wps = [clone(startWp), clone(endWp)]; return { wps, route: await routePlan(wps), label: "Most direct" }; });
    const tours = window.NET && NET.ready ? await refineTours(S, E, D, startWp, endWp) : genTours(S, E, D, 5);
    tours.forEach((c) => jobs.push(c.route ? async () => ({ wps: c.wps, route: c.route, est: null, label: "via " + c.via.slice(0, 3).map((a) => shortName(a.name)).join(" → ") + (c.via.length > 3 ? " …" : ""), via: c.via }) : tourJob(c)));
    if (!E && D <= 30000) {
      const best = PARKS.filter((a) => !near(a, S, 300)).sort((a, b) => interestScore(b) - interestScore(a) || hav(a, S) - hav(b, S))[0];
      const b0 = best ? Math.atan2(best.lng - S.lng, best.lat - S.lat) - 0.5 : Math.random() * 6.28;
      const nVar = window.NET && NET.ready ? 6 : 3;
      Array.from({ length: nVar }, (_, k) => b0 + k * (6.283 / nVar)).forEach((br, k) => jobs.push(async () => { const r = await explorerLoop(S, D, br); return { ...r, label: k ? `Explorer loop ${k + 1}` : "Explorer loop", explorer: true }; }));
    }
    const ok = (settled) => settled.filter((x) => x.status === "fulfilled" && x.value.route).map((x) => x.value);
    let results = ok(await Promise.allSettled(jobs.map((j) => j())));
    // trails wind more than straight-line guesses: recalibrate and add a second batch if the first missed the distance
    const ratios = results.filter((r) => r.est).map((r) => r.route.length / r.est).sort((a, b) => a - b);
    if (ratios.length) {
      const med = ratios[ratios.length >> 1];
      if (med < 0.88 || med > 1.12) {
        const seen = new Set(tours.map((t) => t.via.map((a) => a.id).join()));
        const more = genTours(S, E, D / med, 4).filter((c) => !seen.has(c.via.map((a) => a.id).join()));
        results = results.concat(ok(await Promise.allSettled(more.map((c) => tourJob(c)()))));
      }
    }
    const plans = [];
    for (const v of results) {
      applySnap(v.wps, v.route);
      const ov = overlapOf(v.route);
      const interest = v.via && v.via.length ? v.via.reduce((a, p) => a + interestScore(p), 0) / v.via.length : 0.4;
      const plan = { _lastGood: JSON.stringify(v.wps), label: v.label, wps: v.wps, route: v.route, overlap: ov, err: Math.abs(v.route.length - D) / D, interestPen: (1 - interest) * 0.3, explorer: !!v.explorer, stops: [], pois: [] };
      plan.score = planScore(plan);
      plans.push(plan);
    }
    if (!plans.length) throw new Error("No routes found");
    plans.sort((a, b) => a.score - b.score);
    const good = plans.filter((p) => p.err <= 0.5);
    return (good.length ? good : plans).slice(0, 3);
  }

  /* ---------- amenities & points of interest ---------- */
  const TYPES = {
    toilets: { icon: "🚻", label: "Toilets", bonus: 1.0 },
    drinking_water: { icon: "💧", label: "Drinking water", bonus: 0.9 },
    shelter: { icon: "🛖", label: "Shelter", bonus: 0.85 },
    cafe: { icon: "☕", label: "Café", bonus: 0.75 },
    food_court: { icon: "🍜", label: "Hawker / food court", bonus: 0.95 },
    picnic_site: { icon: "🧺", label: "Picnic spot", bonus: 0.5 },
  };
  const POI_LABEL = { park: "Park", garden: "Garden", nature_reserve: "Nature reserve", beach: "Beach", peak: "Hill", attraction: "Attraction", viewpoint: "Viewpoint", zoo: "Zoo", museum: "Museum", gallery: "Gallery", historic: "Heritage site" };
  const routeBBox = (route, pad) => {
    let s = 90, w = 190, n = -90, e = -190;
    for (const p of route.pts) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
    return { s: s - pad, w: w - pad, n: n + pad, e: e + pad };
  };
  const bboxHas = (outer, inner) => inner.s >= outer.s && inner.w >= outer.w && inner.n <= outer.n && inner.e <= outer.e;

  async function fetchOsm(area) {
    // area: {bb:"s,w,n,e"} for short routes, or {around:"200,lat,lng,lat,lng,…"} (a corridor) for long ones
    const f = area.around ? `(around:${area.around})` : `(${area.bb})`;
    const body = (mod) => `[out:json][timeout:40];(nwr["amenity"~"^(toilets|drinking_water|shelter|cafe|food_court)$"]${f};nwr["tourism"~"^(picnic_site|attraction|viewpoint|zoo|museum|gallery)$"]${f};nwr["historic"]["name"]${f};nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]${f};nwr["natural"~"^(beach|peak)$"]["name"]${f};);${mod}`;
    const attempt = async (url, mod) => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 18000);
      try {
        let r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(body(mod)), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
        if (r.status === 400 && mod.includes("bb")) r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(body("out center tags;")), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
        if (!r.ok) throw new Error("overpass " + r.status);
        const j = await r.json();
        const amen = [], pois = [];
        for (const el of j.elements || []) {
          const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
          if (lat == null) continue;
          if (t.amenity && TYPES[t.amenity]) amen.push({ type: t.amenity, lat, lng, name: t.name || "" });
          else if (t.tourism === "picnic_site") amen.push({ type: "picnic_site", lat, lng, name: t.name || "" });
          else if (t.name) {
            const kind = ["tourism", "leisure", "natural"].map((k) => t[k]).find((v) => POI_LABEL[v]) || (t.historic ? "historic" : null);
            if (!kind) continue;
            const diag = el.bounds ? hav({ lat: el.bounds.minlat, lng: el.bounds.minlon }, { lat: el.bounds.maxlat, lng: el.bounds.maxlon }) : 200;
            pois.push({ kind, lat, lng, name: t.name, diag });
          }
        }
        return { amen, pois };
      } finally { clearTimeout(timer); }
    };
    try { return await Promise.any(OVERPASS.map((u) => attempt(u, "out center bb tags;"))); } catch (_) { return null; }
  }
  async function ensureData(plan) {
    const need = routeBBox(plan.route, 0.003);
    if (state.data && state.data.failed && Date.now() - state.data.ts < 90000) return;
    if (state.data && !state.data.failed && state.data.bbox && bboxHas(state.data.bbox, need)) return;
    let r, bbox = null;
    const wide = (need.n - need.s) * (need.e - need.w) > 0.004; // longer walks: query a corridor, not a huge box
    if (wide) {
      const thinned = [];
      let last = null;
      for (const p of plan.route.pts) if (!last || hav(last, p) >= 400) { thinned.push(p); last = p; }
      const end = plan.route.pts[plan.route.pts.length - 1];
      if (last !== end) thinned.push(end);
      r = await fetchOsm({ around: "250," + thinned.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",") });
    } else {
      bbox = routeBBox(plan.route, 0.012);
      r = await fetchOsm({ bb: `${bbox.s.toFixed(5)},${bbox.w.toFixed(5)},${bbox.n.toFixed(5)},${bbox.e.toFixed(5)}` });
    }
    state.data = r ? { bbox, amen: r.amen, pois: r.pois } : { bbox, amen: null, pois: [], failed: true, ts: Date.now() };
  }

  function project(route, p) {
    const lat0 = p.lat, P = toXY(p, lat0);
    let best = { off: Infinity, along: 0 };
    for (let i = 1; i < route.pts.length; i++) {
      const A = toXY(route.pts[i - 1], lat0), B = toXY(route.pts[i], lat0);
      const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
      let t = l2 ? ((P.x - A.x) * dx + (P.y - A.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const off = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
      if (off < best.off) best = { off, along: route.cum[i - 1] + t * (route.cum[i] - route.cum[i - 1]) };
    }
    return best;
  }
  function pointAt(route, d) {
    for (let i = 1; i < route.cum.length; i++) if (route.cum[i] >= d) {
      const t = (d - route.cum[i - 1]) / (route.cum[i] - route.cum[i - 1] || 1);
      const a = route.pts[i - 1], b = route.pts[i];
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    return route.pts[route.pts.length - 1];
  }
  function routeIndex(route) { // coarse 500 m grid for quick rejection
    const cell = 500, kx = 111320 * Math.cos(1.35 * rad), ky = 110540, set = new Set();
    for (const p of route.pts) set.add(`${Math.floor((p.lng * kx) / cell)},${Math.floor((p.lat * ky) / cell)}`);
    return (p, ring = 1) => {
      const cx = Math.floor((p.lng * kx) / cell), cy = Math.floor((p.lat * ky) / cell);
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) if (set.has(`${cx + dx},${cy + dy}`)) return true;
      return false;
    };
  }
  const nearestPark = (p) => {
    let b = null, bd = 1500;
    for (const a of PARKS) { const d = hav(a, p); if (d < bd) { bd = d; b = a; } }
    return b;
  };
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function findPois(plan) {
    const route = plan.route, idx = routeIndex(route), out = [];
    for (const a of PARKS) {
      if (!idx(a)) continue;
      const pr = project(route, a);
      if (pr.off <= 350) out.push({ along: pr.along, off: pr.off, name: shortName(a.name), desc: (window.PARK_DESC || {})[a.id] || "NParks park", curated: true });
    }
    const tr = route.trail;
    if (tr) {
      const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.includes(y) || y.includes(x); };
      for (const p of tr.parks) {
        if (p.m < 150) continue;
        if (/^[A-Za-z]{1,4}\d{1,4}$|^[A-Za-z]{1,3}$/.test(p.name.trim())) continue; // skip raw data codes such as "Fwp11" or "Aye"
        const hit = out.find((o) => same(o.name, p.name));
        if (hit) { hit.m = p.m; hit.off = 0; hit.along = Math.min(hit.along, p.along); if (hit.desc === "NParks park") hit.desc = `NParks park — your route is inside it for ${(p.m / 1000).toFixed(1)} km.`; continue; }
        out.push({ along: p.along, off: 0, m: p.m, name: p.name, desc: `NParks park — your route is inside it for ${(p.m / 1000).toFixed(1)} km.`, curated: true });
      }
      for (const l of tr.loops) if (l.m >= 300) out.push({ along: l.along, off: 0, m: l.m, loop: true, name: l.name, desc: `Part of the NParks Park Connector Network — ${(l.m / 1000).toFixed(1)} km of your route follows this loop.`, curated: true });
    }
    const curatedNames = out.map((o) => norm(o.name));
    const seen = new Set();
    for (const p of (state.data && state.data.pois) || []) {
      if (!idx(p)) continue;
      const n = norm(p.name);
      if (seen.has(n) || curatedNames.some((c) => c.includes(n) || n.includes(c))) continue;
      const big = ["park", "garden", "nature_reserve"].includes(p.kind);
      const limit = big ? Math.min(600, Math.max(150, p.diag * 0.35)) : 120;
      const pr = project(route, p);
      if (pr.off > limit) continue;
      seen.add(n);
      out.push({ along: pr.along, off: pr.off, name: p.name, desc: POI_LABEL[p.kind] || "Point of interest" });
    }
    const cap = 60;
    const kept = out.length > cap ? out.sort((a, b) => (b.curated ? 1 : 0) - (a.curated ? 1 : 0) || a.off - b.off).slice(0, cap) : out;
    return kept.sort((a, b) => a.along - b.along);
  }

  function planAutoStops(route, amen, mode, value) {
    const L = route.length;
    let targets = [];
    if (mode === "count") for (let i = 1; i <= value; i++) targets.push((L * i) / (value + 1));
    else for (let d = value * 1000; d < L - 300; d += value * 1000) targets.push(d);
    targets = targets.slice(0, 60);
    const interval = mode === "count" ? L / (value + 1) : value * 1000;
    const window = Math.max(400, interval * 0.4);
    const cands = (amen || []).map((a) => ({ ...a, ...project(route, a) })).filter((a) => a.off <= 250);
    const stops = [];
    let last = 0;
    for (const t of targets) {
      let best = null, bs = Infinity;
      for (const a of cands) {
        if (Math.abs(a.along - t) > window || a.along < last + 200 || a.along > L - 150) continue;
        const s = Math.abs(a.along - t) + a.off * 1.5 - TYPES[a.type].bonus * 200;
        if (s < bs) { bs = s; best = a; }
      }
      if (best) {
        const feats = [...new Set(cands.filter((c) => hav(c, best) < 90).map((c) => c.type))];
        const park = nearestPark(best);
        stops.push({ along: best.along, lat: best.lat, lng: best.lng, found: true, feats, name: best.name || TYPES[best.type].label, where: park ? `near ${shortName(park.name)}` : "" });
        last = best.along;
      } else {
        const p = pointAt(route, t), park = nearestPark(p);
        stops.push({ along: t, ...p, found: false, feats: [], name: "Rest on the path", where: park ? `by ${shortName(park.name)}` : "" });
        last = t;
      }
    }
    return stops;
  }
  function rebuildStops(plan) {
    const amen = state.data ? state.data.amen : null, L = plan.route.length;
    const customs = (plan.stops || []).filter((s) => s.custom).map((s) => { const pr = project(plan.route, s), p = pointAt(plan.route, pr.along); return { ...s, along: pr.along, lat: p.lat, lng: p.lng }; });
    let auto = planAutoStops(plan.route, amen, plan.restMode, plan.restVal);
    if (customs.length) {
      const gap = Math.min(800, (plan.restMode === "count" ? L / (plan.restVal + 1) : plan.restVal * 1000) * 0.4);
      auto = auto.filter((a) => customs.every((c) => Math.abs(c.along - a.along) >= gap));
    }
    return [...auto, ...customs].sort((a, b) => a.along - b.along);
  }
  async function derive(plan, fetchData = true) {
    plan.overlap = overlapOf(plan.route);
    if (fetchData) await ensureData(plan);
    plan.amenityFail = !!(state.data && state.data.failed);
    plan.pois = findPois(plan);
    plan.stops = rebuildStops(plan);
  }

  /* ---------- advisories ---------- */
  async function weatherNote(S, start) {
    const lead = (start - Date.now()) / 60000;
    if (lead < -30 || lead > 110) return null;
    try {
      const j = await (await fetch("https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast")).json();
      const it = j.data.items[0];
      let best = null, bd = Infinity;
      for (const a of j.data.area_metadata) { const d = hav(S, { lat: a.label_location.latitude, lng: a.label_location.longitude }); if (d < bd) { bd = d; best = a.name; } }
      const f = it.forecasts.find((x) => x.area === best);
      if (f && /rain|shower|thunder/i.test(f.forecast)) return `🌧️ NEA expects “${f.forecast}” around ${best} in the next 2 hours. Consider the sheltered stops, or leave a little later.`;
    } catch (_) { /* optional */ }
    return null;
  }
  function timeNotes(plan) {
    const start = whenOf(plan), hours = plan.route.length / 1000 / WALK_KMH;
    const end = new Date(start.getTime() + hours * 3600e3), sun = sunFor(start), notes = [];
    if (hours > 6) notes.push(`⏱️ About ${hours.toFixed(1)} hours of continuous walking — carry enough water and food, and make use of your rest stops.`);
    const a = sgMinutes(start.getTime()), b = a + hours * 60;
    if (b > 11 * 60 && a < 16 * 60) notes.push("☀️ This walk overlaps the midday heat (11am–4pm). Bring water and favour the shaded forest stretches.");
    if (end > new Date(sun.set.getTime() - 20 * 60e3) || start < new Date(sun.rise.getTime() - 15 * 60e3))
      notes.push(`🌙 Part of this walk is in the dark (sunrise ${fmtTime(sun.rise)}, sunset ${fmtTime(sun.set)}). Stick to lit park connectors, or shift your start time.`);
    return notes;
  }

  /* ---------- plan text ---------- */
  function narrative(plan) {
    const a = plan.wps[0].name, b = plan.wps[plan.wps.length - 1].name;
    const ends = [a, b].map((n) => norm(shortName(n)));
    const named = plan.pois.filter((p) => p.curated && !p.loop && !ends.includes(norm(p.name))).slice(0, 4);
    const loopsN = plan.pois.filter((p) => p.loop).map((p) => p.name).slice(0, 2);
    const loop = hav(plan.wps[0], plan.wps[plan.wps.length - 1]) < 50;
    const mid = named.length ? ` passing ${named.map((p) => p.name).join(", ").replace(/, ([^,]*)$/, " and $1")}` : "";
    const via = loopsN.length ? ` Follows the ${loopsN.join(" and ")}.` : "";
    return `${loop ? "A loop from" : "From"} ${a}${loop ? "" : " to " + b}${mid}.${via} ${km(plan.route.length)} km, about ${durText(plan.route.length)} of walking${plan.overlap.ratio < 0.03 ? ", with essentially no retracing" : ""}.`;
  }
  function planAsText(plan) {
    const when = whenOf(plan), lines = [`${plan.name || "Walk"} — ${km(plan.route.length)} km, ~${durText(plan.route.length)}`, narrative(plan), "", "Points of interest:"];
    plan.pois.forEach((p) => lines.push(`• ${km(p.along)} km — ${p.name}: ${p.desc}`));
    lines.push("", "Rest stops:");
    plan.stops.forEach((s, i) => lines.push(`${i + 1}. ${km(s.along)} km (~${etaText(when.getTime(), s.along)}) — ${s.name}${s.where ? ", " + s.where : ""}${s.feats.length ? " [" + s.feats.map((f) => TYPES[f].label).join(", ") + "]" : ""}`));
    return lines.join("\n");
  }

  /* ---------- reverse direction ---------- */
  function flipRoute(R) {
    const L = R.length, N = R.pts.length;
    const out = { pts: R.pts.slice().reverse(), cum: R.cum.map((c) => L - c).reverse(), length: L, engine: R.engine, snapped: R.snapped ? R.snapped.slice().reverse() : R.snapped, dupM: R.dupM };
    if (R.spans && window.NET && NET.summarize) {
      out.spans = R.spans.slice().reverse().map(([e, a0, a1, i0, i1]) => [e, L - a1, L - a0, N - 1 - i1, N - 1 - i0]);
      out.trail = NET.summarize(out);
    } else {
      const t = R.trail || emptyTrail(L), fl = (arr) => (arr || []).map(([a, b]) => [L - b, L - a]).reverse();
      out.trail = { ...t, parks: t.parks.map((q) => ({ ...q, along: Math.max(0, L - q.along - q.m) })), loops: t.loops.map((q) => ({ ...q, along: Math.max(0, L - q.along - q.m) })), linkRanges: fl(t.linkRanges), osmRanges: fl(t.osmRanges) };
    }
    return out;
  }
  function flipPlan() {
    const plan = cur();
    if (!plan) return;
    const L = plan.route.length;
    plan.wps = plan.wps.slice().reverse().map((w, i, arr) => ({ ...w, kind: i === 0 ? "start" : i === arr.length - 1 ? "end" : "via" }));
    plan.route = flipRoute(plan.route);
    plan.overlap = overlapOf(plan.route);
    plan.stops = plan.stops.slice().reverse().map((x) => ({ ...x, along: L - x.along }));
    plan.pois = plan.pois.map((q) => ({ ...q, along: q.m ? Math.max(0, L - q.along - q.m) : L - q.along })).sort((a, b) => a.along - b.along);
    if (plan.log && plan.log.stopsDone) plan.log.stopsDone = plan.log.stopsDone.map((i) => plan.stops.length - 1 - i);
    plan._lastGood = JSON.stringify(plan.wps);
    drawPlan(false); renderResults(); persistIfSaved(plan);
    toast("Walk reversed — now heading the other way", 3000);
  }

  /* ---------- export: Google Maps link, KML, GPX, PDF ---------- */
  const slug = (t) => String(t || "walk").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "walk";
  function download(name, mime, data) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function simplify(pts, tolM) { // Douglas-Peucker
    if (pts.length < 3) return pts;
    const kx = 111320 * Math.cos(pts[0].lat * rad), ky = 110540, xy = pts.map((p) => [p.lng * kx, p.lat * ky]), keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]];
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      const [a, b] = stack.pop(), [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        let t = l2 ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
        if (d > best) { best = d; bi = i; }
      }
      if (best > tolM) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function exportPlaces(plan) { // named points for KML / GPX
    const loop = hav(plan.wps[0], plan.wps[plan.wps.length - 1]) < 50, when = whenOf(plan).getTime(), out = [];
    plan.wps.forEach((w, i) => {
      const last = i === plan.wps.length - 1;
      if (last && loop) return;
      out.push({ kind: i === 0 ? "start" : last ? "end" : "pin", name: i === 0 ? (loop ? "Start / finish: " : "Start: ") + w.name : last ? "Finish: " + w.name : `Pin ${String.fromCharCode(64 + i)}`, desc: w.name, lat: w.lat, lng: w.lng });
    });
    plan.stops.forEach((x, i) => out.push({ kind: "stop", name: `Rest stop ${i + 1}: ${x.name}`, desc: `${km(x.along)} km, about ${etaText(when, x.along)}${x.where ? ", " + x.where : ""}${x.feats && x.feats.length ? " — " + x.feats.map((f) => TYPES[f].label).join(", ") : ""}`, lat: x.lat, lng: x.lng }));
    plan.pois.slice(0, 80).forEach((q) => { const c = pointAt(plan.route, q.along); out.push({ kind: "poi", name: q.name, desc: `${km(q.along)} km — ${q.desc}`, lat: c.lat, lng: c.lng }); });
    return out;
  }
  function buildKml(plan) {
    const name = esc(plan.name || "Wander walk"), coords = simplify(plan.route.pts, 2).map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)},0`).join(" ");
    const icon = { start: "grn-circle", end: "red-circle", pin: "blu-circle", stop: "ylw-circle", poi: "wht-blank" };
    const styles = Object.entries(icon).map(([k, v]) => `<Style id="${k}"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/${v}.png</href></Icon></IconStyle></Style>`).join("");
    const places = exportPlaces(plan), folder = (title, kinds) => `<Folder><name>${title}</name>${places.filter((q) => kinds.includes(q.kind)).map((q) => `<Placemark><name>${esc(q.name)}</name><description>${esc(q.desc)}</description><styleUrl>#${q.kind}</styleUrl><Point><coordinates>${q.lng.toFixed(6)},${q.lat.toFixed(6)},0</coordinates></Point></Placemark>`).join("")}</Folder>`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name><description>${esc(narrative(plan))}</description>${styles}<Style id="route"><LineStyle><color>ff457d3f</color><width>5</width></LineStyle></Style>` +
      `<Folder><name>Route</name><Placemark><name>${name} (${km(plan.route.length)} km)</name><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark></Folder>` +
      `${folder("Start, finish and pins", ["start", "end", "pin"])}${folder("Rest stops", ["stop"])}${folder("Points of interest", ["poi"])}</Document></kml>`;
  }
  function buildGpx(plan) {
    const wpt = exportPlaces(plan).map((q) => `<wpt lat="${q.lat.toFixed(6)}" lon="${q.lng.toFixed(6)}"><name>${esc(q.name)}</name><desc>${esc(q.desc)}</desc></wpt>`).join("");
    const trk = simplify(plan.route.pts, 1.5).map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Wander" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${esc(plan.name || "Wander walk")}</name><desc>${esc(narrative(plan))}</desc></metadata>${wpt}<trk><name>${esc(plan.name || "Wander walk")}</name><trkseg>${trk}</trkseg></trk></gpx>`;
  }
  function gmapsUrl(plan) { // Google plans its own walking route, so we hand it the start, finish and up to 9 points along ours
    const R = plan.route, L = R.length, first = R.pts[0], last = R.pts[R.pts.length - 1];
    const n = Math.max(0, Math.min(9, Math.floor(L / 1500) - 1)), via = [];
    for (let i = 1; i <= n; i++) via.push(pointAt(R, (L * i) / (n + 1)));
    const f = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    return `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${f(first)}&destination=${f(last)}${via.length ? "&waypoints=" + via.map(f).join("%7C") : ""}`;
  }

  const pdfText = (t) => String(t == null ? "" : t).replace(/→/g, "->").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, "...").replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim();
  const loadTile = (src) => new Promise((res) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });

  async function exportPdf() {
    const plan = cur();
    if (!plan) return;
    if (!(window.jspdf && window.jspdf.jsPDF)) { toast("The PDF library didn't load — check your connection and reload the page.", 4000); return; }
    toast("Preparing PDF…", 60000);
    try {
      const { jsPDF } = window.jspdf, R = plan.route, L = R.length, loop = hav(plan.wps[0], plan.wps[plan.wps.length - 1]) < 50;
      // --- geometry: fit the route into the map box
      const wx = (lng) => (lng + 180) / 360, wy = (lat) => (1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2;
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (const p of R.pts) { x0 = Math.min(x0, wx(p.lng)); x1 = Math.max(x1, wx(p.lng)); y0 = Math.min(y0, wy(p.lat)); y1 = Math.max(y1, wy(p.lat)); }
      const dx = Math.max(x1 - x0, 1e-6), dy = Math.max(y1 - y0, 1e-6), landscape = dx / dy >= 1.1;
      const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
      const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), M = 10;
      const mapX = M, mapY = M + 17, mapW = PW - 2 * M, mapH = landscape ? PH - mapY - M - 36 : Math.min(PH * 0.56, mapW * 1.08);
      const DPI = 200, Wpx = Math.round((mapW / 25.4) * DPI), Hpx = Math.round((mapH / 25.4) * DPI), pad = 0.07;
      const zf = Math.min(18.4, Math.log2(Math.min((Wpx * (1 - 2 * pad)) / (256 * dx), (Hpx * (1 - 2 * pad)) / (256 * dy)))), S = 256 * 2 ** zf, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const toPx = (lat, lng) => [(wx(lng) - cx) * S + Wpx / 2, (wy(lat) - cy) * S + Hpx / 2];
      const toMm = (lat, lng) => { const [px, py] = toPx(lat, lng); return [mapX + (px / Wpx) * mapW, mapY + (py / Hpx) * mapH]; };
      // --- base map: OpenStreetMap tiles stitched onto a 200 dpi canvas
      const cv = document.createElement("canvas"); cv.width = Wpx; cv.height = Hpx;
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#e9efe0"; ctx.fillRect(0, 0, Wpx, Hpx);
      let z = Math.max(1, Math.min(18, Math.round(zf - 0.6))), tiles = [];
      for (;;) {
        const n = 2 ** z, ax = cx - Wpx / 2 / S, bx = cx + Wpx / 2 / S, ay = cy - Hpx / 2 / S, by = cy + Hpx / 2 / S;
        tiles = [];
        for (let tx = Math.floor(ax * n); tx <= Math.floor(bx * n); tx++) for (let ty = Math.floor(ay * n); ty <= Math.floor(by * n); ty++) if (ty >= 0 && ty < n) tiles.push([((tx % n) + n) % n, ty, tx]);
        if (tiles.length <= 90 || z <= 1) break;
        z--;
      }
      const n = 2 ** z, size = S / n;
      let got = 0, i = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (i < tiles.length) {
          const [tx, ty, rawX] = tiles[i++], img = await loadTile(`https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`);
          if (img) { got++; ctx.drawImage(img, (rawX / n - cx) * S + Wpx / 2, (ty / n - cy) * S + Hpx / 2, size + 0.7, size + 0.7); }
        }
      }));
      doc.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", mapX, mapY, mapW, mapH, undefined, "FAST");
      doc.setDrawColor(150, 160, 140); doc.setLineWidth(0.3); doc.rect(mapX, mapY, mapW, mapH);
      // --- vector overlay: route, links, pins (crisp at any zoom)
      const mm = (pts) => { const out = []; let lx = -1e9, ly = -1e9; for (const p of pts) { const [mx, my] = toMm(p.lat, p.lng); if (Math.hypot(mx - lx, my - ly) >= 0.12) { out.push([mx, my]); lx = mx; ly = my; } } return out; };
      const stroke = (pts, rgb, w, dash) => {
        if (pts.length < 2) return;
        doc.setDrawColor(...rgb); doc.setLineWidth(w); doc.setLineCap("round"); doc.setLineJoin("round"); doc.setLineDashPattern(dash || [], 0);
        for (let a = 0; a < pts.length - 1; a += 400) {
          const seg = pts.slice(a, Math.min(pts.length, a + 401));
          doc.lines(seg.slice(1).map((q, k) => [q[0] - seg[k][0], q[1] - seg[k][1]]), seg[0][0], seg[0][1], [1, 1], "S", false);
        }
        doc.setLineDashPattern([], 0);
      };
      const line = mm(R.pts);
      stroke(line, [255, 255, 255], 1.9); stroke(line, [63, 125, 69], 1.0);
      const tr = R.trail;
      if (tr) {
        (tr.linkRanges || []).forEach(([a, b]) => stroke(mm(subPath(R, a, b)), [224, 166, 74], 1.0, [1.2, 1.2]));
        (tr.osmRanges || []).forEach(([a, b]) => stroke(mm(subPath(R, a, b)), [47, 127, 134], 1.0, [2.2, 1.4]));
      }
      const badge = (lat, lng, label, rgb, r) => {
        const [mx, my] = toMm(lat, lng);
        doc.setFillColor(...rgb); doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.5); doc.circle(mx, my, r, "FD");
        doc.setFont("helvetica", "bold"); doc.setFontSize(r > 3 ? 7 : 8); doc.setTextColor(255, 255, 255); doc.text(pdfText(label), mx, my + 1, { align: "center" });
      };
      plan.stops.forEach((x, k) => badge(x.lat, x.lng, String(k + 1), [224, 166, 74], 2.5));
      plan.wps.forEach((w, k) => { const last = k === plan.wps.length - 1; if (last && loop) return; badge(w.lat, w.lng, k === 0 ? (loop ? "S/E" : "S") : last ? "E" : String.fromCharCode(64 + k), k === 0 ? [79, 122, 74] : last ? [138, 90, 59] : [63, 143, 138], 3.3); });
      // scale bar, north arrow, attribution
      const midLat = (toLatLng(cy)), mPerMm = ((2 * Math.PI * 6378137 * Math.cos(midLat * rad)) / S) * (Wpx / mapW);
      const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].filter((v) => v / mPerMm <= 45).pop() || 10, bar = nice / mPerMm;
      doc.setFillColor(255, 255, 255); doc.rect(mapX + 3, mapY + mapH - 11, bar + 12, 8, "F");
      doc.setDrawColor(40, 50, 40); doc.setLineWidth(0.5); doc.line(mapX + 6, mapY + mapH - 5.5, mapX + 6 + bar, mapY + mapH - 5.5); doc.line(mapX + 6, mapY + mapH - 7, mapX + 6, mapY + mapH - 4); doc.line(mapX + 6 + bar, mapY + mapH - 7, mapX + 6 + bar, mapY + mapH - 4);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(40, 50, 40); doc.text(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, mapX + 6 + bar / 2, mapY + mapH - 8, { align: "center" });
      doc.setFillColor(255, 255, 255); doc.circle(mapX + mapW - 8, mapY + 8, 5, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text("N", mapX + mapW - 8, mapY + 9.8, { align: "center" }); doc.setLineWidth(0.4); doc.line(mapX + mapW - 8, mapY + 7.6, mapX + mapW - 8, mapY + 4.2);
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor(60, 70, 60);
      doc.text(pdfText("Map © OpenStreetMap contributors · Trail data © National Parks Board, Singapore (data.gov.sg)"), mapX + mapW - 1.5, mapY + mapH - 1.5, { align: "right" });
      if (!got) { doc.setFontSize(9); doc.setTextColor(150, 60, 40); doc.text("Base map tiles could not be loaded — the route is drawn on a blank background.", mapX + 3, mapY + 6); }
      // --- header
      const when = whenOf(plan), fin = etaText(when.getTime(), L), dstr = when.toLocaleDateString("en-SG", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" });
      doc.setTextColor(38, 54, 43); doc.setFont("helvetica", "bold"); doc.setFontSize(19); doc.text(pdfText(plan.name || "Wander walk"), M, M + 7);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(90, 105, 92);
      doc.text(pdfText(`${km(L)} km · about ${durText(L)} walking · ${dstr}, ${fmtTime(when)} to ${fin}`), M, M + 13.5);
      // --- key + stats under the map (page 1)
      let y = mapY + mapH + 7;
      const stats = [[`${km(L)} km`, "distance"], [durText(L), "walking time"], [String(plan.stops.length), "rest stops"], [tr ? `${Math.round(tr.onTrailPct * 100)}%` : "-", "on NParks paths"]];
      const bw = (mapW - 9) / 4;
      stats.forEach(([v, lab], k) => { const bx = M + k * (bw + 3); doc.setFillColor(238, 243, 230); doc.roundedRect(bx, y, bw, 15, 2, 2, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(58, 95, 56); doc.text(pdfText(v), bx + bw / 2, y + 7, { align: "center" }); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(100, 115, 102); doc.text(lab, bx + bw / 2, y + 12, { align: "center" }); });
      y += 21;
      if (!landscape || y < PH - M - 6) {
        doc.setFontSize(8); doc.setTextColor(70, 85, 72);
        const key = "Solid green = route · dashed amber = short link between paths · dashed teal = other OpenStreetMap footpath · S/E start & finish · A, B… your pins · amber numbers = rest stops";
        doc.text(doc.splitTextToSize(pdfText(key), mapW), M, y); y += 8;
      }
      // --- details (new page)
      doc.addPage(); y = M;
      const ensure = (h) => { if (y + h > PH - M) { doc.addPage(); y = M; } };
      const heading = (t) => { ensure(12); doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(58, 95, 56); doc.text(t, M, y + 4); y += 8; };
      const para = (t, size = 9.5, color = [38, 54, 43], bold = false) => { doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...color); for (const ln of doc.splitTextToSize(pdfText(t), PW - 2 * M)) { ensure(5); doc.text(ln, M, y + 3.5); y += 4.6; } };
      heading(pdfText(plan.name || "Wander walk"));
      para(narrative(plan), 10);
      y += 2;
      const notes = timeNotes(plan).map(pdfText).filter(Boolean);
      if (tr && tr.stairsRuns) notes.push(`${tr.stairsRuns} staircase section${tr.stairsRuns > 1 ? "s" : ""} on this route.`);
      if (tr && tr.linkM > 80) notes.push(`About ${Math.round(tr.linkM / 10) * 10} m are short links between NParks paths (dashed amber on the map): follow the pavement or crossing.`);
      if (tr && tr.osmM > L * 0.1) notes.push(`About ${km(tr.osmM)} km uses ordinary OpenStreetMap footpaths (dashed teal).`);
      if (notes.length) { heading("Good to know"); notes.forEach((t) => para("• " + t, 9.2)); y += 2; }
      heading("Rest stops");
      para(`Start - ${plan.wps[0].name} - ${fmtTime(when)}`, 9.2, [38, 54, 43], true);
      plan.stops.forEach((x, k) => para(`${k + 1}. ${x.name} - ${km(x.along)} km, about ${etaText(when.getTime(), x.along)}${x.where ? ", " + x.where : ""}${x.feats && x.feats.length ? " [" + x.feats.map((f) => TYPES[f].label).join(", ") + "]" : ""}`, 9.2));
      para(`${loop ? "Back at start" : "Finish - " + plan.wps[plan.wps.length - 1].name} - ${km(L)} km, about ${fin}`, 9.2, [38, 54, 43], true);
      y += 2;
      heading("Points of interest along the way");
      if (!plan.pois.length) para("None found along this route.", 9.2, [100, 115, 102]);
      plan.pois.forEach((q) => { para(`${km(q.along)} km - ${q.name}${q.m ? ` (inside for ${km(q.m)} km)` : ""}`, 9.2, [38, 54, 43], true); y -= 0.4; para(q.desc, 8.6, [90, 105, 92]); y += 0.8; });
      const g = plan.log;
      if (g && g.walked) {
        y += 2; heading("Walk journal");
        para(`Walked on ${g.date || "-"}${g.time ? " at " + g.time : ""}${g.durH != null || g.durM != null ? `, took ${g.durH || 0} h ${g.durM || 0} min` : ""}${g.actualKm ? `, ${g.actualKm} km` : ""}${g.rating ? `, rated ${g.rating}/5` : ""}.`, 9.2);
        if (g.other) para("Other stops: " + g.other, 9.2); if (g.notes) para(g.notes, 9.2);
      }
      const pages = doc.getNumberOfPages();
      for (let k = 1; k <= pages; k++) { doc.setPage(k); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(130, 140, 132); doc.text(`Wander - Singapore park walks · page ${k} of ${pages}`, PW / 2, PH - 4.5, { align: "center" }); }
      doc.setProperties({ title: pdfText(plan.name || "Wander walk"), subject: "Walking route in Singapore", creator: "Wander" });
      doc.save(`${slug(plan.name)}-${km(L)}km.pdf`);
      toast("PDF saved", 3000);
    } catch (e) { console.error(e); toast("Couldn't create the PDF: " + (e.message || e), 5000); }
  }
  const toLatLng = (wyv) => Math.atan(Math.sinh(Math.PI * (1 - 2 * wyv))) / rad;

  /* ---------- drawing the plan ---------- */
  let seq = 0;
  function drawPlan(fit) {
    layerGroup.clearLayers();
    const plan = cur();
    if (!plan) return;
    if (startMarker) { startMarker.remove(); startMarker = null; }
    const unsaved = !plan.id;
    if (unsaved) state.alts.forEach((a, i) => { if (i !== state.active) L.polyline(a.route.pts, { color: "#6b8f65", weight: 4, opacity: 0.45, dashArray: "6 8" }).on("click", () => selectAlt(i)).addTo(layerGroup); });
    L.polyline(plan.route.pts, { color: "#fff", weight: 9, opacity: 0.85, interactive: state.editing }).addTo(layerGroup);
    const line = L.polyline(plan.route.pts, { color: "#3f7d45", weight: 5, opacity: 1, className: fit ? "route-draw" : "", interactive: state.editing }).addTo(layerGroup);
    if (state.editing) line.on("click", (e) => { L.DomEvent.stopPropagation(e); addVia(e.latlng); });
    const tr = plan.route.trail;
    if (tr) {
      (tr.linkRanges || []).forEach(([a0, a1]) => L.polyline(subPath(plan.route, a0, a1), { color: "#e0a64a", weight: 5, dashArray: "3 7", interactive: false }).addTo(layerGroup));
      (tr.osmRanges || []).forEach(([a0, a1]) => L.polyline(subPath(plan.route, a0, a1), { color: "#2f7f86", weight: 5, dashArray: "9 6", interactive: false }).addTo(layerGroup));
    }
    plan.overlap.pts.forEach((p) => L.circleMarker(p, { radius: 3.5, color: "#d9822b", weight: 1, fillColor: "#f0a04b", fillOpacity: 0.9, interactive: false }).addTo(layerGroup));
    plan.pois.slice(0, 80).forEach((p) => { const q = pointAt(plan.route, p.along); L.marker([q.lat, q.lng], { icon: dot, interactive: true, keyboard: false }).bindTooltip(esc(p.name)).addTo(layerGroup); });
    const loop = hav(plan.wps[0], plan.wps[plan.wps.length - 1]) < 50;
    const drag = state.editing;
    plan.wps.forEach((w, i) => {
      const last = i === plan.wps.length - 1;
      if (last && loop) return;
      const icon = i === 0 ? pin("#4f7a4a", loop ? "S/E" : "S") : last ? pin("#8a5a3b", "E") : pin("#3f8f8a", String.fromCharCode(64 + i), "via");
      const m = L.marker([w.lat, w.lng], { icon, draggable: drag, zIndexOffset: 500 }).addTo(layerGroup);
      m.bindPopup(() => {
        const d = document.createElement("div");
        d.innerHTML = `<b>${esc(w.name)}</b>` + (drag && w.kind === "via" ? '<br><button type="button" class="ghost sm" style="min-height:32px;margin-top:6px">Remove pin</button>' : "");
        const btn = d.querySelector("button");
        if (btn) btn.addEventListener("click", () => { map.closePopup(); removeVia(i); });
        return d;
      });
      m.on("dragend", () => {
        const ll = m.getLatLng();
        if (hav(ll, w) < 30) { drawPlan(false); return; } // barely moved: leave everything as it was
        if (window.NET && NET.ready && !NET.snap(ll.lat, ll.lng, 150)) toast("That spot is away from the NParks paths, so this part will follow ordinary footpaths (dashed teal).", 4500);
        w.lat = ll.lat; w.lng = ll.lng; w.name = i === 0 ? "Custom start" : last ? "Custom end" : "Custom pin"; w.keep = true;
        if (i === 0 && loop) { const e = plan.wps[plan.wps.length - 1]; e.lat = ll.lat; e.lng = ll.lng; e.name = w.name; }
        reroute(plan);
      });
    });
    plan.stops.forEach((s, i) => {
      const m = L.marker([s.lat, s.lng], { icon: pin("#e0a64a", i + 1), draggable: drag, zIndexOffset: 400 }).bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.where)}`).addTo(layerGroup);
      m.on("dragend", () => dragStop(plan, s, m.getLatLng()));
    });
    if (fit) map.fitBounds(L.latLngBounds(plan.route.pts.map((p) => [p.lat, p.lng])), { padding: [30, 30] });
  }
  function subPath(route, a0, a1) {
    const out = [];
    for (let i = 0; i < route.pts.length; i++) if (route.cum[i] >= a0 - 0.5 && route.cum[i] <= a1 + 0.5) out.push(route.pts[i]);
    return out;
  }
  function selectAlt(i) { state.active = i; drawPlan(true); renderResults(); }

  /* ---------- editing: drag, add and remove pins ---------- */
  async function reroute(plan) {
    const my = ++seq;
    $("results").classList.add("busy");
    toast("Rerouting…", 8000);
    let ok = false;
    const prev = { route: plan.route, overlap: plan.overlap, pois: plan.pois, stops: plan.stops };
    try {
      const was = plan.route.length;
      const route = await routePlan(plan.wps, plan, { reorder: true, maxDetour: 3, maxSnap: 150 });
      if (my !== seq) return;
      if (route.order) plan.wps = route.order.map((i) => plan.wps[i]);
      applySnap(plan.wps, route);
      plan.route = route;
      await derive(plan, false);
      if (route.length > was * 1.8 && route.length > was + 3000 && plan.overlap.ratio > 0.25) throw new Error("TOO_LONG:" + km(was) + ":" + km(route.length) + ":" + (plan.overlap.ratio * 100).toFixed(0));
      plan._lastGood = JSON.stringify(plan.wps);
      ok = true;
      toast(route.order ? "Route updated — pins are now visited in the shortest order" : `Route updated: ${km(was)} → ${km(route.length)} km`, 3500);
    } catch (e) {
      console.error(e);
      if (my === seq && plan._lastGood) {
        plan.wps = JSON.parse(plan._lastGood); Object.assign(plan, prev);
        const m = /^TOO_LONG:(.+):(.+):(.+)$/.exec(String(e.message));
        toast(m ? `That would stretch the walk from ${m[1]} to ${m[2]} km and double back ${m[3]}% of the way, so I kept your previous route. Try dropping the pin closer to the route.` : "Couldn't find a walking route to there, so I put the pin back. Try again in a moment, or pick a spot nearer a footpath.", 6500);
      }
      else toast("Couldn't reroute that — try a spot nearer a path.", 4000);
    } finally {
      if (my === seq) { $("results").classList.remove("busy"); drawPlan(false); renderResults(); persistIfSaved(plan); }
    }
    if (!ok) return;
    // fill in toilets/water/sights for the new path in the background
    const hadData = state.data && !state.data.failed;
    plan.loadingPlaces = !hadData || !state.data.bbox;
    if (plan.loadingPlaces) renderResults();
    await ensureData(plan);
    if (my !== seq) return;
    plan.loadingPlaces = false;
    await derive(plan, false);
    drawPlan(false); renderResults(); persistIfSaved(plan);
  }
  function addVia(latlng) {
    const plan = cur(), pr = project(plan.route, { lat: latlng.lat, lng: latlng.lng });
    let at = plan.wps.length - 1;
    for (let i = 1; i < plan.wps.length - 1; i++) if (project(plan.route, plan.wps[i]).along > pr.along) { at = i; break; }
    plan.wps.splice(at, 0, { lat: latlng.lat, lng: latlng.lng, kind: "via", name: "Added pin", keep: true });
    reroute(plan);
  }
  function addPinAt(latlng) { // add a pin anywhere on the map, slotted in where it adds the least extra distance
    const plan = cur();
    if (!plan) return;
    if (plan.wps.length >= 14) { toast("That's plenty of pins — remove one to add another.", 3000); return; }
    let at = 1, best = Infinity;
    for (let i = 0; i + 1 < plan.wps.length; i++) {
      const a = plan.wps[i], b = plan.wps[i + 1], c = hav(a, latlng) + hav(latlng, b) - hav(a, b);
      if (c < best) { best = c; at = i + 1; }
    }
    plan.wps.splice(at, 0, { lat: latlng.lat, lng: latlng.lng, kind: "via", name: "Added pin", keep: true });
    reroute(plan);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.addMode) { state.addMode = false; renderResults(); } });
  function removeVia(i) { const plan = cur(); plan.wps.splice(i, 1); reroute(plan); }
  function dragStop(plan, stop, ll) {
    const pr = project(plan.route, { lat: ll.lat, lng: ll.lng }), p = pointAt(plan.route, pr.along);
    const amen = ((state.data && state.data.amen) || []).filter((a) => hav(a, p) < 150).sort((a, b) => TYPES[b.type].bonus - TYPES[a.type].bonus);
    const park = nearestPark(p);
    Object.assign(stop, { along: pr.along, lat: p.lat, lng: p.lng, custom: true, found: amen.length > 0, feats: [...new Set(amen.filter((a) => hav(a, amen[0]) < 90).map((a) => a.type))], name: amen.length ? amen[0].name || TYPES[amen[0].type].label : "My rest spot", where: park ? `near ${shortName(park.name)}` : "" });
    plan.stops.sort((a, b) => a.along - b.along);
    drawPlan(false); renderResults(); persistIfSaved(plan);
  }

  /* ---------- saved walks (localStorage) ---------- */
  const loadWalks = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch (_) { return []; } };
  function writeWalks(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); updateCount(); return true; }
    catch (_) { toast("Couldn't save — browser storage is full or blocked.", 4000); return false; }
  }
  function updateCount() { $("savedCount").textContent = loadWalks().length; }
  function thin(pts) {
    const out = [], flat = [];
    let last = null;
    pts.forEach((p, i) => { if (!last || i === pts.length - 1 || hav(last, p) >= 10) { out.push(p); last = p; } });
    out.forEach((p) => flat.push(+p.lat.toFixed(5), +p.lng.toFixed(5)));
    return flat;
  }
  function pack(plan) {
    return { id: plan.id, name: plan.name, savedAt: plan.savedAt, label: plan.label, goalM: plan.goalM, len: plan.route.length, when: plan.when, restMode: plan.restMode, restVal: plan.restVal, interests: plan.interests, wps: plan.wps, flat: thin(plan.route.pts), stops: plan.stops, pois: plan.pois, overlap: plan.overlap, avoidStairs: !!plan.avoidStairs, preferTrails: !!plan.preferTrails, trail: plan.route.trail || null, log: plan.log || {} };
  }
  function unpack(o) {
    const pts = [];
    for (let i = 0; i < o.flat.length; i += 2) pts.push({ lat: o.flat[i], lng: o.flat[i + 1] });
    const route = mkRoute(pts);
    if (o.len) { const f = o.len / (route.length || 1); route.cum = route.cum.map((c) => c * f); route.length = o.len; }
    route.trail = o.trail || emptyTrail(route.length); route.engine = route.trail.osmM > route.length * 0.99 ? "osm" : "nparks";
    return { ...o, route, amenityFail: false, log: o.log || {} };
  }
  function persistIfSaved(plan) {
    if (!plan || !plan.id) return;
    const list = loadWalks(), i = list.findIndex((w) => w.id === plan.id);
    if (i >= 0) { list[i] = pack(plan); writeWalks(list); }
  }
  function saveCurrent() {
    const plan = cur();
    if (!plan || plan.id) return;
    plan.id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    plan.savedAt = Date.now();
    plan.name = ($("walkName") && $("walkName").value.trim()) || plan.name;
    plan.log = plan.log || {};
    const list = loadWalks();
    list.unshift(pack(plan));
    if (!writeWalks(list)) { plan.id = null; return; }
    state.alts = [plan]; state.active = 0;
    toast("Walk saved ✓");
    drawPlan(false); renderResults(); showView("results");
  }

  /* ---------- results rendering ---------- */
  function renderResults() {
    const plan = cur();
    if (!plan) return;
    const when = whenOf(plan), saved = !!plan.id, loop = hav(plan.wps[0], plan.wps[plan.wps.length - 1]) < 50;
    const notes = timeNotes(plan);
    if (plan.err > 0.2 && !saved) notes.unshift(`📏 Closest I could get is ${km(plan.route.length)} km (you asked for ${km(plan.goalM)} km). Try a different start or tweak the distance.`);
    if (plan.overlap.ratio > 0.08) notes.unshift(`🔁 About ${(plan.overlap.ratio * 100).toFixed(0)}% of this route retraces the same path (orange dots on the map). Drag a pin to open up a different return.`);
    const tr = plan.route.trail;
    if (tr && plan.route.length > 0) {
      if (tr.osmM > plan.route.length * 0.15) notes.push(`🛣️ About ${km(tr.osmM)} km uses ordinary OpenStreetMap footpaths (dashed teal) where NParks paths don't connect.`);
      if (tr.linkM > 80) notes.push(`↔️ ${Math.round(tr.linkM / 10) * 10} m are short links between NParks paths (dashed amber) — follow the pavement or crossing.`);
      if (tr.stairsRuns && !plan.avoidStairs) notes.push(`🪜 ${tr.stairsRuns} staircase section${tr.stairsRuns > 1 ? "s" : ""} on this route. Tick “Avoid staircases” for a step-free alternative.`);
    }
    if (plan.weather) notes.push(plan.weather);
    if (plan.loadingPlaces) notes.push("⏳ Still looking up toilets, water, shelters and sights along the route…");
    if (plan.amenityFail) notes.push("ℹ️ Couldn't load toilet, water and shelter data just now, so rest points are evenly spaced and the places-of-interest list is limited to featured parks.");
    const stopsHtml = [
      `<li><span class="pin s">S</span><div><b>${esc(plan.wps[0].name)}</b><small>Start · ${fmtTime(when)}</small></div></li>`,
      ...plan.stops.map((s, i) => `<li><span class="pin">${i + 1}</span><div><b>${esc(s.name)}${s.custom ? " ✎" : ""}</b><small>${km(s.along)} km · about ${etaText(when.getTime(), s.along)}${s.where ? " · " + esc(s.where) : ""}</small><div>${
        s.found ? s.feats.map((f) => `<span class="badge">${TYPES[f].icon} ${TYPES[f].label}</span>`).join("") : '<span class="badge">🪵 Good spot to pause</span>'}</div></div></li>`),
      `<li><span class="pin e">E</span><div><b>${loop ? "Back at start" : esc(plan.wps[plan.wps.length - 1].name)}</b><small>${km(plan.route.length)} km · finish ~${etaText(when.getTime(), plan.route.length)}</small></div></li>`,
    ].join("");
    const poisHtml = plan.pois.length
      ? `<ul class="pois">${plan.pois.map((p) => `<li><b>${esc(p.name)}</b><small>${km(p.along)} km · ${p.m ? `inside for ${km(p.m)} km` : p.off < 60 ? "passes through / along" : `passes by (~${Math.round(p.off / 10) * 10} m away)`}<br>${esc(p.desc)}</small></li>`).join("")}</ul>`
      : '<p class="note">No named points of interest found along this route yet.</p>';

    $("results").innerHTML = `
      <div class="title-row">
        <input id="walkName" value="${esc(plan.name)}" aria-label="Walk name" maxlength="80">
        ${saved ? '<span class="savedmark">✓ Saved</span>' : '<button class="btn" id="saveBtn" type="button">Save walk</button>'}
      </div>
      ${!saved && state.alts.length > 1 ? `<div class="alts">${state.alts.map((x, i) => `<button class="alt ${i === state.active ? "on" : ""}" data-i="${i}">${i === 0 ? "★ " : ""}${esc(x.label)}<small>${km(x.route.length)} km</small></button>`).join("")}</div>` : ""}
      <div class="summary">
        <div class="stat"><b>${km(plan.route.length)} km</b><span>distance</span></div>
        <div class="stat"><b>${durText(plan.route.length)}</b><span>walking</span></div>
        <div class="stat"><b>${plan.stops.length}</b><span>rest stops</span></div>
        <div class="stat"><b>${(plan.overlap.ratio * 100).toFixed(0)}%</b><span>retraced</span></div>
      </div>
      ${trailRowHtml(plan)}
      ${notes.map((n) => `<div class="warn">${n}</div>`).join("")}
      <p class="lead">${esc(narrative(plan))}</p>
      <div class="btn-row" style="margin:0 0 6px">
        <button class="btn alt2" id="editToggle" type="button">${state.editing ? "✓ Done editing" : "✏️ Edit route"}</button>
        ${state.editing ? `<button class="btn alt2 ${state.addMode ? "on" : ""}" id="addPinBtn" type="button" aria-pressed="${!!state.addMode}">${state.addMode ? "📍 Adding pins — tap to finish" : "📍 Add pin"}</button>` : ""}
        <button class="btn alt2" id="flipBtn" type="button" title="Walk the same route the other way round">⇄ Reverse direction</button>
        <button class="btn alt2" id="copyBtn" type="button">📋 Copy as text</button>
      </div>
      ${state.editing ? '<div class="hint">Drag the green pins (S, A, B…) to reshape the walk. Tap <b>Add pin</b>, then tap anywhere on the map to make the walk pass through that spot — or tap the route line to add a pin on it. Drag amber rest-stop pins to move a stop.</div>' : ""}
      <h3>Points of interest along the way</h3>
      ${poisHtml}
      <h3>Rest stops</h3>
      <ol class="stops">${stopsHtml}</ol>
      <h3>Share &amp; export</h3>
      <div class="btn-row" style="margin-top:0">
        <button class="btn" id="expPdf" type="button">📄 PDF with map</button>
        <button class="btn alt2" id="expGmaps" type="button">📍 Open in Google Maps</button>
        <button class="btn alt2" id="expKml" type="button">⬇ KML</button>
        <button class="btn alt2" id="expGpx" type="button">⬇ GPX</button>
      </div>
      <p class="note"><b>PDF:</b> an A4 map of the route with stops, plus the full list of places and times — easy to share. <b>Google Maps:</b> opens walking directions through your start, finish and up to 9 points along the route (Google picks its own path between them, so it can differ slightly). <b>KML:</b> the exact route — import it into <a href="https://www.google.com/mymaps" target="_blank" rel="noopener">Google My Maps</a> (Create a new map → Import) and it shows in the Google Maps app, or open it in Google Earth. <b>GPX:</b> for Strava, Komoot, Garmin and other walking apps.</p>
      ${saved ? journalHtml(plan) : ""}
      <div class="btn-row">
        <button class="ghost sm" id="editBtn" type="button">← ${saved ? "Plan a new walk" : "Change plan"}</button>
        ${saved ? '<button class="btn danger" id="delBtn" type="button">Delete walk</button>' : ""}
      </div>`;
    wireResults(plan);
  }

  function trailRowHtml(plan) {
    const tr = plan.route.trail;
    if (!tr) return "";
    const bits = [`🌿 ${(tr.onTrailPct * 100).toFixed(0)}% on NParks paths`];
    if (tr.trailM > 200) bits.push(`🥾 ${km(tr.trailM)} km trail / boardwalk`);
    if (tr.stairsRuns) bits.push(`🪜 ${tr.stairsRuns} stair section${tr.stairsRuns > 1 ? "s" : ""}`);
    const legend = (tr.linkRanges || []).length || (tr.osmRanges || []).length ? '<small>Solid green = NParks path · dashed amber = short link · dashed teal = other OpenStreetMap path</small>' : "";
    return `<div class="trailrow">${bits.join(" · ")}${legend}</div>`;
  }

  function wireResults(plan) {
    const r = $("results");
    const nameEl = $("walkName");
    nameEl.addEventListener("change", () => { plan.name = nameEl.value.trim() || plan.name; persistIfSaved(plan); });
    const sb = $("saveBtn"); if (sb) sb.addEventListener("click", saveCurrent);
    const alts = r.querySelector(".alts"); if (alts) alts.addEventListener("click", (e) => { const b = e.target.closest(".alt"); if (b) selectAlt(+b.dataset.i); });
    $("editToggle").addEventListener("click", () => { state.editing = !state.editing; if (!state.editing) state.addMode = false; drawPlan(false); renderResults(); });
    if ($("addPinBtn")) $("addPinBtn").addEventListener("click", () => { state.addMode = !state.addMode; renderResults(); });
    updateMapHint();
    $("flipBtn").addEventListener("click", flipPlan);
    $("expPdf").addEventListener("click", exportPdf);
    $("expGmaps").addEventListener("click", () => { window.open(gmapsUrl(plan), "_blank", "noopener"); });
    $("expKml").addEventListener("click", () => { download(`${slug(plan.name)}-${km(plan.route.length)}km.kml`, "application/vnd.google-earth.kml+xml", buildKml(plan)); toast("KML downloaded — import it into Google My Maps or Google Earth", 4500); });
    $("expGpx").addEventListener("click", () => { download(`${slug(plan.name)}-${km(plan.route.length)}km.gpx`, "application/gpx+xml", buildGpx(plan)); toast("GPX downloaded", 3000); });
    $("copyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(planAsText(plan)); toast("Copied to clipboard"); } catch (_) { toast("Couldn't copy — select the text manually.", 3500); }
    });
    $("editBtn").addEventListener("click", () => { layerGroup.clearLayers(); state.alts = plan.id ? [] : state.alts; state.active = 0; showView("form"); });
    const del = $("delBtn");
    if (del) del.addEventListener("click", () => {
      if (!window.confirm(`Delete “${plan.name}”? This also removes your journal notes.`)) return;
      writeWalks(loadWalks().filter((w) => w.id !== plan.id));
      state.alts = []; layerGroup.clearLayers(); renderSaved(); showView("saved"); toast("Walk deleted");
    });
    if (plan.id) wireJournal(plan);
  }

  /* ---------- walk journal ---------- */
  function journalHtml(plan) {
    const g = plan.log || {};
    const dur = g.durH != null || g.durM != null;
    const stopChecks = plan.stops.length
      ? plan.stops.map((s, i) => `<label class="check"><input type="checkbox" data-stop="${i}" ${(g.stopsDone || []).includes(i) ? "checked" : ""}><span>${i + 1}. ${esc(s.name)} <small class="note" style="display:inline">· ${km(s.along)} km</small></span></label>`).join("")
      : '<p class="note">This walk has no planned rest stops.</p>';
    return `<section class="journal" id="journal">
      <h3 style="margin-top:12px">📓 Walk journal</h3>
      <label class="toggle"><input type="checkbox" id="jWalked" ${g.walked ? "checked" : ""}> I walked this route</label>
      <div id="jFields" ${g.walked ? "" : "hidden"}>
        <div class="grid2">
          <label class="field"><span class="lbl">Date</span><input type="date" id="jDate" value="${esc(g.date || new Date(Date.now() + SG).toISOString().slice(0, 10))}"></label>
          <label class="field"><span class="lbl">Started at</span><input type="time" id="jTime" value="${esc(g.time || (plan.when || "").slice(11, 16))}"></label>
        </div>
        <div class="grid2" style="margin-top:10px">
          <label class="field"><span class="lbl">Time taken (h)</span><input type="number" id="jH" min="0" max="99" step="1" placeholder="e.g. 2" value="${dur && g.durH != null ? esc(g.durH) : ""}"></label>
          <label class="field"><span class="lbl">(min)</span><input type="number" id="jM" min="0" max="59" step="1" placeholder="e.g. 30" value="${dur && g.durM != null ? esc(g.durM) : ""}"></label>
        </div>
        <label class="field" style="margin-top:10px"><span class="lbl">Distance I actually covered <i>(km, optional)</i></span><input type="number" id="jKm" min="0" step="0.1" placeholder="${km(plan.route.length)}" value="${esc(g.actualKm ?? "")}"></label>
        <div id="jPace" class="note" style="margin-bottom:10px"></div>
        <span class="lbl">Where I actually stopped</span>
        ${stopChecks}
        <label class="field" style="margin-top:8px"><span class="lbl">Other places I stopped <i>(one per line)</i></span><textarea id="jOther" placeholder="e.g. Teh tarik at the hawker centre">${esc(g.other || "")}</textarea></label>
        <div class="field"><span class="lbl">How was it?</span><div class="rating" id="jRating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" class="${(g.rating || 0) >= n ? "on" : ""}" aria-label="${n} of 5">🍃</button>`).join("")}</div></div>
        <label class="field"><span class="lbl">Comments</span><textarea id="jNotes" placeholder="Shade, crowds, path conditions, things you'd change…">${esc(g.notes || "")}</textarea></label>
      </div>
    </section>`;
  }
  function wireJournal(plan) {
    const g = (plan.log = plan.log || {});
    const j = $("journal");
    const paceNote = () => {
      const h = +$("jH").value || 0, m = +$("jM").value || 0, d = +$("jKm").value || plan.route.length / 1000;
      $("jPace").textContent = h * 60 + m > 0 ? `Pace: ${(d / ((h * 60 + m) / 60)).toFixed(1)} km/h over ${d.toFixed(1)} km (planned ${durText(plan.route.length)})` : "";
    };
    const read = () => {
      g.walked = $("jWalked").checked;
      g.date = $("jDate").value; g.time = $("jTime").value;
      g.durH = $("jH").value === "" ? null : +$("jH").value; g.durM = $("jM").value === "" ? null : +$("jM").value;
      g.actualKm = $("jKm").value === "" ? null : +$("jKm").value;
      g.stopsDone = [...j.querySelectorAll("[data-stop]")].filter((c) => c.checked).map((c) => +c.dataset.stop);
      g.other = $("jOther").value; g.notes = $("jNotes").value;
      $("jFields").hidden = !g.walked;
      paceNote(); persistIfSaved(plan);
    };
    j.addEventListener("input", read); j.addEventListener("change", read);
    $("jRating").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      g.rating = g.rating === +b.dataset.n ? 0 : +b.dataset.n;
      [...$("jRating").children].forEach((c) => c.classList.toggle("on", +c.dataset.n <= g.rating));
      persistIfSaved(plan);
    });
    paceNote();
  }

  /* ---------- saved list ---------- */
  function renderSaved() {
    const list = loadWalks();
    const cards = list.length
      ? list.map((w) => {
          const g = w.log || {}, len = w.len || 0;
          return `<div class="walk-card"><div><b>${esc(w.name)}</b><small>${km(len)} km · saved ${new Date(w.savedAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}</small><div style="margin-top:4px">${
            g.walked ? `<span class="tag done">✓ Walked ${esc(g.date || "")}</span>${g.rating ? "🍃".repeat(g.rating) : ""}` : '<span class="tag">Planned</span>'}</div></div><button class="btn" data-open="${w.id}" type="button">Open</button></div>`;
        }).join("")
      : '<div class="empty">🌱 No saved walks yet.<br>Plan a walk, then tap “Save walk”.</div>';
    $("saved").innerHTML = `<h2>Saved walks</h2>${cards}
      <div class="btn-row"><button class="ghost sm" id="expBtn" type="button">⬇ Export backup</button><label class="ghost sm" style="display:inline-flex;align-items:center;cursor:pointer;border-radius:12px">⬆ Import<input id="impFile" type="file" accept="application/json" hidden></label></div>
      <p class="note">Walks are stored in this browser at this address. Export a backup to keep them safe or move them to another device.</p>`;
    $("saved").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openSaved(b.dataset.open)));
    $("expBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ app: "wander", version: 1, walks: loadWalks() })], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `wander-walks-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $("impFile").addEventListener("change", async (e) => {
      try {
        const j = JSON.parse(await e.target.files[0].text());
        if (!Array.isArray(j.walks)) throw new Error("bad file");
        const have = loadWalks(), ids = new Set(have.map((w) => w.id));
        const add = j.walks.filter((w) => w && w.id && Array.isArray(w.flat) && !ids.has(w.id));
        writeWalks([...add, ...have]); renderSaved(); toast(`Imported ${add.length} walk${add.length === 1 ? "" : "s"}`);
      } catch (_) { toast("That doesn't look like a Wander backup file.", 3500); }
    });
  }
  function openSaved(id) {
    const w = loadWalks().find((x) => x.id === id);
    if (!w) return;
    const plan = unpack(w);
    plan.weather = null; plan._lastGood = JSON.stringify(plan.wps);
    state.alts = [plan]; state.active = 0; state.editing = false; state.data = null;
    showView("results"); drawPlan(true); renderResults();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------- generate ---------- */
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!state.start) return setStatus("Choose a start point first — tap the map or pick a park.", true);
    const S = state.start, goalM = Math.max(1, Math.min(MAX_KM, +$("distNum").value || +$("dist").value)) * 1000;
    if (S.lat < 1.15 || S.lat > 1.48 || S.lng < 103.6 || S.lng > 104.1) return setStatus("That start point is outside Singapore.", true);
    const endPark = PARKS.find((p) => p.id === $("endSel").value);
    state.end = endPark ? { lat: endPark.lat, lng: endPark.lng, name: endPark.name } : null;
    const mode = state.restMode, val = mode === "count" ? Math.max(0, Math.min(40, Math.round(+$("restCount").value || 0))) : Math.max(0.5, Math.min(MAX_KM, +$("restEvery").value || 2));
    $("goBtn").disabled = true;
    try {
      if (window.NET && !NET.ready && !NET.failed) { setStatus("🗺️ Loading the NParks trail map…"); await netReady; }
      setStatus("🌱 Finding paths through the parks…");
      const alts = await buildAlternatives(S, state.end, goalM);
      const snapD = alts[0].route.snapped && alts[0].route.snapped[0] && alts[0].route.snapped[0].d;
      if (snapD > 120) toast(`Your start was ${Math.round(snapD)} m from the nearest NParks path — moved it onto the path.`, 4500);
      state.data = null;
      const weather = await weatherNote(S, parseWhen().getTime());
      const when = $("when").value, interests = [...state.interests];
      for (const a of alts) {
        Object.assign(a, { goalM, when, restMode: mode, restVal: val, interests, weather, loadingPlaces: true, avoidStairs: $("avoidStairs").checked, preferTrails: state.interests.has("trail"), name: `${shortName(S.name)} walk` });
        await derive(a, false);
      }
      alts.sort((a, b) => planScore(a) - planScore(b));
      state.alts = alts; state.active = 0; state.editing = true;
      showView("results"); drawPlan(true); renderResults(); setStatus("");
      window.scrollTo({ top: 0, behavior: "smooth" });
      enrich(alts);
    } catch (e) {
      console.error(e);
      const off = window.NET && NET.ready ? [[S, "start"], [state.end, "end"]].filter(([pt]) => pt && !NET.snap(pt.lat, pt.lng, 1500)) : [];
      setStatus(off.length && /No routes|routing|fetch|Failed/i.test(String(e.message || e)) ? `There's no NParks path within 1.5 km of your ${off.map((o) => o[1]).join(" and ")} point, and the backup road router didn't respond. Tap closer to a park or path, or try again in a moment.`
        : /No routes/.test(e.message || "") ? "Couldn't find a connected route from there. Try a different start, a shorter distance, or another park." : "Couldn't build a route just now (" + (e.message || e) + "). Check your connection and try again.", true);
    } finally { $("goBtn").disabled = false; }
  });

  /* ---------- NParks trail network: parks, base layers ---------- */
  function inferTags(p) {
    const n = p.name.toLowerCase(), t = new Set();
    if (p.reserve || /nature|reserve|forest|woods|eco|rail corridor|catchment/.test(n)) ["forest", "trail", "quiet"].forEach((x) => t.add(x));
    if (/reservoir|river|waterway|coast|beach|lagoon|bay|marina|lake|canal|wetland|marsh|island|pond/.test(n)) t.add("waterfront");
    if (/garden/.test(n)) t.add("garden");
    if (/hill|ridge|mount|peak|faber|heights/.test(n)) { t.add("scenic"); t.add("trail"); }
    if (p.area > 400000) t.add("quiet");
    if (!t.size) t.add("city");
    return [...t];
  }
  function mergeNetworkParks() {
    const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || (x.length > 5 && y.length > 5 && (x.includes(y) || y.includes(x))); };
    // my hand-placed park coordinates can be off: move each one that isn't inside its real NParks park polygon into it
    const inRing = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [yi, xi] = ring[i], [yj, xj] = ring[j]; if ((xi > pt.lng) !== (xj > pt.lng) && pt.lat < ((yj - yi) * (pt.lng - xi)) / (xj - xi) + yi) c = !c; } return c; };
    for (const a of PARKS) {
      const poly = NET.parks.filter((q) => same(a.name.replace(/ \(.*\)/, ""), q.name)).sort((x, y) => y.area - x.area)[0];
      if (!poly || poly.rings.some((r) => inRing(a, r))) continue;
      const sn = NET.snap(poly.lat, poly.lng, 1200);
      Object.assign(a, sn ? { lat: sn.lat, lng: sn.lng } : { lat: poly.lat, lng: poly.lng });
    }
    const base = PARKS.slice();
    NET.parks.forEach((p, i) => {
      if (p.area < 15000) return;
      if (base.some((c) => same(c.name.replace(/ \(.*\)/, ""), p.name) || hav(c, p) < 700)) return;
      if (/pulau|sisters|marine park|sekudu/i.test(p.name)) return;
      const sn = NET.snap(p.lat, p.lng, 700);
      if (!sn || NET.compKm(sn.node) < 3) return;
      PARKS.push({ id: "np" + i, name: p.name, lat: sn.lat, lng: sn.lng, area: "More NParks parks", tags: inferTags(p), size: p.area });
    });
    for (const a of PARKS) { const sn = NET.snap(a.lat, a.lng, 700); a.comp = sn ? NET.compOf(sn.node) : -1; a.node = sn ? sn.node : null; }
  }
  function refillSelects() {
    const keep = [$("startSel").value, $("endSel").value];
    fillSelect($("startSel"), "Tap the map, or choose a park…"); fillSelect($("endSel"), "Loop back to start");
    $("startSel").value = keep[0]; $("endSel").value = keep[1];
  }
  const TRAIL_COLOR = ["#5f8f4c", "#8b6a3a", "#b79552", "#7aa6b5", "#a3a08f", "#8aa07a", "#8aa07a", "#8aa07a", "#a3a08f"];
  function initNetworkLayers() {
    map.createPane("netPane"); map.getPane("netPane").style.zIndex = 350; map.getPane("netPane").style.pointerEvents = "none";
    const canvas = L.canvas({ pane: "netPane", padding: 0.3 });
    const parksL = L.layerGroup(), pclL = L.layerGroup();
    NET.parks.forEach((p) => p.rings.forEach((r) => L.polygon(r, { stroke: false, fillColor: "#7fae6f", fillOpacity: p.reserve ? 0.2 : 0.14, interactive: false, renderer: canvas }).addTo(parksL)));
    NET.pcl.lines.forEach((l) => L.polyline(l.pts, { color: "#3f8f8a", weight: 2.2, opacity: 0.4, dashArray: "2 5", interactive: false, renderer: canvas }).addTo(pclL));
    const TrailCanvas = L.Layer.extend({
      onAdd(m) { this._m = m; this._c = L.DomUtil.create("canvas", "leaflet-zoom-hide"); m.getPane("netPane").appendChild(this._c); m.on("moveend zoomend resize", this._draw, this); this._draw(); },
      onRemove(m) { m.off("moveend zoomend resize", this._draw, this); this._c.remove(); },
      _draw() {
        const m = this._m, c = this._c, size = m.getSize();
        L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
        c.width = size.x; c.height = size.y;
        const ctx = c.getContext("2d");
        if (m.getZoom() < 13) return;
        const b = m.getBounds();
        ctx.lineCap = "round"; ctx.lineWidth = m.getZoom() >= 16 ? 2.4 : 1.6; ctx.globalAlpha = 0.6;
        for (const e of NET.edgesInBounds({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }, 25000)) {
          if (e.type === 9) continue;
          ctx.strokeStyle = TRAIL_COLOR[e.type] || "#8aa07a"; ctx.beginPath();
          e.pts.forEach((p, i) => { const q = m.latLngToContainerPoint(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
          ctx.stroke();
        }
      },
    });
    const trailsL = new TrailCanvas(), all = [parksL, pclL, trailsL];
    all.forEach((l) => l.addTo(map));
    const ctl = L.control({ position: "topright" });
    ctl.onAdd = () => {
      const d = L.DomUtil.create("div", "leaflet-bar trail-toggle"), b = L.DomUtil.create("button", "", d);
      b.type = "button"; b.textContent = "🌿 Trails"; b.title = "Show or hide the NParks trail network"; b.setAttribute("aria-pressed", "true");
      L.DomEvent.disableClickPropagation(d);
      b.addEventListener("click", () => { const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", on); all.forEach((l) => (on ? l.addTo(map) : map.removeLayer(l))); });
      return d;
    };
    ctl.addTo(map);
    map.attributionControl.addAttribution("Trails © NParks (data.gov.sg)");
  }
  const netReady = window.NET
    ? NET.load().then((ok) => {
        if (ok) { mergeNetworkParks(); refillSelects(); initNetworkLayers(); }
        else toast("NParks trail data couldn't load — using OpenStreetMap routing instead.", 4500);
        return ok;
      })
    : Promise.resolve(false);

  let enrichId = 0;
  async function enrich(alts) {
    const my = ++enrichId;
    await ensureData({ route: { pts: alts.flatMap((a) => a.route.pts) } });
    if (my !== enrichId || state.alts !== alts) return;
    for (const a of alts) { a.loadingPlaces = false; await derive(a, false); }
    drawPlan(false); renderResults();
    if (state.data && state.data.failed) toast("Couldn't load toilets, water and sights just now.", 3500);
  }

  /* ---------- privacy notice & about dialog ---------- */
  const NOTICE_KEY = "wander.notice.v1";
  const dlg = $("aboutDlg");
  const openAbout = () => { try { dlg.showModal(); } catch (_) { dlg.setAttribute("open", ""); } };
  $("aboutLink").addEventListener("click", openAbout);
  $("noticeMore").addEventListener("click", openAbout);
  $("aboutOk").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop closes it
  try { if (!localStorage.getItem(NOTICE_KEY)) $("notice").hidden = false; } catch (_) { $("notice").hidden = false; }
  $("noticeOk").addEventListener("click", () => { $("notice").hidden = true; try { localStorage.setItem(NOTICE_KEY, "1"); } catch (_) { /* fine */ } });

  updateCount();
  window.__wander = { map, state, cur, project, overlapOf, genTours, sunFor, routeVia, loadWalks };
})();
