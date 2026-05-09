# Nilo WebTransport Physics Demo - Phase 2

This phase establishes the minimum server-authoritative multiplayer physics demo:

- Rust WebTransport server
- Browser WebTransport client
- `Join -> Welcome`
- `Ping -> Pong` RTT measurement
- keyboard input sent from the browser
- Rapier-backed server-authoritative player movement
- dynamic server-owned physics boxes included in state snapshots
- world state broadcast back to all connected players
- Fixed Three.js arena scene
- Debug panel for connection state, player id, RTT, server time, and transport

No client prediction, interpolation, lobby, chat, datagram sync, goal scoring, client box rendering, or multi-scene abstraction is included yet.

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
- server time from `Pong`

Use `WASD` or arrow keys to move. Movement is calculated on the server and returned through `state` messages.

## Current Message Protocol

Client messages are newline-delimited JSON over one reliable bidirectional stream:

```ts
type ClientMessage =
  | { type: "join" }
  | { type: "ping"; clientTime: number }
  | { type: "input"; seq: number; up: boolean; down: boolean; left: boolean; right: boolean }
```

Server messages:

```ts
type ServerMessage =
  | { type: "welcome"; playerId: number; serverTime: number }
  | { type: "pong"; clientTime: number; serverTime: number }
  | {
      type: "state";
      serverTime: number;
      players: Array<{ playerId: number; x: number; y: number; z: number }>;
      boxes: Array<{ boxId: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }>;
    }
  | { type: "error"; message: string }
```

This is intentionally simple for Phase 2. The protocol can move high-frequency input/state to datagrams or binary messages once the reliable stream foundation is stable.
