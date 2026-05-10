use super::protocol::{ClientMessage, ServerMessage};
use super::room::{OutboundSender, PlayerInput, Room};
use crate::net::line_stream::{outbound_line_channel, write_lines, LineReader};
use crate::net::webtransport_server::WebTransportServer;
use anyhow::{Context, Result};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{self, Instant};
use tracing::{error, info};
use wtransport::{Connection, Identity, RecvStream};

const WEBTRANSPORT_PATH: &str = "/webtransport";
const TICK_RATE: f32 = 30.0;
const MAX_FRAME_TIME: Duration = Duration::from_millis(250);
const MAX_TICKS_PER_FRAME: usize = 8;

pub struct ServerHost {
    transport: WebTransportServer,
    room: Arc<Room>,
}

impl ServerHost {
    pub fn new(port: u16, identity: Identity, room: Arc<Room>) -> Result<Self> {
        let transport = WebTransportServer::new(port, identity, WEBTRANSPORT_PATH)?;
        Ok(Self { transport, room })
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        self.transport.local_addr()
    }

    pub async fn serve(self) -> Result<()> {
        let tick_room = Arc::clone(&self.room);
        tokio::spawn(async move {
            run_room_tick(tick_room).await;
        });

        let room = Arc::clone(&self.room);
        self.transport
            .serve(move |connection| {
                let room = Arc::clone(&room);
                async move { handle_connection(connection, room).await }
            })
            .await
    }
}

async fn handle_connection(connection: Connection, room: Arc<Room>) -> Result<()> {
    loop {
        let (send_stream, recv_stream) = connection
            .accept_bi()
            .await
            .context("failed to accept bidirectional stream")?;

        let (line_sender, line_receiver) = outbound_line_channel();
        let (message_sender, message_receiver) = mpsc::unbounded_channel();
        let player_id = room.add_player(message_sender.clone());
        let remote = connection.remote_address();
        info!(player_id, %remote, "assigned player id");

        tokio::spawn(async move {
            if let Err(error) = write_lines(send_stream, line_receiver).await {
                error!(player_id, ?error, "line write stream failed");
            }
        });

        tokio::spawn(async move {
            if let Err(error) = encode_messages(message_receiver, line_sender).await {
                error!(player_id, ?error, "message encode stream failed");
            }
        });

        let stream_room = Arc::clone(&room);
        tokio::spawn(async move {
            if let Err(error) = handle_message_stream(
                player_id,
                message_sender,
                recv_stream,
                Arc::clone(&stream_room),
            )
            .await
            {
                error!(player_id, ?error, "message stream failed");
            }

            stream_room.remove_player(player_id);
            info!(player_id, "removed player");
        });
    }
}

async fn encode_messages(
    mut receiver: mpsc::UnboundedReceiver<ServerMessage>,
    line_sender: mpsc::UnboundedSender<String>,
) -> Result<()> {
    while let Some(message) = receiver.recv().await {
        let payload = serde_json::to_string(&message).context("failed to encode server message")?;
        let _ = line_sender.send(payload);
    }

    Ok(())
}

async fn handle_message_stream(
    player_id: u64,
    sender: mpsc::UnboundedSender<ServerMessage>,
    recv_stream: RecvStream,
    room: Arc<Room>,
) -> Result<()> {
    let mut reader = LineReader::new(recv_stream);
    let mut welcomed = false;

    while let Some(raw) = reader.read_line().await? {
        if raw.is_empty() {
            continue;
        }

        let message = match serde_json::from_str::<ClientMessage>(&raw) {
            Ok(message) => message,
            Err(error) => {
                let _ = sender.send(ServerMessage::Error {
                    message: format!("invalid message: {error}"),
                });
                continue;
            }
        };

        match message {
            ClientMessage::Join => {
                welcomed = true;
                let _ = sender.send(ServerMessage::Welcome {
                    player_id,
                });
            }
            ClientMessage::Ping { ping_seq } => {
                if !welcomed {
                    let _ = sender.send(ServerMessage::Error {
                        message: "send Join before Ping".to_string(),
                    });
                    continue;
                }

                let _ = sender.send(ServerMessage::Pong {
                    ping_seq,
                });
            }
            ClientMessage::Input {
                seq,
                up,
                down,
                left,
                right,
            } => {
                if !welcomed {
                    let _ = sender.send(ServerMessage::Error {
                        message: "send Join before Input".to_string(),
                    });
                    continue;
                }

                room.update_input(
                    player_id,
                    seq,
                    PlayerInput {
                        up,
                        down,
                        left,
                        right,
                    },
                );
            }
        }
    }

    info!(player_id, "client message stream closed");
    Ok(())
}

async fn run_room_tick(room: Arc<Room>) {
    let tick_duration = Duration::from_secs_f32(1.0 / TICK_RATE);
    let mut previous_time = Instant::now();
    let mut accumulator = Duration::ZERO;

    loop {
        let now = Instant::now();
        let frame_time = now.duration_since(previous_time).min(MAX_FRAME_TIME);
        previous_time = now;
        accumulator += frame_time;

        let mut ticks_this_frame = 0;
        while accumulator >= tick_duration && ticks_this_frame < MAX_TICKS_PER_FRAME {
            room.tick(1.0 / TICK_RATE);
            broadcast_room_state(&room);

            accumulator -= tick_duration;
            ticks_this_frame += 1;
        }

        if ticks_this_frame == MAX_TICKS_PER_FRAME {
            accumulator = Duration::ZERO;
        }

        if accumulator < tick_duration {
            time::sleep(tick_duration - accumulator).await;
        } else {
            tokio::task::yield_now().await;
        }
    }
}

fn broadcast_room_state(room: &Room) {
    let snapshot = room.snapshot();
    let message = ServerMessage::State {
        server_tick: snapshot.server_tick,
        players: snapshot.players,
        boxes: snapshot.boxes,
    };

    for sender in room.outbound_senders() {
        send_message(&sender, message.clone());
    }
}

fn send_message(sender: &OutboundSender, message: ServerMessage) {
    let _ = sender.send(message);
}
