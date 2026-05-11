use super::protocol::{BoxSnapshot, ClientMessage, ServerMessage};
use super::room::{PlayerInput, Room};
use crate::game_net::host::{GameNetEvent, GameNetEventReceiver, GameNetworkHost};
use crate::net::ConnectionId;
use anyhow::Result;
use std::collections::{HashMap, HashSet};
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
            run_room_tick(tick_room, tick_network, StateDeltaTracker::new()).await;
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

async fn run_room_tick(
    room: Arc<Room>,
    network: GameNetworkHost,
    mut delta_tracker: StateDeltaTracker,
) {
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
            broadcast_room_state(&room, &network, &mut delta_tracker);

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

fn broadcast_room_state(
    room: &Room,
    network: &GameNetworkHost,
    delta_tracker: &mut StateDeltaTracker,
) {
    let mut snapshot = room.snapshot();
    let all_boxes = snapshot.boxes;
    let changed_boxes = delta_tracker.changed_boxes(&all_boxes);

    for player_id in room.player_ids() {
        let connection_id = ConnectionId(player_id);
        snapshot.boxes =
            delta_tracker.boxes_for_connection(connection_id, &all_boxes, &changed_boxes);
        if let Err(error) = network.send_state(connection_id, &snapshot) {
            error!(
                connection_id = player_id,
                ?error,
                "failed to send state datagram"
            );
        }
    }
}

struct StateDeltaTracker {
    previous_boxes: HashMap<u64, BoxSnapshot>,
    initialized_connections: HashSet<ConnectionId>,
}

impl StateDeltaTracker {
    fn new() -> Self {
        Self {
            previous_boxes: HashMap::new(),
            initialized_connections: HashSet::new(),
        }
    }

    fn changed_boxes(&mut self, boxes: &[BoxSnapshot]) -> Vec<BoxSnapshot> {
        let mut changed_boxes = Vec::with_capacity(boxes.len());

        for box_snapshot in boxes {
            let changed = self
                .previous_boxes
                .get(&box_snapshot.box_id)
                .is_none_or(|previous| box_changed(previous, &box_snapshot));
            self.previous_boxes
                .insert(box_snapshot.box_id, box_snapshot.clone());

            if changed {
                changed_boxes.push(box_snapshot.clone());
            }
        }

        changed_boxes
    }

    fn boxes_for_connection(
        &mut self,
        connection_id: ConnectionId,
        all_boxes: &[BoxSnapshot],
        changed_boxes: &[BoxSnapshot],
    ) -> Vec<BoxSnapshot> {
        if self.initialized_connections.insert(connection_id) {
            all_boxes.to_vec()
        } else {
            changed_boxes.to_vec()
        }
    }
}

fn box_changed(previous: &BoxSnapshot, current: &BoxSnapshot) -> bool {
    quantized_position_changed(previous.x, current.x)
        || quantized_position_changed(previous.y, current.y)
        || quantized_position_changed(previous.z, current.z)
        || quantized_quaternion_changed(previous.qx, current.qx)
        || quantized_quaternion_changed(previous.qy, current.qy)
        || quantized_quaternion_changed(previous.qz, current.qz)
        || quantized_quaternion_changed(previous.qw, current.qw)
}

fn quantized_position_changed(previous: f32, current: f32) -> bool {
    (previous * 100.0).round() as i16 != (current * 100.0).round() as i16
}

fn quantized_quaternion_changed(previous: f32, current: f32) -> bool {
    (previous * 32767.0).round() as i16 != (current * 32767.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_snapshot(box_id: u64, x: f32) -> BoxSnapshot {
        BoxSnapshot {
            box_id,
            x,
            y: 0.45,
            z: 1.0,
            qx: 0.0,
            qy: 0.0,
            qz: 0.0,
            qw: 1.0,
        }
    }

    #[test]
    fn delta_tracker_omits_unchanged_boxes() {
        let mut tracker = StateDeltaTracker::new();
        let boxes = vec![box_snapshot(1, 1.0), box_snapshot(2, 2.0)];

        let changed = tracker.changed_boxes(&boxes);
        assert_eq!(changed.len(), 2);

        let boxes = vec![box_snapshot(1, 1.0), box_snapshot(2, 2.0)];
        let changed = tracker.changed_boxes(&boxes);
        assert!(changed.is_empty());

        let boxes = vec![box_snapshot(1, 1.02), box_snapshot(2, 2.0)];
        let changed = tracker.changed_boxes(&boxes);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].box_id, 1);
    }

    #[test]
    fn delta_tracker_sends_full_boxes_to_new_connections() {
        let mut tracker = StateDeltaTracker::new();
        let all_boxes = vec![box_snapshot(1, 1.0), box_snapshot(2, 2.0)];
        let changed_boxes = Vec::new();

        let first = tracker.boxes_for_connection(ConnectionId(1), &all_boxes, &changed_boxes);
        assert_eq!(first.len(), 2);

        let second = tracker.boxes_for_connection(ConnectionId(1), &all_boxes, &changed_boxes);
        assert!(second.is_empty());

        let new_connection =
            tracker.boxes_for_connection(ConnectionId(2), &all_boxes, &changed_boxes);
        assert_eq!(new_connection.len(), 2);
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
