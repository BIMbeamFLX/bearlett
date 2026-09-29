#!/bin/bash
# LNURLcash over FIPS (fips.network), end to end, on one Linux host: two
# FIPS nodes in two network namespaces joined by a veth pair over UDP. Node
# B serves the conformance mock mint on its mesh address only; node A runs
# Bearlett's wallet core against http://<npub of node B>.fips.
#
#   sudo FIPS_BIN=<dir with the fips binary> bash tests/mesh/run.sh
#
# Needs root (namespaces, TUN), node on PATH, npm ci done, python3. Set up,
# run and torn down in this one invocation.
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MESH="$REPO/tests/mesh"
FIPS="${FIPS_BIN:?set FIPS_BIN to the directory holding the fips binary}/fips"
NODE=$(command -v node)
WORK=$(mktemp -d)

pids=()
teardown() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  sleep 1
  ip netns del fips-a 2>/dev/null
  ip netns del fips-b 2>/dev/null
  rm -rf /etc/netns/fips-a /etc/netns/fips-b
}
trap teardown EXIT
teardown

(cd "$REPO" && "$NODE" "$MESH/keys.mjs") > "$WORK/keys.json"
key() { python3 -c "import json; print(json.load(open('$WORK/keys.json'))['$1']['$2'])"; }
NPUB_A=$(key a npub)
NPUB_B=$(key b npub)

# ---- two namespaces, one wire ----
ip netns add fips-a
ip netns add fips-b
ip link add fips-va type veth peer name fips-vb
ip link set fips-va netns fips-a
ip link set fips-vb netns fips-b
ip -n fips-a addr add 10.77.0.1/24 dev fips-va
ip -n fips-b addr add 10.77.0.2/24 dev fips-vb
for ns in fips-a fips-b; do ip -n $ns link set lo up; done
ip -n fips-a link set fips-va up
ip -n fips-b link set fips-vb up
# each namespace resolves through its own node's .fips responder
for ns in fips-a fips-b; do
  mkdir -p /etc/netns/$ns
  echo "nameserver 127.0.0.1" > /etc/netns/$ns/resolv.conf
done

config() { # node nsec udp-addr peer-npub peer-addr
  cat > "$WORK/$1.yaml" <<EOF
node:
  identity:
    nsec: "$2"
  control:
    socket_path: "$WORK/$1.sock"
tun:
  enabled: true
  name: fips0
  mtu: 1280
dns:
  enabled: true
  bind_addr: "127.0.0.1"
  port: 53
transports:
  udp:
    bind_addr: "$3"
    recv_buf_size: 212992
    send_buf_size: 212992
peers:
  - npub: "$4"
    alias: "peer"
    addresses:
      - transport: udp
        addr: "$5"
    connect_policy: auto_connect
EOF
}
config a "$(key a nsec)" 10.77.0.1:2121 "$NPUB_B" 10.77.0.2:2121
config b "$(key b nsec)" 10.77.0.2:2121 "$NPUB_A" 10.77.0.1:2121
ip netns exec fips-a env RUST_LOG=info "$FIPS" -c "$WORK/a.yaml" > "$WORK/a.log" 2>&1 & pids+=($!)
ip netns exec fips-b env RUST_LOG=info "$FIPS" -c "$WORK/b.yaml" > "$WORK/b.log" 2>&1 & pids+=($!)

logs() {
  echo "--- node A"; tail -20 "$WORK/a.log"
  echo "--- node B"; tail -20 "$WORK/b.log"
}

# ---- wait for node B's mesh address, then for A to reach B by name ----
ADDR_B=''
for _ in $(seq 1 60); do
  ADDR_B=$(ip -n fips-b -6 addr show fips0 2>/dev/null | awk '/inet6 fd/ {print $2}' | cut -d/ -f1)
  [ -n "$ADDR_B" ] && break
  sleep 0.5
done
[ -n "$ADDR_B" ] || { echo "node B got no mesh address"; logs; exit 1; }
reached=0
for _ in $(seq 1 60); do
  if ip netns exec fips-a ping -6 -c1 -W1 "$NPUB_B.fips" > /dev/null 2>&1; then reached=1; break; fi
  sleep 0.5
done
[ $reached = 1 ] || { echo "node A cannot reach $NPUB_B.fips"; logs; exit 1; }
echo "node A reaches $NPUB_B.fips at $ADDR_B"

# ---- the mint lives only on node B's mesh address ----
(cd "$REPO" && ip netns exec fips-b "$NODE" "$MESH/mock.mjs") > "$WORK/mock.log" 2>&1 & pids+=($!)
ip netns exec fips-b python3 "$MESH/proxy.py" "$ADDR_B" 80 > "$WORK/proxy.log" 2>&1 & pids+=($!)
sleep 1.5

# ---- the wallet on node A ----
(cd "$REPO" && ip netns exec fips-a "$NODE" --no-warnings "$MESH/wallet.ts" "$NPUB_B")
status=$?
[ $status = 0 ] || logs
exit $status
