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
    inputs_by_tick: HashMap<u64, PlayerInput>,
    last_input: PlayerInput,
    last_received_input_tick: u64,
    last_processed_input_tick: u64,
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
    pub last_processed_input_tick: u64,
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
            inputs_by_tick: HashMap::new(),
            last_input: PlayerInput::default(),
            last_received_input_tick: 0,
            last_processed_input_tick: 0,
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

    pub fn restart(&self, active_player_ids: &[u64]) {
        let mut state = self.state.lock().expect("room state mutex poisoned");

        state.world = World::new(Arc::clone(&self.config));
        state.players.clear();
        state.server_tick = 0;
        state.restart_generation += 1;

        for &player_id in active_player_ids {
            state.players.insert(
                player_id,
                Player {
                    inputs_by_tick: HashMap::new(),
                    last_input: PlayerInput::default(),
                    last_received_input_tick: 0,
                    last_processed_input_tick: 0,
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

    pub fn update_input(&self, player_id: u64, tick: u64, input: PlayerInput) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        if tick <= state.server_tick {
            return;
        }

        let Some(player) = state.players.get_mut(&player_id) else {
            return;
        };

        player.last_received_input_tick = player.last_received_input_tick.max(tick);
        player.inputs_by_tick.insert(tick, input);
    }

    pub fn tick(&self, delta_seconds: f32) {
        let mut state = self.state.lock().expect("room state mutex poisoned");
        let simulation_tick = state.server_tick + 1;
        let inputs = state
            .players
            .iter_mut()
            .map(|(&player_id, player)| {
                if let Some(input) = player.inputs_by_tick.remove(&simulation_tick) {
                    player.last_input = input;
                }
                player.last_processed_input_tick = simulation_tick;
                (player_id, player.last_input)
            })
            .collect::<Vec<_>>();

        for (player_id, input) in inputs {
            state
                .world
                .apply_player_input(player_id, input, delta_seconds);
        }

        state.world.step(delta_seconds);
        state.server_tick = simulation_tick;
    }

    pub fn snapshot_for_player(&self, player_id: u64) -> RoomSnapshot {
        let state = self.state.lock().expect("room state mutex poisoned");
        RoomSnapshot {
            server_tick: state.server_tick,
            players: state.world.player_snapshots(),
            boxes: state.world.box_snapshots(),
            last_processed_input_tick: state
                .players
                .get(&player_id)
                .map_or(0, |player| player.last_processed_input_tick),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_game_config;

    fn test_config() -> Arc<GameConfig> {
        Arc::new(load_game_config().unwrap())
    }

    fn player_snapshot(room: &Room) -> PlayerSnapshot {
        room.snapshot_for_player(1)
            .players
            .into_iter()
            .find(|player| player.player_id == 1)
            .unwrap()
    }

    #[test]
    fn tick_uses_input_for_matching_tick() {
        let room = Room::new(test_config());
        room.add_player(1);

        room.update_input(
            1,
            2,
            PlayerInput {
                right: true,
                ..PlayerInput::default()
            },
        );
        room.update_input(
            1,
            1,
            PlayerInput {
                up: true,
                ..PlayerInput::default()
            },
        );

        room.tick(1.0 / 30.0);
        let tick_one = player_snapshot(&room);
        assert!(tick_one.vz < 0.0);
        assert_eq!(room.snapshot_for_player(1).last_processed_input_tick, 1);

        room.tick(1.0 / 30.0);
        let tick_two = player_snapshot(&room);
        assert!(tick_two.vx > 0.0);
        assert_eq!(room.snapshot_for_player(1).last_processed_input_tick, 2);
    }

    #[test]
    fn missing_tick_reuses_last_input() {
        let room = Room::new(test_config());
        room.add_player(1);
        room.update_input(
            1,
            1,
            PlayerInput {
                up: true,
                ..PlayerInput::default()
            },
        );

        room.tick(1.0 / 30.0);
        let tick_one = player_snapshot(&room);
        room.tick(1.0 / 30.0);
        let tick_two = player_snapshot(&room);

        assert!(tick_two.z < tick_one.z);
        assert_eq!(room.snapshot_for_player(1).last_processed_input_tick, 2);
    }
}
