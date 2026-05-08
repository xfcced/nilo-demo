use crate::protocol::{ClientMessage, ServerMessage};
use crate::room::Room;
use anyhow::{Context, Result};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{error, info, warn};
use wtransport::endpoint::IncomingSession;
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream, ServerConfig};

const WEBTRANSPORT_PATH: &str = "/webtransport";

pub struct WebTransportServer {
    endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>,
    room: Arc<Room>,
}

impl WebTransportServer {
    pub fn new(port: u16, identity: Identity, room: Arc<Room>) -> Result<Self> {
        let config = ServerConfig::builder()
            .with_bind_default(port)
            .with_identity(identity)
            .keep_alive_interval(Some(Duration::from_secs(3)))
            .build();

        let endpoint = Endpoint::server(config).context("failed to create WebTransport endpoint")?;
        Ok(Self { endpoint, room })
    }

    pub fn local_addr(&self) -> Result<std::net::SocketAddr> {
        self.endpoint
            .local_addr()
            .context("failed to read server local address")
    }

    pub async fn serve(self) -> Result<()> {
        let local_addr = self.local_addr()?;
        info!("WebTransport server listening on https://localhost:{}{WEBTRANSPORT_PATH}", local_addr.port());

        loop {
            let incoming_session = self.endpoint.accept().await;
            let room = Arc::clone(&self.room);

            tokio::spawn(async move {
                if let Err(error) = handle_incoming_session(incoming_session, room).await {
                    error!(?error, "WebTransport session failed");
                }
            });
        }
    }
}

async fn handle_incoming_session(incoming_session: IncomingSession, room: Arc<Room>) -> Result<()> {
    let request = incoming_session
        .await
        .context("failed to receive session request")?;

    if request.path() != WEBTRANSPORT_PATH {
        warn!(path = request.path(), "rejecting unknown WebTransport path");
        request.not_found().await;
        return Ok(());
    }

    let connection = request.accept().await.context("failed to accept session")?;
    info!(remote = %connection.remote_address(), "client connected");

    handle_connection(connection, room).await
}

async fn handle_connection(connection: Connection, room: Arc<Room>) -> Result<()> {
    loop {
        let (send_stream, recv_stream) = connection
            .accept_bi()
            .await
            .context("failed to accept bidirectional stream")?;

        let player_id = room.allocate_player_id();
        let remote = connection.remote_address();
        info!(player_id, %remote, "assigned player id");

        tokio::spawn(async move {
            if let Err(error) = handle_message_stream(player_id, send_stream, recv_stream).await {
                error!(player_id, ?error, "message stream failed");
            }
        });
    }
}

async fn handle_message_stream(
    player_id: u64,
    mut send_stream: SendStream,
    recv_stream: RecvStream,
) -> Result<()> {
    let mut reader = BufReader::new(recv_stream);
    let mut line = Vec::new();
    let mut welcomed = false;

    loop {
        line.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut line)
            .await
            .context("failed to read client message")?;

        if bytes_read == 0 {
            info!(player_id, "client message stream closed");
            return Ok(());
        }

        let raw = String::from_utf8_lossy(&line).trim().to_owned();
        if raw.is_empty() {
            continue;
        }

        let message = match serde_json::from_str::<ClientMessage>(&raw) {
            Ok(message) => message,
            Err(error) => {
                write_message(
                    &mut send_stream,
                    &ServerMessage::Error {
                        message: format!("invalid message: {error}"),
                    },
                )
                .await?;
                continue;
            }
        };

        match message {
            ClientMessage::Join => {
                welcomed = true;
                write_message(
                    &mut send_stream,
                    &ServerMessage::Welcome {
                        player_id,
                        server_time: server_time_ms(),
                    },
                )
                .await?;
            }
            ClientMessage::Ping { client_time } => {
                if !welcomed {
                    write_message(
                        &mut send_stream,
                        &ServerMessage::Error {
                            message: "send Join before Ping".to_string(),
                        },
                    )
                    .await?;
                    continue;
                }

                write_message(
                    &mut send_stream,
                    &ServerMessage::Pong {
                        client_time,
                        server_time: server_time_ms(),
                    },
                )
                .await?;
            }
        }
    }
}

async fn write_message(send_stream: &mut SendStream, message: &ServerMessage) -> Result<()> {
    let payload = serde_json::to_string(message).context("failed to encode server message")?;
    send_stream
        .write_all(payload.as_bytes())
        .await
        .context("failed to write server message")?;
    send_stream
        .write_all(b"\n")
        .await
        .context("failed to write server message delimiter")?;
    Ok(())
}

fn server_time_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
