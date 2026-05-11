use super::protocol::{BoxSnapshot, PlayerSnapshot};
use super::world::World;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct Room {
    state: Mutex<RoomState>,
}

#[derive(Default)]
struct RoomState {
    players: HashMap<u64, Player>,
    world: World,
    server_tick: u64,
}

#[derive(Debug)]
struct Player {
    input: PlayerInput,
    last_input_seq: u64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlayerInput {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
}

pub struct RoomSnapshot {
    pub server_tick: u64,
    pub players: Vec<PlayerSnapshot>,
    pub boxes: Vec<BoxSnapshot>,
}

impl Room {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RoomState::default()),
        }
    }

    pub fn add_player(&self, player_id: u64) {
        let player = Player {
            input: PlayerInput::default(),
            last_input_seq: 0,
        };

        let mut state = self.state.lock().expect("room state mutex poisoned");
        state.players.insert(player_id, player);
        state.world.spawn_player(player_id);
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
        state.server_tick += 1;
    }

    pub fn snapshot(&self) -> RoomSnapshot {
        let state = self.state.lock().expect("room state mutex poisoned");
        RoomSnapshot {
            server_tick: state.server_tick,
            players: state.world.player_snapshots(),
            boxes: state.world.box_snapshots(),
        }
    }

    pub fn player_ids(&self) -> Vec<u64> {
        self.state
            .lock()
            .expect("room state mutex poisoned")
            .players
            .keys()
            .copied()
            .collect()
    }
}
