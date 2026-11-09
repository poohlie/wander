#!/bin/sh
# Download the NParks open datasets from data.gov.sg into a directory, then rebuild with build_network.py.
#   sh tools/fetch_data.sh /some/empty/dir
#   python3 -I tools/build_network.py /some/empty/dir data
# (data.gov.sg rate-limits anonymous calls, hence the pauses.)
set -e
OUT="${1:?usage: fetch_data.sh <output dir>}"
mkdir -p "$OUT"
for pair in "tracks:d_306cc1018cb733346681883ee6d73054" "pcl:d_a69ef89737379f231d2ae93fd1c5707f" "parks:d_77d7ec97be83d44f61b85454f844382f"; do
  name="${pair%%:*}"; id="${pair##*:}"; url=""
  for try in 1 2 3 4 5; do
    sleep 12
    url=$(curl -s -m 30 "https://api-open.data.gov.sg/v1/public/api/datasets/$id/poll-download" | python3 -I -c "import sys,json;d=json.load(sys.stdin).get('data');print(d['url'] if d else '')")
    [ -n "$url" ] && break
  done
  [ -n "$url" ] || { echo "could not get a download link for $name" >&2; exit 1; }
  curl -s -m 300 -o "$OUT/$name.geojson" "$url"
  echo "downloaded $name"
done
