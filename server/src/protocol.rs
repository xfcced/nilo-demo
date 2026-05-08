use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Join,
    Ping {
        #[serde(rename = "clientTime")]
        client_time: f64,
    },
}

#[derive(Debug, Serialize)]
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
    Error { message: String },
}
