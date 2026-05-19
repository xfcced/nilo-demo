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
    pub slope: SlopeConfig,
    pub player: PlayerConfig,
    pub boxes: BoxesConfig,
    pub camera: CameraConfig,
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlopeConfig {
    pub center_x: f32,
    pub center_y: f32,
    pub center_z: f32,
    pub half_x: f32,
    pub half_y: f32,
    pub half_z: f32,
    pub rotation_x: f32,
    pub rotation_y: f32,
    pub rotation_z: f32,
    #[serde(default = "default_slope_friction")]
    pub friction: f32,
    pub side_wall_height: f32,
    pub side_wall_thickness: f32,
    pub recycle_z: f32,
    pub launch_local_z_inset: f32,
}

fn default_slope_friction() -> f32 {
    1.0
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerConfig {
    pub radius: f32,
    pub spawn_x: f32,
    pub spawn_y: f32,
    pub spawn_z: f32,
    pub spawn_spread_x: f32,
    pub max_speed: f32,
    pub acceleration: f32,
    pub deceleration: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxesConfig {
    pub count: u32,
    pub half_extent: f32,
    pub density: f32,
    pub friction: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub launch_impulse: f32,
    pub launch_min_speed: f32,
    pub rotation_max_angle: f32,
    pub surface_clearance: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraConfig {
    pub look_at_x: f32,
    pub look_at_y: f32,
    pub look_at_z: f32,
    pub distance: f32,
    pub elevation_degrees: f32,
    /// Yaw left from straight-on view toward +Z (degrees).
    pub yaw_degrees: f32,
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
