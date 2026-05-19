# Nilo WebTransport Physics Demo

A browser + Rust multiplayer physics demo: server-authoritative Rapier simulation over WebTransport, with client-side prediction for the local player and snapshot-based rendering for everyone else.

## What It Does

- **Slope arena** — tilted runway with side walls; players spawn at the bottom and move toward **+Z** (uphill).
- **Rolling hazards** — server-owned dynamic boxes spawn near the top, roll downhill, and **recycle** back to the launch line when they pass the bottom `recycleZ`.
- **Networking** — WebTransport with a binary reliable control stream plus binary unreliable datagrams for `input` / `state`.
- **Local player** — client Rapier world with input history, reconciliation on authoritative snapshots, and soft correction when prediction drifts.
- **Remote entities** — `PlayerExtrapolator` and `BoxExtrapolator` advance the latest snapshot using linear/angular velocity (not the interpolation buffer used for rendering).
- **Rendering** — fixed third-person camera from `game.json`; Three.js slope meshes and colliders shared between client prediction and visuals.
- **Dev panel** — connection/RTT/FPS/tick, transport counters, prediction metrics, state-interval and loss charts, **Restart**, and optional debug overlays.


## Shared Config

Client and server read gameplay settings from:

```text
config/game.json
```

This covers network defaults, simulation tick rate, **slope** geometry and recycle line, player spawn/movement, **box** count/physics/launch impulses, **camera** aim, interpolation buffer settings (used for debug tooling), and binary **protocol** quantization scales.

Override the server path with:

```bash
GAME_CONFIG_FILE=/path/to/game.json cargo run
```

## Run The Server

```bash
cd server
cargo run
```

The server listens on:

```text
https://localhost:4433/webtransport
```

On startup it prints the SHA-256 certificate hash for the browser `serverCertificateHashes` option. The default hash in `client/index.html` matches `server/certs/localhost.pem` when that cert is present.

## Local Certificates

WebTransport requires HTTPS / HTTP/3. For local development, generate a short-lived localhost certificate:

```bash
mkdir -p server/certs

openssl req -x509 -newkey ec \
  -pkeyopt ec_paramgen_curve:prime256v1 \
  -nodes \
  -keyout server/certs/localhost-key.pem \
  -out server/certs/localhost.pem \
  -days 7 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

The generated `.pem` files are gitignored. Do not commit `localhost-key.pem`.

After generating or regenerating the cert, update the hash in the client UI or in `client/index.html`:

```bash
openssl x509 -in server/certs/localhost.pem -outform der | openssl dgst -sha256 -binary | xxd -p -c 256
```

## Run The Client

```bash
cd client
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

Click **Connect**. A successful session shows connection state, assigned player id, RTT, FPS, latest `serverTick`, and prediction/transport metrics in the dev panel.

### Controls

Use **WASD**, arrow keys, or the on-screen pad.

| Input | World motion |
| --- | --- |
| W / ↑ | Uphill (**+Z**) |
| S / ↓ | Downhill (**−Z**) |
| A / ← | Screen-left across the slope |
| D / → | Screen-right across the slope |

A/D are mapped for the fixed camera (not world −X/+X). The local ball is predicted in a client Rapier scene that mirrors the slope colliders; the server remains authoritative and reconciliation replays inputs after each accepted snapshot.

Remote players and boxes are drawn from the latest state plus velocity extrapolation. Boxes are not predicted locally.

### Debug overlays

- **Prediction debug** — wireframe spheres for authoritative (red), predicted physics (yellow), and rendered visual (cyan) positions, plus a polyline between them. The solid local player mesh is drawn on top.
- **Interpolation debug** — visualizes samples held in `SnapshotInterpolator` (the delay-buffer implementation). This path is **not** used for normal rendering today; it is kept for inspecting what interpolation would use.

**Restart** sends a control-channel `restart` and resets local sync state when the server broadcasts `restarted`.

## Docker Compose Deployment

The Compose setup serves the Vite client as static files behind Nginx and runs the Rust WebTransport server directly. WebTransport is not proxied through Nginx.

Default hostnames:

```text
nilo.luchang.xyz
wt.luchang.xyz
```

Recommended DNS:

```text
nilo.luchang.xyz -> your VPS public IP
wt.luchang.xyz   -> your VPS public IP
```

Open these ports on the VPS firewall and cloud security group:

```text
TCP 80
UDP 443
```

Issue a certificate for the WebTransport domain. The default Compose file expects Let's Encrypt files at:

```text
/etc/letsencrypt/live/wt.luchang.xyz/fullchain.pem
/etc/letsencrypt/live/wt.luchang.xyz/privkey.pem
```

The default `docker-compose.yml` uses GHCR images built by GitHub Actions:

```bash
cd /opt/nilo-demo
docker compose pull
docker compose up -d
```

For local server-side builds without GHCR:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

Useful checks:

```bash
docker compose ps
docker compose logs -f server
```

The production client build leaves `VITE_CERTIFICATE_HASH` empty because a public CA certificate is validated by the browser. For local self-signed certificates, pass the SHA-256 certificate hash as `VITE_CERTIFICATE_HASH`.

## Message Protocol

The client opens a reliable `control` channel over a bidirectional WebTransport stream. Each stream starts with a length-prefixed one-byte channel id frame (`control = 1`), then carries length-prefixed binary payload frames. WebTransport datagrams carry binary `input` and `state` messages. All multi-byte numbers are big-endian, and the first byte of every game message is the message type:

```text
join reliable payload, 1 byte:
  u8  type = 3

restart reliable payload, 1 byte:
  u8  type = 4

ping reliable payload, 5 bytes:
  u8  type = 5
  u32 pingSeq

welcome reliable payload, 2 bytes:
  u8  type = 6
  u8  playerId

restarted reliable payload, 1 byte:
  u8  type = 7

pong reliable payload, 5 bytes:
  u8  type = 8
  u32 pingSeq

error reliable payload, 3-byte header + UTF-8 text:
  u8  type = 9
  u16 byteLength
  u8[] message

input datagram, 6 bytes:
  u8  type = 1
  u32 inputSeq
  u8  buttons bitmask: up=1, down=2, left=4, right=8

state datagram, 11-byte header + players + changed boxes:
  u8  type = 2
  u32 serverTick
  u32 lastReceivedInputSeq
  u8  playerCount
  u8  changedBoxCount

player, 13 bytes:
  u8  playerId
  i16 x, y, z
  i16 vx, vy, vz

box, 26 bytes:
  u8  boxId
  i16 x, y, z
  u8  largestQuatIndex
  i16 qA, qB, qC
  i16 vx, vy, vz
  i16 wx, wy, wz
```

Positions, velocities, and angular velocities are quantized with `protocol.positionScale`; quaternion components use `protocol.quaternionScale`. Rotations use smallest-three quaternion compression: the largest absolute component is omitted, the quaternion is sign-flipped so the omitted component is positive, and the other three components are stored as `i16`.

State datagrams always include all current players. `serverTick` is the authoritative simulation timeline: the client resets to the authoritative pose for that tick, drops local input history at or before that tick, then replays newer local inputs. `lastReceivedInputSeq` reports the newest input sequence the server accepted on that connection (debug/ack; not the replay boundary). The server ignores duplicate or older `inputSeq` values and applies the latest accepted input on subsequent ticks.

New connections receive one full box baseline; later updates are **changed-only** — if a box’s quantized pose and velocities match the previous snapshot, it is omitted and the client keeps extrapolating from its last known state.

Ping RTT is measured on the client by matching `ping.pingSeq` to `pong.pingSeq`.

## Client Sync Overview

```text
state datagram
  ├─► SnapshotInterpolator.pushSnapshot   (buffer + stale-tick filter; debug only)
  ├─► PlayerExtrapolator.pushSnapshot     ──► remote player render positions
  ├─► BoxExtrapolator.pushSnapshot        ──► box render poses
  └─► LocalPlayerPredictor.reconcile      ──► local player prediction

each frame
  ├─► LocalPlayerPredictor.renderPlayer   (local ball)
  ├─► PlayerExtrapolator.sample           (remote players)
  └─► BoxExtrapolator.sample              (boxes)
```

`game.json` → `interpolation.delayTicks` / `entityExpireTicks` still configure `SnapshotInterpolator` for the interpolation debug view. Switching live rendering back to interpolation would mean feeding `interpolator.sample()` into `ArenaScene` instead of the extrapolators.
