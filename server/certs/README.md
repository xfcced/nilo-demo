# Local Development Certificates

This directory is for local WebTransport TLS certificates.

Do not commit generated `.pem` files. In particular, `localhost-key.pem` is a private key.

Generate a local certificate from the repository root:

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

Print the SHA-256 hash that the browser client needs for `serverCertificateHashes`:

```bash
openssl x509 -in server/certs/localhost.pem -outform der \
  | openssl dgst -sha256 -binary \
  | xxd -p -c 256
```
