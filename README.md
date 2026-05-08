# Nilo WebTransport Physics Demo - Phase 1

This phase establishes the minimum foundation for the later multiplayer physics sync demo:

- Rust WebTransport server
- Browser WebTransport client
- `Join -> Welcome`
- `Ping -> Pong` RTT measurement
- Fixed Three.js arena scene
- Debug panel for connection state, player id, RTT, server time, and transport

No Rapier, physics sync, prediction, interpolation, lobby, or multi-scene abstraction is included yet.

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

## Current Message Protocol

Client messages are newline-delimited JSON over one reliable bidirectional stream:

```ts
type ClientMessage =
  | { type: "join" }
  | { type: "ping"; clientTime: number }
```

Server messages:

```ts
type ServerMessage =
  | { type: "welcome"; playerId: number; serverTime: number }
  | { type: "pong"; clientTime: number; serverTime: number }
  | { type: "error"; message: string }
```

This is intentionally simple for Phase 1. The protocol can move to binary messages once the transport and scene foundation are stable.
