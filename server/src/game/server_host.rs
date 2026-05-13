use super::protocol::{BoxSnapshot, ClientMessage, ServerMessage};
use super::room::{PlayerInput, Room};
use crate::config::GameConfig;
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

pub struct ServerHost {
    network: GameNetworkHost,
    room: Arc<Room>,
    config: Arc<GameConfig>,
}

impl ServerHost {
    pub fn new(
        port: u16,
        identity: Identity,
        room: Arc<Room>,
        config: Arc<GameConfig>,
    ) -> Result<Self> {
        let network = GameNetworkHost::new(
            port,
            identity,
            &config.network.web_transport_path,
            Arc::new(config.protocol.clone()),
        )?;
        Ok(Self {
            network,
            room,
            config,
        })
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        self.network.local_addr()
    }

    pub async fn serve(self) -> Result<()> {
        let (event_sender, event_receiver) = GameNetworkHost::event_queue();

        let tick_room = Arc::clone(&self.room);
        let tick_network = self.network.clone();
        let tick_config = Arc::clone(&self.config);
        tokio::spawn(async move {
            run_room_tick(
                tick_room,
                tick_network,
                StateDeltaTracker::new(Arc::clone(&tick_config)),
                tick_config,
            )
            .await;
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
        ClientMessage::Restart => {
            if !joined_connections.contains(&connection_id) {
                send_message(
                    network,
                    connection_id,
                    ServerMessage::Error {
                        message: "send Join before Restart".to_string(),
                    },
                );
                return;
            }

            let active_player_ids = joined_connections
                .iter()
                .map(|connection_id| connection_id.0)
                .collect::<Vec<_>>();
            room.restart(&active_player_ids);
            for joined_connection_id in joined_connections.iter().copied() {
                send_message(network, joined_connection_id, ServerMessage::Restarted);
            }
            info!(player_id, "restarted game");
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
            tick,
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
                tick,
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
    config: Arc<GameConfig>,
) {
    let tick_duration = Duration::from_secs_f32(1.0 / config.simulation.tick_rate);
    let max_frame_time = Duration::from_millis(config.simulation.max_frame_ms);
    let mut previous_time = Instant::now();
    let mut accumulator = Duration::ZERO;

    loop {
        let now = Instant::now();
        let frame_time = now.duration_since(previous_time).min(max_frame_time);
        previous_time = now;
        accumulator += frame_time;

        let mut ticks_this_frame = 0;
        while accumulator >= tick_duration
            && ticks_this_frame < config.simulation.max_ticks_per_frame
        {
            room.tick(1.0 / config.simulation.tick_rate);
            broadcast_room_state(&room, &network, &mut delta_tracker);

            accumulator -= tick_duration;
            ticks_this_frame += 1;
        }

        if ticks_this_frame == config.simulation.max_ticks_per_frame {
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
    delta_tracker.sync_restart_generation(room.restart_generation());

    let all_boxes = room.snapshot_for_player(0).boxes;
    let changed_boxes = delta_tracker.changed_boxes(&all_boxes);

    for player_id in room.player_ids() {
        let connection_id = ConnectionId(player_id);
        let mut snapshot = room.snapshot_for_player(player_id);
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
    restart_generation: u64,
    config: Arc<GameConfig>,
}

impl StateDeltaTracker {
    fn new(config: Arc<GameConfig>) -> Self {
        Self {
            previous_boxes: HashMap::new(),
            initialized_connections: HashSet::new(),
            restart_generation: 0,
            config,
        }
    }

    fn sync_restart_generation(&mut self, restart_generation: u64) {
        if self.restart_generation == restart_generation {
            return;
        }

        self.restart_generation = restart_generation;
        self.previous_boxes.clear();
        self.initialized_connections.clear();
    }

    fn changed_boxes(&mut self, boxes: &[BoxSnapshot]) -> Vec<BoxSnapshot> {
        let mut changed_boxes = Vec::with_capacity(boxes.len());

        for box_snapshot in boxes {
            let changed = self
                .previous_boxes
                .get(&box_snapshot.box_id)
                .is_none_or(|previous| self.box_changed(previous, &box_snapshot));
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

    fn box_changed(&self, previous: &BoxSnapshot, current: &BoxSnapshot) -> bool {
        let position_scale = self.config.protocol.position_scale;
        let quaternion_scale = self.config.protocol.quaternion_scale;
        quantized_changed(previous.x, current.x, position_scale)
            || quantized_changed(previous.y, current.y, position_scale)
            || quantized_changed(previous.z, current.z, position_scale)
            || quantized_changed(previous.qx, current.qx, quaternion_scale)
            || quantized_changed(previous.qy, current.qy, quaternion_scale)
            || quantized_changed(previous.qz, current.qz, quaternion_scale)
            || quantized_changed(previous.qw, current.qw, quaternion_scale)
    }
}

fn quantized_changed(previous: f32, current: f32, scale: f32) -> bool {
    (previous * scale).round() as i16 != (current * scale).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_game_config;

    fn test_config() -> Arc<GameConfig> {
        Arc::new(load_game_config().unwrap())
    }

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
        let mut tracker = StateDeltaTracker::new(test_config());
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
        let mut tracker = StateDeltaTracker::new(test_config());
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
