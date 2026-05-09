use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Join,
    Ping {
        #[serde(rename = "clientTime")]
        client_time: f64,
    },
    Input {
        seq: u64,
        up: bool,
        down: bool,
        left: bool,
        right: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Welcome {
        #[serde(rename = "playerId")]
        player_id: u64,
        #[serde(rename = "serverTime")]
        server_time: f64,
    },
    Pong {
        #[serde(rename = "clientTime")]
        client_time: f64,
        #[serde(rename = "serverTime")]
        server_time: f64,
    },
    State {
        #[serde(rename = "serverTime")]
        server_time: f64,
        players: Vec<PlayerSnapshot>,
        boxes: Vec<BoxSnapshot>,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    #[serde(rename = "playerId")]
    pub player_id: u64,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxSnapshot {
    #[serde(rename = "boxId")]
    pub box_id: u64,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub qx: f32,
    pub qy: f32,
    pub qz: f32,
    pub qw: f32,
}
