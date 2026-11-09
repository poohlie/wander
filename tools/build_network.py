#!/usr/bin/env python3
"""Build compact, routable trail data for Wander from NParks open data (data.gov.sg).

Inputs (GeoJSON, Singapore Open Data Licence v1.0):
  tracks.geojson  - NParks Tracks      (d_306cc1018cb733346681883ee6d73054)
  pcl.geojson     - Park Connector Loop (d_a69ef89737379f231d2ae93fd1c5707f)
  parks.geojson   - NParks Parks and Nature Reserves (d_77d7ec97be83d44f61b85454f844382f)

Usage:  python3 -I tools/build_network.py <raw_dir> <out_dir>
Writes: network.json, parks.json, pcl.json
"""
import json, math, re, sys, collections

raw, out = sys.argv[1], sys.argv[2]
KX = 111320 * math.cos(1.35 * math.pi / 180)
KY = 110540
S = 50000          # vertex identity grid (~2.2 m)
Q = 100000         # stored coordinate precision (1e-5 deg ~1.1 m)
TYPES = ["Footpath", "Boardwalk/Trail", "Staircase", "Cycle Track", "Service Track/Road", "Underpass",
         "Pedestrian Overhead Bridge", "Bridge/Drain Crossing", "None", "Link"]
TYPE_ID = {t: i for i, t in enumerate(TYPES)}
LINK = TYPE_ID["Link"]
WELD_M, LINK_M, SPLIT_M = 15.0, 120.0, 150.0


def load(name):
    with open(f"{raw}/{name}.geojson") as f:
        return json.load(f)["features"]


def parts(g):
    return [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]


def key(c):
    return (round(c[0] * S), round(c[1] * S))


def xy(c):
    return (c[0] * KX, c[1] * KY)


def dist(a, b):
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)


def dp(points, tol):
    """Douglas-Peucker on [lon,lat] points, tolerance in metres."""
    if len(points) < 3:
        return points
    pts = [xy(p) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, bi = -1, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if l2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(points, keep) if k]


# ---------- name cleaning ----------
OVERRIDES = {"HORTPARK": "HortPark", "JLG: LAKESIDE GARDEN": "Jurong Lake Gardens: Lakeside Garden"}
ABBR = [(r"\bPK\b", "Park"), (r"\bPG\b", "Playground"), (r"\bPC\b", "Park Connector"), (r"\bRD\b", "Road"), (r"\bAVE\b", "Avenue"),
        (r"\bNR\b", "Nature Reserve"), (r"\bST\b", "Street"), (r"\bDR\b", "Drive"), (r"\bJLG\b", "Jurong Lake Gardens")]


def clean(n):
    if not n:
        return None
    n = n.strip()
    u = n.upper()
    if u.startswith("PUB") or not n:
        return None
    if u.startswith("SBG"):
        return "Singapore Botanic Gardens"
    if u in OVERRIDES:
        return OVERRIDES[u]
    if n.isupper():
        n = n.title()
        n = re.sub(r"'S\b", "'s", n)
    for pat, rep in ABBR:
        n = re.sub(pat, rep, n, flags=re.I)
    return re.sub(r"\s+", " ", n).strip()


# ---------- parks ----------
parks_raw = load("parks")
parks = []
for f in parks_raw:
    p = f["properties"]
    g = f["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    rings = [poly[0] for poly in polys if poly]
    allp = [pt for r in rings for pt in r]
    if not allp:
        continue
    minx = min(c[0] for c in allp); maxx = max(c[0] for c in allp)
    miny = min(c[1] for c in allp); maxy = max(c[1] for c in allp)
    # centroid of biggest ring (area-weighted shoelace)
    def ring_area_c(r):
        a = cx = cy = 0.0
        for (x1, y1), (x2, y2) in zip(r, r[1:]):
            cr = x1 * y2 - x2 * y1
            a += cr; cx += (x1 + x2) * cr; cy += (y1 + y2) * cr
        return a / 2, (cx / (3 * a) if a else r[0][0]), (cy / (3 * a) if a else r[0][1])
    big = max(rings, key=lambda r: abs(ring_area_c(r)[0]))
    _, cx, cy = ring_area_c(big)
    parks.append({"name": clean(p["NAME"]) or p["NAME"].title(), "area": p["SHAPE_1.AREA"], "res": int(p["N_RESERVE"] or 0),
                  "bbox": (minx, miny, maxx, maxy), "rings": rings, "c": (cx, cy)})
parks.sort(key=lambda p: p["area"])  # smallest first: nested parks win


def pip(pt, ring):
    x, y = pt; inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi:
            inside = not inside
        j = i
    return inside


pgrid = collections.defaultdict(list)
for i, p in enumerate(parks):
    b = p["bbox"]
    for gx in range(int(b[0] * 100), int(b[2] * 100) + 1):
        for gy in range(int(b[1] * 100), int(b[3] * 100) + 1):
            pgrid[(gx, gy)].append(i)


def park_at(pt):
    for i in pgrid.get((int(pt[0] * 100), int(pt[1] * 100)), ()):
        p = parks[i]; b = p["bbox"]
        if b[0] <= pt[0] <= b[2] and b[1] <= pt[1] <= b[3] and any(pip(pt, r) for r in p["rings"]):
            return i
    return -1


# ---------- PCN loops ----------
pcl = load("pcl")
loop_names = sorted({f["properties"]["PCN_LOOP"] for f in pcl if f["properties"].get("PCN_LOOP")})
loop_id = {n: i for i, n in enumerate(loop_names)}
lgrid = collections.defaultdict(list)
pcl_lines = []
for f in pcl:
    li = loop_id.get(f["properties"].get("PCN_LOOP"), -1)
    for ln in parts(f["geometry"]):
        pcl_lines.append((li, ln))
        for a, b in zip(ln, ln[1:]):
            for pt in (a, b, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)):
                lgrid[(int(pt[0] * 2000), int(pt[1] * 2000))].append((li, a, b))


def loop_at(pt, tol=14.0):
    cx, cy = int(pt[0] * 2000), int(pt[1] * 2000)
    best, bl = tol, -1
    px, py = xy(pt)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for li, a, b in lgrid.get((cx + dx, cy + dy), ()):
                ax, ay = xy(a); bx, by = xy(b)
                ddx, ddy = bx - ax, by - ay
                l2 = ddx * ddx + ddy * ddy
                t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * ddx + (py - ay) * ddy) / l2))
                d = math.hypot(px - (ax + t * ddx), py - (ay + t * ddy))
                if d < best:
                    best, bl = d, li
    return bl


# ---------- vertex graph from tracks ----------
tracks = load("tracks")
coord = {}                 # vertex key -> (lon, lat)
edge_of = {}               # frozenset(a,b) -> index
E = []                     # [a, b, type, trackParkName, isPC]
adj = collections.defaultdict(set)
fends = set()              # vertices that are an end of an original track line


def add_edge(a, b, typ, pname, pc):
    if a == b:
        return
    k = (a, b) if a < b else (b, a)
    if k in edge_of:
        return
    edge_of[k] = len(E)
    E.append([a, b, typ, pname, pc])
    adj[a].add(b); adj[b].add(a)


for f in tracks:
    p = f["properties"]
    if p["ALLOW_WALKING"] == "N":
        continue
    typ = TYPE_ID.get(p["TYPE"], TYPE_ID["None"])
    pname = clean(p["PARK"])
    pc = 1 if p["PARK_TYPE"] == "Park Connector" else 0
    for ln in parts(f["geometry"]):
        ks = []
        for c in ln:
            k = key(c)
            coord.setdefault(k, (c[0], c[1]))
            if not ks or ks[-1] != k:
                ks.append(k)
        for a, b in zip(ks, ks[1:]):
            add_edge(a, b, typ, pname, pc)
        if len(ks) > 1:
            fends.add(ks[0]); fends.add(ks[-1])
print("vertices", len(coord), "edges", len(E))

parent = {k: k for k in coord}


def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]
        a = parent[a]
    return a


def rebuild_components():
    for k in parent:
        parent[k] = k
    for a, b, *_ in E:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb


CELL = 40.0
def make_grid():
    g = collections.defaultdict(list)
    for k, c in coord.items():
        x, y = xy(c)
        g[(int(x // CELL), int(y // CELL))].append(k)
    return g


def join_round(radius, typ_override):
    rebuild_components()
    grid = make_grid()
    comp = {k: find(k) for k in coord}
    ends = [k for k in coord if len(adj[k]) == 1 or k in fends]
    added = 0
    for e in ends:
        x, y = xy(coord[e]); cx, cy = int(x // CELL), int(y // CELL)
        best, bd = None, radius
        rng = int(radius // CELL) + 1
        for dx in range(-rng, rng + 1):
            for dy in range(-rng, rng + 1):
                for v in grid.get((cx + dx, cy + dy), ()):
                    if comp[v] == comp[e]:
                        continue
                    vx, vy = xy(coord[v]); d = math.hypot(vx - x, vy - y)
                    if d < bd:
                        bd, best = d, v
        if best is not None:
            nb = next(iter(adj[e]))
            ei = edge_of[(e, nb) if e < nb else (nb, e)]
            add_edge(e, best, typ_override if typ_override is not None else E[ei][2], E[ei][3], E[ei][4])
            added += 1
    return added


w = join_round(WELD_M, None)
l = join_round(LINK_M, LINK)
print("welds", w, "links", l)


def bridge_components(min_km=0.3, max_m=500.0):
    """Join each sizeable leftover piece to its nearest bigger piece with ONE link (<= max_m)."""
    rebuild_components()
    lens = collections.Counter()
    for a, b, *_ in E:
        lens[find(a)] += dist(coord[a], coord[b])
    order = [r for r, _ in lens.most_common()]
    rank = {r: i for i, r in enumerate(order)}
    comp = {k: find(k) for k in coord}
    grid = make_grid()
    members = collections.defaultdict(list)
    for k, r in comp.items():
        members[r].append(k)
    made = 0
    for r in order[1:]:
        if lens[r] < min_km * 1000:
            break
        best, bd, bv = None, max_m, None
        for v in members[r]:
            x, y = xy(coord[v]); cx, cy = int(x // CELL), int(y // CELL)
            rng = int(max_m // CELL) + 1
            for dx in range(-rng, rng + 1):
                for dy in range(-rng, rng + 1):
                    for u in grid.get((cx + dx, cy + dy), ()):
                        if rank.get(comp[u], 10**9) >= rank[r]:
                            continue
                        ux, uy = xy(coord[u]); d = math.hypot(ux - x, uy - y)
                        if d < bd:
                            bd, best, bv = d, u, v
        if best is not None:
            add_edge(bv, best, LINK, None, 0)
            made += 1
            print("  bridged %.1f km piece, gap %.0f m" % (lens[r] / 1000, bd))
    return made


print("bridges", bridge_components())
rebuild_components()
lens = collections.Counter()
for a, b, *_ in E:
    lens[find(a)] += dist(coord[a], coord[b])
tot = sum(lens.values())
print("components", len(lens), "largest %.0f km of %.0f km" % (lens.most_common(1)[0][1] / 1000, tot / 1000))

# ---------- compress to chains between junction nodes ----------
def attrs(a, b):
    k = (a, b) if a < b else (b, a)
    e = E[edge_of[k]]
    return (e[2], e[3], e[4])


def is_node(v):
    if len(adj[v]) != 2:
        return True
    n1, n2 = adj[v]
    return attrs(v, n1)[0] != attrs(v, n2)[0] or (attrs(v, n1)[0] == LINK) != (attrs(v, n2)[0] == LINK)


nodes_v = {v for v in coord if is_node(v)}
visited = set()
chains = []


def walk(start, nxt):
    path = [start, nxt]
    prev, cur = start, nxt
    while cur not in nodes_v:
        a, b = adj[cur]
        n = b if a == prev else a
        k = (cur, n) if cur < n else (n, cur)
        if k in visited:
            break
        prev, cur = cur, n
        path.append(cur)
    return path


def mark(path):
    for a, b in zip(path, path[1:]):
        visited.add((a, b) if a < b else (b, a))


for v in list(nodes_v):
    for n in adj[v]:
        k = (v, n) if v < n else (n, v)
        if k in visited:
            continue
        p = walk(v, n)
        mark(p)
        chains.append(p)
# pure cycles with no node
for k, ei in edge_of.items():
    if k in visited:
        continue
    a = k[0]
    nodes_v.add(a)
    p = walk(a, k[1])
    mark(p)
    chains.append(p)

# split long chains
pieces = []
for p in chains:
    cum = [0.0]
    for a, b in zip(p, p[1:]):
        cum.append(cum[-1] + dist(coord[a], coord[b]))
    L = cum[-1]
    n = max(1, math.ceil(L / SPLIT_M))
    cuts = [0]
    for i in range(1, n):
        target = L * i / n
        j = min(range(len(p)), key=lambda t: abs(cum[t] - target))
        if j > cuts[-1] and j < len(p) - 1:
            cuts.append(j)
    cuts.append(len(p) - 1)
    for a, b in zip(cuts, cuts[1:]):
        if b > a:
            pieces.append(p[a:b + 1])
print("chains", len(chains), "pieces", len(pieces))

# ---------- output arrays ----------
park_names = []
park_idx = {}
node_idx = {}
node_xy = []


def nid(v):
    if v not in node_idx:
        node_idx[v] = len(node_xy)
        c = coord[v]
        node_xy.append((round(c[0] * Q), round(c[1] * Q)))
    return node_idx[v]


def pid(name):
    if not name:
        return -1
    if name not in park_idx:
        park_idx[name] = len(park_names)
        park_names.append(name)
    return park_idx[name]


edges_flat = []
geom = []
total_len = 0
for p in pieces:
    pts = [coord[v] for v in p]
    L = sum(dist(a, b) for a, b in zip(pts, pts[1:]))
    typ, tname, pc = attrs(p[0], p[1])
    # attribute by middle vertex
    mid = pts[len(pts) // 2]
    mid = ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2) if len(pts) == 2 else mid
    pi = park_at(mid)
    pname = parks[pi]["name"] if pi >= 0 else tname
    if typ == LINK:
        pname = None
    li = loop_at(mid) if typ != LINK else -1
    simp = dp(pts, 1.5)
    inner = simp[1:-1]
    gs = len(geom) // 2
    px, py = round(pts[0][0] * Q), round(pts[0][1] * Q)
    for c in inner:
        qx, qy = round(c[0] * Q), round(c[1] * Q)
        geom += [qx - px, qy - py]
        px, py = qx, qy
    u, v = nid(p[0]), nid(p[-1])
    edges_flat += [u, v, round(L), typ, pid(pname), li, gs, len(inner)]
    total_len += L

meta = {"v": 1, "types": TYPES, "loops": loop_names, "parks": park_names, "nodes": [c for xy_ in node_xy for c in xy_], "edges": edges_flat, "geom": geom,
        "attribution": "Trail data © National Parks Board, Singapore (data.gov.sg, Singapore Open Data Licence v1.0)"}
with open(f"{out}/network.json", "w") as f:
    json.dump(meta, f, separators=(",", ":"))
print("network: nodes", len(node_xy), "edges", len(edges_flat) // 8, "km", round(total_len / 1000))

# parks overlay + anchors
park_out = []
for p in sorted(parks, key=lambda p: -p["area"]):
    if p["area"] < 8000:
        continue
    rings = []
    for r in p["rings"]:
        s = dp(r, 8.0)
        if len(s) >= 4:
            rings.append([round(c * Q) for pt in s for c in pt])
    if rings:
        park_out.append({"n": p["name"], "c": [round(p["c"][0] * Q), round(p["c"][1] * Q)], "a": round(p["area"]), "r": p["res"], "p": rings})
with open(f"{out}/parks.json", "w") as f:
    json.dump({"v": 1, "parks": park_out}, f, separators=(",", ":"))
print("parks", len(park_out))

# PCN overlay
lines = []
for li, ln in pcl_lines:
    s = dp(ln, 3.0)
    if len(s) >= 2:
        lines.append([li, [round(c * Q) for pt in s for c in pt]])
with open(f"{out}/pcl.json", "w") as f:
    json.dump({"v": 1, "loops": loop_names, "lines": lines}, f, separators=(",", ":"))
print("pcl lines", len(lines))
