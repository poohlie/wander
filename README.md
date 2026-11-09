# Wander — Singapore park walk planner

Plan walks along NParks paths: pick a distance, start/end, interests and rest stops; drag pins to reshape the
route; save walks and log how they went.

## Run
```
python3 -m http.server 8765      # from this folder
```
Open <http://localhost:8765> (always the same address — saved walks live in that browser origin; use
*Saved → Export backup* to keep or move them).

## How routing works
* `data/network.json` is a routable graph of ~1,300 km of NParks paths (parks, nature trails, boardwalks and
  Park Connectors), built from the NParks **Tracks** dataset. Routing runs in the browser (`net.js`, A*), so it
  is instant and works without any routing server.
* Costs prefer proper paths, penalise staircases and short road links, and discourage re-using a path already
  walked in the same route (including paths running right beside it). Dead-end spurs are trimmed.
* NParks paths that don't quite touch are joined (≤15 m) or bridged with a dashed "short link" (≤120 m, and
  up to 450 m for large separate pieces). Where two points are in disconnected pieces, the app falls back to the
  OpenStreetMap foot router for just that leg (dashed teal).
* Rest stops / toilets / water / shelters / extra sights come from OpenStreetMap (Overpass) and fill in after
  the route appears.

## Rebuilding the trail data
```
sh tools/fetch_data.sh /tmp/nparks_raw
python3 -I tools/build_network.py /tmp/nparks_raw data
```
Datasets (data.gov.sg): NParks Tracks `d_306cc1018cb733346681883ee6d73054`, Park Connector Loop
`d_a69ef89737379f231d2ae93fd1c5707f`, NParks Parks and Nature Reserves `d_77d7ec97be83d44f61b85454f844382f`.

## Privacy
Wander has no server, accounts, cookies or analytics. Everything runs in the visitor's browser, and saved walks are
kept only in that browser's local storage. To plan walks the browser contacts free public services directly
(OpenStreetMap tiles, the OpenStreetMap foot router, Overpass, and the data.gov.sg weather feed), which receive the
visitor's IP address and the coordinates involved. The in-app "Privacy, licences & disclaimer" page explains this to
users — keep it up to date if you add or change any outside service.

## Attribution
Trail, park and park-connector data © National Parks Board, Singapore — data.gov.sg, used under the
[Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). Map tiles © OpenStreetMap contributors.
