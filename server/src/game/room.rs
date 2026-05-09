use super::protocol::{PlayerSnapshot, ServerMessage};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::mpsc;

const ARENA_LIMIT: f32 = 5.2;
const PLAYER_SPEED: f32 = 3.0;

pub type OutboundSender = mpsc::UnboundedSender<ServerMessage>;

#[derive(Debug, Default)]
pub struct Room {
    next_player_id: AtomicU64,
    players: Mutex<HashMap<u64, Player>>,
}

#[derive(Debug)]
struct Player {
    x: f32,
    z: f32,
    input: PlayerInput,
    last_input_seq: u64,
    sender: OutboundSender,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlayerInput {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
}

impl Room {
    pub fn new() -> Self {
        Self {
            next_player_id: AtomicU64::new(1),
            players: Mutex::new(HashMap::new()),
        }
    }

    pub fn add_player(&self, sender: OutboundSender) -> u64 {
        let player_id = self.next_player_id.fetch_add(1, Ordering::Relaxed);
        let spawn_index = (player_id - 1) as f32;
        let x = ((spawn_index % 5.0) - 2.0) * 1.2;
        let z = -3.2 + (spawn_index / 5.0).floor() * 1.2;

        let player = Player {
            x,
            z: z.clamp(-ARENA_LIMIT, ARENA_LIMIT),
            input: PlayerInput::default(),
            last_input_seq: 0,
            sender,
        };

        self.players
            .lock()
            .expect("room players mutex poisoned")
            .insert(player_id, player);

        player_id
    }

    pub fn remove_player(&self, player_id: u64) {
        self.players
            .lock()
            .expect("room players mutex poisoned")
            .remove(&player_id);
    }

    pub fn update_input(&self, player_id: u64, seq: u64, input: PlayerInput) {
        let mut players = self.players.lock().expect("room players mutex poisoned");
        let Some(player) = players.get_mut(&player_id) else {
            return;
        };

        if seq <= player.last_input_seq {
            return;
        }

        player.last_input_seq = seq;
        player.input = input;
    }

    pub fn tick(&self, delta_seconds: f32) {
        let mut players = self.players.lock().expect("room players mutex poisoned");

        for player in players.values_mut() {
            let mut dx: f32 = 0.0;
            let mut dz: f32 = 0.0;

            if player.input.left {
                dx -= 1.0;
            }
            if player.input.right {
                dx += 1.0;
            }
            if player.input.up {
                dz -= 1.0;
            }
            if player.input.down {
                dz += 1.0;
            }

            let length = (dx * dx + dz * dz).sqrt();
            if length > 0.0 {
                dx /= length;
                dz /= length;
            }

            player.x =
                (player.x + dx * PLAYER_SPEED * delta_seconds).clamp(-ARENA_LIMIT, ARENA_LIMIT);
            player.z =
                (player.z + dz * PLAYER_SPEED * delta_seconds).clamp(-ARENA_LIMIT, ARENA_LIMIT);
        }
    }

    pub fn player_snapshots(&self) -> Vec<PlayerSnapshot> {
        self.players
            .lock()
            .expect("room players mutex poisoned")
            .iter()
            .map(|(&player_id, player)| PlayerSnapshot {
                player_id,
                x: player.x,
                z: player.z,
            })
            .collect()
    }

    pub fn outbound_senders(&self) -> Vec<OutboundSender> {
        self.players
            .lock()
            .expect("room players mutex poisoned")
            .values()
            .map(|player| player.sender.clone())
            .collect()
    }
}
