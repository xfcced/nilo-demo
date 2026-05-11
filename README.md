# Nilo WebTransport Physics Demo - Phase 2

This phase establishes the minimum server-authoritative multiplayer physics demo:

- Rust WebTransport server
- Browser WebTransport client
- named reliable WebTransport channels with length-prefixed frames
- `Join -> Welcome` over the `control` channel
- `Ping -> Pong` RTT measurement
- keyboard input sent from the browser
- Rapier-backed server-authoritative player movement
- dynamic server-owned physics boxes included in state snapshots
- world state broadcast back to all connected players
- tick-based snapshot interpolation for remote players and boxes
- Fixed Three.js arena scene
- Debug panel for connection state, player id, RTT, FPS, server tick, and transport

No client prediction, lobby, chat, gameplay datagram sync, goal scoring, or multi-scene abstraction is included yet.

## Run The Server

```bash
cd server
cargo run
```

The server listens on:

```text
https://localhost:4433/webtransport
```

It prints the SHA-256 certificate hash used by the browser `serverCertificateHashes` option. The generated client default currently matches `server/certs/localhost.pem`.

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

The generated `.pem` files are ignored by git. Do not commit `localhost-key.pem`; it is a private key.

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

Click `Connect`. A successful connection shows:

- `Connection: connected`
- assigned `Player ID`
- RTT updated once per second
- latest `serverTick` from world state snapshots

Use `WASD` or arrow keys to move. Movement is calculated on the server and returned through `state` messages. Remote players and boxes are rendered through a client-side interpolation buffer; the local player still uses the latest authoritative state.

## Current Message Protocol

The client opens a named reliable `control` channel over a bidirectional WebTransport stream. Each stream starts with a length-prefixed UTF-8 channel-name frame, then carries length-prefixed payload frames. Low-rate control messages are still JSON:

```ts
type ClientMessage = { type: 'join' } | { type: 'ping'; pingSeq: number }
```

Server messages:

```ts
type ServerMessage = { type: 'welcome'; playerId: number } | { type: 'pong'; pingSeq: number } | { type: 'error'; message: string }
```

High-rate `input` and `state` messages use WebTransport datagrams with a compact big-endian binary format. The first byte is the message type:

```text
input: u8 type=1, u32 inputSeq, u8 buttons
state: u8 type=2, u32 serverTick, u8 playerCount, u8 changedBoxCount, players, changedBoxes
player: u8 playerId, i16 xCm, i16 yCm, i16 zCm
box: u8 boxId, i16 xCm, i16 yCm, i16 zCm, u8 largestQuatIndex, i16 qA, i16 qB, i16 qC
```

Box rotations use smallest-three quaternion compression: the largest absolute component is omitted, the quaternion is sign-flipped if needed so the omitted component is positive, and the other three components are quantized into `i16`.

State datagrams always include all current players. New connections receive one full box baseline, then boxes are changed-only: if a box's quantized position and rotation match the last server snapshot, it is omitted and the client keeps its previous box state.

`serverTick` is the interpolation timeline. Ping RTT is measured entirely on the client by matching `ping.pingSeq` to `pong.pingSeq`.
