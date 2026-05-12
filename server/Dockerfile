FROM rust:1.91-slim-bookworm AS build

WORKDIR /app/server

COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src

RUN cargo build --release

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=build /app/server/target/release/nilo-demo-server /usr/local/bin/nilo-demo-server
COPY config ./config/

ENV PORT=4433
EXPOSE 4433/udp

CMD ["nilo-demo-server"]
