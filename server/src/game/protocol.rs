use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Join,
    Restart,
    Ping {
        #[serde(rename = "pingSeq")]
        ping_seq: u64,
    },
    Input {
        #[serde(rename = "inputSeq")]
        input_seq: u64,
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
    },
    Restarted,
    Pong {
        #[serde(rename = "pingSeq")]
        ping_seq: u64,
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
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
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
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub wx: f32,
    pub wy: f32,
    pub wz: f32,
}
