#[derive(Debug, PartialEq)]
pub enum ClientMessage {
    Join,
    Restart,
    Ping {
        ping_seq: u64,
    },
    Input {
        input_seq: u64,
        up: bool,
        down: bool,
        left: bool,
        right: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerMessage {
    Welcome { player_id: u64 },
    Restarted,
    Pong { ping_seq: u64 },
    Error { message: String },
}

#[derive(Clone, Debug)]
pub struct PlayerSnapshot {
    pub player_id: u64,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
}

#[derive(Clone, Debug)]
pub struct BoxSnapshot {
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
