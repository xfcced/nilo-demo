use super::protocol::{BoxSnapshot, PlayerSnapshot};
use super::world::World;
use crate::config::GameConfig;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct Room {
    state: Mutex<RoomState>,
    config: Arc<GameConfig>,
}

struct RoomState {
    players: HashMap<u64, Player>,
    world: World,
    server_tick: u64,
    restart_generation: u64,
}

#[derive(Debug)]
struct Player {
    input: PlayerInput,
    last_received_input_seq: u64,
    last_applied_input_seq: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
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
    pub last_processed_input_seq: u64,
}

impl Room {
    pub fn new(config: Arc<GameConfig>) -> Self {
        Self {
            state: Mutex::new(RoomState {
                players: HashMap::new(),
                world: World::new(Arc::clone(&config)),
                server_tick: 0,
                restart_generation: 0,
            }),
            config,
        }
    }

    pub fn add_player(&self, player_id: u64) {
        let player = Player {
            input: PlayerInput::default(),
            last_received_input_seq: 0,
            last_applied_input_seq: 0,
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

    pub fn restart(&self) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        let player_ids = state.players.keys().copied().collect::<Vec<_>>();

        state.world = World::new(Arc::clone(&self.config));
        state.server_tick = 0;
        state.restart_generation += 1;

        for player_id in player_ids {
            state.players.insert(
                player_id,
                Player {
                    input: PlayerInput::default(),
                    last_received_input_seq: 0,
                    last_applied_input_seq: 0,
                },
            );
            state.world.spawn_player(player_id);
        }
    }

    pub fn restart_generation(&self) -> u64 {
        self.state
            .lock()
            .expect("room state mutex poisoned")
            .restart_generation
    }

    pub fn update_input(&self, player_id: u64, seq: u64, input: PlayerInput) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        let Some(player) = state.players.get_mut(&player_id) else {
            return;
        };

        if seq <= player.last_received_input_seq {
            return;
        }

        player.last_received_input_seq = seq;
        player.input = input;
    }

    pub fn tick(&self, delta_seconds: f32) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        let inputs = state
            .players
            .iter()
            .map(|(&player_id, player)| (player_id, player.input, player.last_received_input_seq))
            .collect::<Vec<_>>();

        for (player_id, input, input_seq) in inputs {
            state
                .world
                .apply_player_input(player_id, input, delta_seconds);
            if let Some(player) = state.players.get_mut(&player_id) {
                player.last_applied_input_seq = input_seq;
            }
        }

        state.world.step(delta_seconds);
        state.server_tick += 1;
    }

    pub fn snapshot_for_player(&self, player_id: u64) -> RoomSnapshot {
        let state = self.state.lock().expect("room state mutex poisoned");
        RoomSnapshot {
            server_tick: state.server_tick,
            players: state.world.player_snapshots(),
            boxes: state.world.box_snapshots(),
            last_processed_input_seq: state
                .players
                .get(&player_id)
                .map_or(0, |player| player.last_applied_input_seq),
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
