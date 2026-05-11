use super::protocol::{ClientMessage, ServerMessage};
use super::room::{PlayerInput, Room};
use crate::game_net::host::{GameNetEvent, GameNetEventReceiver, GameNetworkHost};
use crate::net::ConnectionId;
use anyhow::Result;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{self, Instant};
use tracing::{error, info};
use wtransport::Identity;

const WEBTRANSPORT_PATH: &str = "/webtransport";
const TICK_RATE: f32 = 30.0;
const MAX_FRAME_TIME: Duration = Duration::from_millis(250);
const MAX_TICKS_PER_FRAME: usize = 8;

pub struct ServerHost {
    network: GameNetworkHost,
    room: Arc<Room>,
}

impl ServerHost {
    pub fn new(port: u16, identity: Identity, room: Arc<Room>) -> Result<Self> {
        let network = GameNetworkHost::new(port, identity, WEBTRANSPORT_PATH)?;
        Ok(Self { network, room })
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        self.network.local_addr()
    }

    pub async fn serve(self) -> Result<()> {
        let (event_sender, event_receiver) = GameNetworkHost::event_queue();

        let tick_room = Arc::clone(&self.room);
        let tick_network = self.network.clone();
        tokio::spawn(async move {
            run_room_tick(tick_room, tick_network).await;
        });

        let event_room = Arc::clone(&self.room);
        let event_network = self.network.clone();
        tokio::spawn(async move {
            handle_net_events(event_receiver, event_room, event_network).await;
        });

        self.network.serve(event_sender).await
    }
}

async fn handle_net_events(
    mut event_receiver: GameNetEventReceiver,
    room: Arc<Room>,
    network: GameNetworkHost,
) {
    let mut joined_connections = HashSet::new();

    while let Some(event) = event_receiver.recv().await {
        match event {
            GameNetEvent::Message {
                connection_id,
                message,
            } => {
                handle_client_message(
                    connection_id,
                    message,
                    &room,
                    &network,
                    &mut joined_connections,
                );
            }
            GameNetEvent::Disconnected { connection_id } => {
                joined_connections.remove(&connection_id);
                room.remove_player(connection_id.0);
                info!(player_id = connection_id.0, "removed player");
            }
        }
    }
}

fn handle_client_message(
    connection_id: ConnectionId,
    message: ClientMessage,
    room: &Room,
    network: &GameNetworkHost,
    joined_connections: &mut HashSet<ConnectionId>,
) {
    let player_id = connection_id.0;

    match message {
        ClientMessage::Join => {
            joined_connections.insert(connection_id);
            room.add_player(player_id);
            info!(player_id, "assigned player id");
            send_message(network, connection_id, ServerMessage::Welcome { player_id });
        }
        ClientMessage::Ping { ping_seq } => {
            if !joined_connections.contains(&connection_id) {
                send_message(
                    network,
                    connection_id,
                    ServerMessage::Error {
                        message: "send Join before Ping".to_string(),
                    },
                );
                return;
            }

            send_message(network, connection_id, ServerMessage::Pong { ping_seq });
        }
        ClientMessage::Input {
            seq,
            up,
            down,
            left,
            right,
        } => {
            if !joined_connections.contains(&connection_id) {
                send_message(
                    network,
                    connection_id,
                    ServerMessage::Error {
                        message: "send Join before Input".to_string(),
                    },
                );
                return;
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

async fn run_room_tick(room: Arc<Room>, network: GameNetworkHost) {
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
            broadcast_room_state(&room, &network);

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

fn broadcast_room_state(room: &Room, network: &GameNetworkHost) {
    let snapshot = room.snapshot();
    let message = ServerMessage::State {
        server_tick: snapshot.server_tick,
        players: snapshot.players,
        boxes: snapshot.boxes,
    };

    for player_id in room.player_ids() {
        send_message(network, ConnectionId(player_id), message.clone());
    }
}

fn send_message(network: &GameNetworkHost, connection_id: ConnectionId, message: ServerMessage) {
    if let Err(error) = network.send_message(connection_id, message) {
        error!(
            connection_id = connection_id.0,
            ?error,
            "failed to send server message"
        );
    }
}
