use super::protocol::{BoxSnapshot, PlayerSnapshot, ServerMessage};
use super::world::World;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::mpsc;

pub type OutboundSender = mpsc::UnboundedSender<ServerMessage>;

#[derive(Default)]
pub struct Room {
    next_player_id: AtomicU64,
    state: Mutex<RoomState>,
}

#[derive(Default)]
struct RoomState {
    players: HashMap<u64, Player>,
    world: World,
}

#[derive(Debug)]
struct Player {
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
            state: Mutex::new(RoomState::default()),
        }
    }

    pub fn add_player(&self, sender: OutboundSender) -> u64 {
        let player_id = self.next_player_id.fetch_add(1, Ordering::Relaxed);

        let player = Player {
            input: PlayerInput::default(),
            last_input_seq: 0,
            sender,
        };

        let mut state = self.state.lock().expect("room state mutex poisoned");
        state.players.insert(player_id, player);
        state.world.spawn_player(player_id);

        player_id
    }

    pub fn remove_player(&self, player_id: u64) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        state.players.remove(&player_id);
        state.world.despawn_player(player_id);
    }

    pub fn update_input(&self, player_id: u64, seq: u64, input: PlayerInput) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        let Some(player) = state.players.get_mut(&player_id) else {
            return;
        };

        if seq <= player.last_input_seq {
            return;
        }

        player.last_input_seq = seq;
        player.input = input;
    }

    pub fn tick(&self, delta_seconds: f32) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        let inputs = state
            .players
            .iter()
            .map(|(&player_id, player)| (player_id, player.input))
            .collect::<Vec<_>>();

        for (player_id, input) in inputs {
            state
                .world
                .apply_player_input(player_id, input, delta_seconds);
        }

        state.world.step(delta_seconds);
    }

    pub fn player_snapshots(&self) -> Vec<PlayerSnapshot> {
        self.state
            .lock()
            .expect("room state mutex poisoned")
            .world
            .player_snapshots()
    }

    pub fn box_snapshots(&self) -> Vec<BoxSnapshot> {
        self.state
            .lock()
            .expect("room state mutex poisoned")
            .world
            .box_snapshots()
    }

    pub fn outbound_senders(&self) -> Vec<OutboundSender> {
        self.state
            .lock()
            .expect("room state mutex poisoned")
            .players
            .values()
            .map(|player| player.sender.clone())
            .collect()
    }
}
