/* Wander — NParks trail network: loading, snapping and A* routing in the browser.
 * Data built by tools/build_network.py from NParks open data (data.gov.sg).
 * Costs favour proper paths, penalise stairs/short road links, and discourage re-using
 * an edge already walked earlier in the same route (so loops don't retrace). */
(() => {
  "use strict";
  const rad = Math.PI / 180;
  const Q = 1e5, CELL = 0.002, MCELL = 0.00018; // MCELL ~ 20 m
  const T = { FOOT: 0, TRAIL: 1, STAIRS: 2, CYCLE: 3, SERVICE: 4, UNDER: 5, POB: 6, BRIDGE: 7, NONE: 8, LINK: 9 };
  const BASE_MULT = [1, 1, 2.2, 1.25, 1.5, 1.1, 1.3, 1.0, 1.6, 4];
  const NET = { ready: false, failed: false, error: null, attribution: "", parks: [], pcl: null, loops: [], parkNames: [], types: [], n: 0, m: 0 };
  let mgrid, nx, ny, eu, ev, elen, etype, epark, eloop, egs, egc, geom, adjStart, adjEdge, adjNode, grid, comp, compLen;

  const hav = (aLat, aLng, bLat, bLng) => {
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  const cellKey = (lat, lng) => Math.floor(lng / CELL) * 10000 + Math.floor(lat / CELL);
  const baseName = (n) => (n ? n.replace(/\s*\(.*?\)\s*$/, "").trim() : null);

  function build(net) {
    NET.types = net.types; NET.loops = net.loops; NET.parkNames = net.parks; NET.attribution = net.attribution;
    const n = net.nodes.length / 2, m = net.edges.length / 8;
    nx = new Float64Array(n); ny = new Float64Array(n);
    for (let i = 0; i < n; i++) { nx[i] = net.nodes[2 * i] / Q; ny[i] = net.nodes[2 * i + 1] / Q; }
    eu = new Int32Array(m); ev = new Int32Array(m); elen = new Int32Array(m); etype = new Uint8Array(m);
    epark = new Int16Array(m); eloop = new Int16Array(m); egs = new Int32Array(m); egc = new Int32Array(m);
    const E = net.edges;
    for (let i = 0; i < m; i++) { const o = i * 8; eu[i] = E[o]; ev[i] = E[o + 1]; elen[i] = E[o + 2]; etype[i] = E[o + 3]; epark[i] = E[o + 4]; eloop[i] = E[o + 5]; egs[i] = E[o + 6]; egc[i] = E[o + 7]; }
    geom = Int32Array.from(net.geom);
    const deg = new Int32Array(n + 1);
    for (let i = 0; i < m; i++) { deg[eu[i]]++; deg[ev[i]]++; }
    adjStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + deg[i];
    const fill = adjStart.slice(0, n);
    adjEdge = new Int32Array(2 * m); adjNode = new Int32Array(2 * m);
    for (let i = 0; i < m; i++) {
      adjEdge[fill[eu[i]]] = i; adjNode[fill[eu[i]]++] = ev[i];
      adjEdge[fill[ev[i]]] = i; adjNode[fill[ev[i]]++] = eu[i];
    }
    grid = new Map();
    for (let i = 0; i < n; i++) { const k = cellKey(ny[i], nx[i]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    // edge midpoints, so paths running right beside a used one can be discouraged too
    mgrid = new Map();
    for (let i = 0; i < m; i++) {
      const k = Math.floor(((nx[eu[i]] + nx[ev[i]]) / 2) / MCELL) * 100000 + Math.floor(((ny[eu[i]] + ny[ev[i]]) / 2) / MCELL);
      (mgrid.get(k) || mgrid.set(k, []).get(k)).push(i);
    }
    // connected components
    const par = new Int32Array(n).map((_, i) => i);
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let i = 0; i < m; i++) { const a = find(eu[i]), b = find(ev[i]); if (a !== b) par[a] = b; }
    comp = new Int32Array(n); compLen = new Map();
    for (let i = 0; i < n; i++) comp[i] = find(i);
    for (let i = 0; i < m; i++) compLen.set(comp[eu[i]], (compLen.get(comp[eu[i]]) || 0) + elen[i]);
    NET.n = n; NET.m = m;
  }

  async function load(base = "data/") {
    try {
      const [net, parks, pcl] = await Promise.all(["network.json", "parks.json", "pcl.json"].map((f) => fetch(base + f).then((r) => { if (!r.ok) throw new Error(f + " " + r.status); return r.json(); })));
      build(net);
      NET.parks = parks.parks.map((p) => ({ name: p.n, lat: p.c[1] / Q, lng: p.c[0] / Q, area: p.a, reserve: !!p.r, rings: p.p.map((r) => { const o = []; for (let i = 0; i < r.length; i += 2) o.push([r[i + 1] / Q, r[i] / Q]); return o; }) }));
      NET.pcl = { loops: pcl.loops, lines: pcl.lines.map(([li, flat]) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i + 1] / Q, flat[i] / Q]); return { loop: li, pts: o }; }) };
      NET.ready = true;
    } catch (e) { NET.failed = true; NET.error = e; console.warn("Trail network unavailable:", e); }
    return NET.ready;
  }

  /* ---------- snapping ---------- */
  // Nearest network node within maxM metres, preferring well-connected components.
  function snap(lat, lng, maxM = 450, onlyComp = null) {
    if (!NET.ready) return null;
    const rings = Math.ceil(maxM / 200) + 1, cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
    let best = null, bs = Infinity;
    for (let dx = -rings; dx <= rings; dx++) for (let dy = -rings; dy <= rings; dy++) {
      const arr = grid.get((cx + dx) * 10000 + (cy + dy));
      if (!arr) continue;
      for (const i of arr) {
        const d = hav(lat, lng, ny[i], nx[i]);
        if (d > maxM) continue;
        if (onlyComp != null && comp[i] !== onlyComp) continue;
        const s = d + (onlyComp == null && (compLen.get(comp[i]) || 0) < 2000 ? 150 : 0);
        if (s < bs) { bs = s; best = { node: i, d, lat: ny[i], lng: nx[i] }; }
      }
    }
    return best;
  }
  const compKm = (node) => (compLen.get(comp[node]) || 0) / 1000;
  const sameComp = (a, b) => comp[a] === comp[b];
  const compOf = (node) => comp[node];

  /* ---------- A* ---------- */
  class Heap {
    constructor() { this.k = []; this.v = []; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
    get size() { return this.k.length; }
  }

  function nearEdges(e) { // other edges whose midpoint lies within ~18 m of this edge's midpoint
    const mx = (nx[eu[e]] + nx[ev[e]]) / 2, my = (ny[eu[e]] + ny[ev[e]]) / 2, cx = Math.floor(mx / MCELL), cy = Math.floor(my / MCELL), out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = mgrid.get((cx + dx) * 100000 + (cy + dy));
      if (arr) for (const q of arr) if (q !== e && hav(my, mx, (ny[eu[q]] + ny[ev[q]]) / 2, (nx[eu[q]] + nx[ev[q]]) / 2) < 18) out.push(q);
    }
    return out;
  }

  // Real walking distances (metres along the cheapest path) from a node to every node within maxLen.
  function lengthsFrom(s, opts = {}, maxLen = Infinity) {
    const mult = multipliers(opts), n = NET.n, g = new Float64Array(n).fill(Infinity), L = new Float64Array(n).fill(Infinity), done = new Uint8Array(n), H = new Heap();
    g[s] = 0; L[s] = 0; H.push(0, s);
    while (H.size) {
      const u = H.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (L[u] > maxLen) continue;
      for (let a = adjStart[u]; a < adjStart[u + 1]; a++) {
        const w = adjNode[a], e = adjEdge[a];
        if (done[w]) continue;
        const c = g[u] + elen[e] * mult[etype[e]];
        if (c < g[w]) { g[w] = c; L[w] = L[u] + elen[e]; H.push(c, w); }
      }
    }
    return L;
  }

  function multipliers(opts) {
    const m = BASE_MULT.slice();
    if (opts.avoidStairs) m[T.STAIRS] = 40;
    if (opts.preferTrails) m[T.TRAIL] = 0.8;
    return m;
  }

  function astar(s, t, mult, used, hmin) {
    const n = NET.n, g = new Float64Array(n).fill(Infinity), pe = new Int32Array(n).fill(-1), pn = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const h = (i) => hav(ny[i], nx[i], ny[t], nx[t]) * hmin;
    const H = new Heap();
    g[s] = 0; H.push(h(s), s);
    while (H.size) {
      const u = H.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === t) break;
      for (let a = adjStart[u]; a < adjStart[u + 1]; a++) {
        const w = adjNode[a], e = adjEdge[a];
        if (done[w]) continue;
        const c = g[u] + elen[e] * mult[etype[e]] * (1 + 15 * (used.get(e) || 0));
        if (c < g[w]) { g[w] = c; pe[w] = e; pn[w] = u; H.push(c + h(w), w); }
      }
    }
    if (g[t] === Infinity) return null;
    const out = [];
    for (let v = t; v !== s; v = pn[v]) out.push({ e: pe[v], from: pn[v], to: v });
    return out.reverse();
  }

  function edgePts(e, from) { // [[lat,lng],…] from `from` node to the other end
    const pts = [[ny[eu[e]], nx[eu[e]]]];
    let x = Math.round(nx[eu[e]] * Q), y = Math.round(ny[eu[e]] * Q);
    for (let i = 0; i < egc[e]; i++) { x += geom[2 * (egs[e] + i)]; y += geom[2 * (egs[e] + i) + 1]; pts.push([y / Q, x / Q]); }
    pts.push([ny[ev[e]], nx[ev[e]]]);
    return from === eu[e] ? pts : pts.reverse();
  }

  const nodeLng = (i) => nx[i];
  // Path point near an off-path pin P that lies roughly towards `toward` (so the walk can leave/rejoin the paths there).
  function nearNode(P, toward, onlyComp, maxM = 1200) {
    const rings = Math.ceil(maxM / 200) + 1, cx = Math.floor(P.lng / CELL), cy = Math.floor(P.lat / CELL);
    let best = null, bs = Infinity;
    for (let dx = -rings; dx <= rings; dx++) for (let dy = -rings; dy <= rings; dy++) {
      const arr = grid.get((cx + dx) * 10000 + (cy + dy));
      if (!arr) continue;
      for (const i of arr) {
        const d = hav(P.lat, P.lng, ny[i], nx[i]);
        if (d > maxM) continue;
        if (onlyComp != null && comp[i] !== onlyComp) continue;
        const sc = 1.5 * d + (toward ? hav(ny[i], nx[i], toward.lat, toward.lng) : 0);
        if (sc < bs) { bs = sc; best = i; }
      }
    }
    return best;
  }

  // Best visiting order for the pins between the fixed first and last one (brute force; there are only a handful).
  function bestOrder(sn, opts) {
    const n = sn.length;
    if (n < 4 || n > 9 || sn.some((x) => !x)) return null;
    const nodes = sn.map((x) => x.node), D = [];
    for (let i = 0; i < n - 1; i++) { const L = lengthsFrom(nodes[i], opts); D.push(nodes.map((v) => L[v])); }
    const cost = (perm) => { let t = D[0][perm[0]]; for (let i = 0; i + 1 < perm.length; i++) t += D[perm[i]][perm[i + 1]]; return t + D[perm[perm.length - 1]][n - 1]; };
    const vias = Array.from({ length: n - 2 }, (_, i) => i + 1), current = cost(vias);
    let best = vias.slice(), bc = current;
    const permute = (arr, k) => { if (k === arr.length) { const c = cost(arr); if (c < bc) { bc = c; best = arr.slice(); } return; } for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; permute(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; } };
    permute(vias.slice(), 0);
    if (!isFinite(bc) || bc > current * 0.9) return null; // only reorder when it clearly helps
    return [0, ...best, n - 1];
  }

  /* ---------- routing ---------- */
  // wps: [{lat,lng}]. Legs inside one connected piece of the NParks network are routed on it;
  // legs between pieces (or off-network) use opts.osrm([a,b]) -> [{lat,lng}…] if supplied.
  async function route(wps, opts = {}) {
    if (!NET.ready) return null;
    let sn = wps.map((w) => snap(w.lat, w.lng, opts.maxSnap || 1500)), order = null;
    if (opts.reorder) { // visit the pins in the shortest order, so dragging one past another doesn't make the route criss-cross
      order = bestOrder(sn, opts);
      if (order) { wps = order.map((i) => wps[i]); sn = order.map((i) => sn[i]); }
    }
    const pt = (i) => (sn[i] ? { lat: sn[i].lat, lng: sn[i].lng } : { lat: wps[i].lat, lng: wps[i].lng });
    const mult = multipliers(opts), hmin = Math.min(1, ...mult), used = new Map(), items = [];
    const keep = new Set(); // nodes of pins the user placed on purpose: never trimmed away
    wps.forEach((w, i) => { if (w.keep && sn[i]) keep.add(sn[i].node); });
    // A pin that is away from the NParks paths stays exactly where it was dropped. Only the stretch next to it leaves
    // the paths (ordinary footpaths): we leave at a path point near it, walk to the pin, and rejoin at another one.
    const stops = [];
    wps.forEach((w, i) => {
      if (sn[i]) { stops.push({ pt: pt(i), node: sn[i].node }); return; }
      const P = pt(i), prev = i > 0 ? stops[stops.length - 1] : null, next = i + 1 < wps.length ? sn[i + 1] || null : null;
      const inN = prev && prev.node != null ? nearNode(P, prev.pt, comp[prev.node]) : null;
      const outN = next ? nearNode(P, pt(i + 1), comp[next.node]) : null;
      if (inN != null) stops.push({ pt: { lat: ny[inN], lng: nodeLng(inN) }, node: inN });
      stops.push({ pt: P, node: null });
      if (outN != null) stops.push({ pt: { lat: ny[outN], lng: nodeLng(outN) }, node: outN });
    });
    let graphLegs = 0;
    for (let i = 0; i + 1 < stops.length; i++) {
      const A = stops[i], B = stops[i + 1];
      if (A.node != null && A.node === B.node) continue;
      let seq = null;
      if (A.node != null && B.node != null && sameComp(A.node, B.node)) {
        const len = (q) => q.reduce((t, st) => t + elen[st.e], 0);
        seq = astar(A.node, B.node, mult, used, hmin);
        if (seq && used.size) { // avoiding paths already used must not cost an absurd detour: accept some retracing instead
          const plain = astar(A.node, B.node, mult, new Map(), hmin);
          if (plain && len(seq) > len(plain) * 1.6 + 300) seq = plain;
        }
        // two points that are close on the map but very far apart through the trails (e.g. across an expressway): don't walk it
        if (seq && opts.maxDetour && len(seq) > opts.maxDetour * hav(A.pt.lat, A.pt.lng, B.pt.lat, B.pt.lng) + 1500) seq = null;
      }
      if (seq) {
        graphLegs++;
        for (const st of seq) {
          used.set(st.e, (used.get(st.e) || 0) + 1);
          for (const q of nearEdges(st.e)) used.set(q, Math.max(used.get(q) || 0, 0.6));
          items.push({ e: st.e, from: st.from, to: st.to });
        }
      } else {
        if (!opts.osrm) return null;
        const leg = await opts.osrm([A.pt, B.pt]);
        if (!leg) return null;
        items.push({ o: [...leg, B.pt] });
      }
    }
    // cut out dead-end spurs: walking an edge and straight back is just wasted distance
    const seqOut = [];
    for (const it of items) {
      const top = seqOut[seqOut.length - 1];
      if (top && !it.o && !top.o && top.e === it.e && top.to === it.from && top.from === it.to && !keep.has(top.to)) seqOut.pop();
      else seqOut.push(it);
    }
    const pts = [pt(0)], cum = [0], spans = [];
    let along = 0;
    const push = (lat, lng) => {
      const prev = pts[pts.length - 1], d = hav(prev.lat, prev.lng, lat, lng);
      if (d < 0.05) return;
      along += d; pts.push({ lat, lng }); cum.push(along);
    };
    for (const it of seqOut) {
      const a0 = along, i0 = pts.length - 1;
      if (it.o) { for (const p of it.o) push(p.lat, p.lng); spans.push([-1, a0, along, i0, pts.length - 1]); }
      else { const ep = edgePts(it.e, it.from); for (let k = 1; k < ep.length; k++) push(ep[k][0], ep[k][1]); spans.push([it.e, a0, along, i0, pts.length - 1]); }
    }
    if (pts.length < 2) return null;
    const r = { order, pts, cum, length: along, engine: graphLegs ? "nparks" : "osm", snapped: sn.map((s, i) => (s ? { lat: s.lat, lng: s.lng, d: s.d } : { lat: wps[i].lat, lng: wps[i].lng, d: null })), spans };
    r.trail = summarize(r);
    const cnt = new Map();
    let dupM = 0;
    for (const sp of spans) if (sp[0] >= 0) { const c = cnt.get(sp[0]) || 0; if (c > 0) dupM += sp[2] - sp[1]; cnt.set(sp[0], c + 1); }
    r.dupM = dupM; // metres walked along an edge that was already used earlier
    return r;
  }

  /* ---------- summary of what the route is made of ---------- */
  function summarize(r) {
    const parks = new Map(), loops = new Map(), links = [], osm = [];
    let stairsRuns = 0, stairM = 0, trailM = 0, linkM = 0, osmM = 0, cycleM = 0, serviceM = 0, prevStairs = false;
    const addRange = (arr, i0, i1) => { const last = arr[arr.length - 1]; if (last && last[1] === i0) last[1] = i1; else arr.push([i0, i1]); };
    for (const [e, a0, a1, i0, i1] of r.spans) {
      const len = a1 - a0;
      if (e < 0) { osmM += len; addRange(osm, a0, a1); prevStairs = false; continue; }
      const ty = etype[e], pn = baseName(NET.parkNames[epark[e]]);
      if (pn) { const p = parks.get(pn) || parks.set(pn, { name: pn, m: 0, along: a0 }).get(pn); p.m += len; }
      if (eloop[e] >= 0) { const nme = NET.loops[eloop[e]], l = loops.get(nme) || loops.set(nme, { name: nme, m: 0, along: a0 }).get(nme); l.m += len; }
      if (ty === T.STAIRS) { stairM += len; if (!prevStairs) stairsRuns++; }
      prevStairs = ty === T.STAIRS;
      if (ty === T.TRAIL) trailM += len;
      if (ty === T.CYCLE) cycleM += len;
      if (ty === T.SERVICE) serviceM += len;
      if (ty === T.LINK) { linkM += len; addRange(links, a0, a1); }
    }
    return { parks: [...parks.values()], loops: [...loops.values()], stairsRuns, stairM, trailM, linkM, osmM, cycleM, serviceM, linkRanges: links, osmRanges: osm, onTrailPct: r.length ? 1 - (linkM + osmM) / r.length : 1 };
  }

  /* ---------- helpers for the map layer ---------- */
  function edgesInBounds(b, maxCount = 9000) { // b: {s,w,n,e}
    const out = [];
    for (let e = 0; e < NET.m && out.length < maxCount; e++) {
      const a = eu[e], c = ev[e];
      const lat1 = ny[a], lng1 = nx[a], lat2 = ny[c], lng2 = nx[c];
      if (Math.max(lat1, lat2) < b.s - 0.002 || Math.min(lat1, lat2) > b.n + 0.002 || Math.max(lng1, lng2) < b.w - 0.002 || Math.min(lng1, lng2) > b.e + 0.002) continue;
      out.push({ type: etype[e], pts: edgePts(e, a) });
    }
    return out;
  }
  const nodeCount = () => NET.n;

  Object.assign(NET, { summarize, load, snap, route, lengthsFrom, compKm, sameComp, compOf, edgesInBounds, nodeCount, T, baseName });
  window.NET = NET;
})();
