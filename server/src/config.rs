#![allow(dead_code)]

use anyhow::{Context, Result};
use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_CONFIG_FILE: &str = "config/game.json";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameConfig {
    pub network: NetworkConfig,
    pub simulation: SimulationConfig,
    pub arena: ArenaConfig,
    pub player: PlayerConfig,
    pub boxes: BoxesConfig,
    pub interpolation: InterpolationConfig,
    pub protocol: ProtocolConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub web_transport_path: String,
    pub default_port: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationConfig {
    pub tick_rate: f32,
    pub max_frame_ms: u64,
    pub max_ticks_per_frame: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaConfig {
    pub half_size: f32,
    pub wall_height: f32,
    pub wall_thickness: f32,
    pub floor_thickness: f32,
    pub goal_zone: GoalZoneConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GoalZoneConfig {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub radius: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerConfig {
    pub radius: f32,
    pub center_y: f32,
    pub move_torque: f32,
    pub spin_brake_torque: f32,
    pub slip_brake_speed: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxesConfig {
    pub half_extent: f32,
    pub density: f32,
    pub grid_columns: u32,
    pub grid_rows: u32,
    pub spacing: f32,
    pub center_z: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpolationConfig {
    pub delay_ticks: f32,
    pub entity_expire_ticks: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolConfig {
    pub position_scale: f32,
    pub quaternion_scale: f32,
}

pub fn load_game_config() -> Result<GameConfig> {
    let path = match env::var("GAME_CONFIG_FILE") {
        Ok(path) => PathBuf::from(path),
        Err(_) => default_config_path(),
    };

    let contents = fs::read_to_string(&path)
        .with_context(|| format!("failed to read game config: {}", path.display()))?;
    serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse game config: {}", path.display()))
}

fn default_config_path() -> PathBuf {
    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for candidate in [
        current_dir.join(DEFAULT_CONFIG_FILE),
        current_dir.join("..").join(DEFAULT_CONFIG_FILE),
    ] {
        if Path::new(&candidate).exists() {
            return candidate;
        }
    }

    PathBuf::from(DEFAULT_CONFIG_FILE)
}
