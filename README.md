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

The client opens a named reliable `control` channel over a bidirectional WebTransport stream. Each stream starts with a length-prefixed UTF-8 channel-name frame, then carries length-prefixed payload frames. The current gameplay payloads are still JSON:

```ts
type ClientMessage =
  | { type: "join" }
  | { type: "ping"; pingSeq: number }
  | { type: "input"; seq: number; up: boolean; down: boolean; left: boolean; right: boolean }
```

Server messages:

```ts
type ServerMessage =
  | { type: "welcome"; playerId: number }
  | { type: "pong"; pingSeq: number }
  | {
      type: "state";
      serverTick: number;
      players: Array<{ playerId: number; x: number; y: number; z: number }>;
      boxes: Array<{ boxId: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }>;
    }
  | { type: "error"; message: string }
```

`serverTick` is the interpolation timeline. Ping RTT is measured entirely on the client by matching `ping.pingSeq` to `pong.pingSeq`. The engine transport also exposes named reliable channels and datagram send/receive hooks; the current game protocol can move high-frequency input/state to datagrams or binary messages once the foundation is stable.
