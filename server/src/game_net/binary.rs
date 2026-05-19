use crate::game::protocol::{BoxSnapshot, ClientMessage, PlayerSnapshot, ServerMessage};
use crate::game::room::PlayerInput;
use anyhow::{bail, ensure, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::warn;

const TYPE_INPUT: u8 = 1;
const TYPE_STATE: u8 = 2;
const TYPE_JOIN: u8 = 3;
const TYPE_RESTART: u8 = 4;
const TYPE_PING: u8 = 5;
const TYPE_WELCOME: u8 = 6;
const TYPE_RESTARTED: u8 = 7;
const TYPE_PONG: u8 = 8;
const TYPE_ERROR: u8 = 9;
const INPUT_BYTES: usize = 6;
const STATE_HEADER_BYTES: usize = 11;
const PLAYER_BYTES: usize = 13;
const BOX_BYTES: usize = 26;
const SMALLEST_THREE_RANGE: f32 = std::f32::consts::FRAC_1_SQRT_2;
static POSITION_CLAMP_LOGGED: AtomicBool = AtomicBool::new(false);
static QUATERNION_CLAMP_LOGGED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinaryInput {
    pub input_seq: u32,
    pub input: PlayerInput,
}

#[derive(Clone, Debug)]
pub struct BinaryState<'a> {
    pub server_tick: u64,
    pub last_received_input_seq: u64,
    pub players: &'a [PlayerSnapshot],
    pub boxes: &'a [BoxSnapshot],
    pub position_scale: f32,
    pub quaternion_scale: f32,
}

pub fn decode_input(payload: &[u8]) -> Result<BinaryInput> {
    ensure!(
        payload.len() == INPUT_BYTES,
        "invalid input datagram size: {}",
        payload.len()
    );
    ensure!(
        payload[0] == TYPE_INPUT,
        "unexpected datagram type: {}",
        payload[0]
    );

    Ok(BinaryInput {
        input_seq: u32::from_be_bytes(payload[1..5].try_into()?),
        input: decode_buttons(payload[5]),
    })
}

pub fn decode_client_message(payload: &[u8]) -> Result<ClientMessage> {
    ensure!(!payload.is_empty(), "invalid reliable message size: 0");

    match payload[0] {
        TYPE_JOIN => {
            ensure!(
                payload.len() == 1,
                "invalid join message size: {}",
                payload.len()
            );
            Ok(ClientMessage::Join)
        }
        TYPE_RESTART => {
            ensure!(
                payload.len() == 1,
                "invalid restart message size: {}",
                payload.len()
            );
            Ok(ClientMessage::Restart)
        }
        TYPE_PING => {
            ensure!(
                payload.len() == 5,
                "invalid ping message size: {}",
                payload.len()
            );
            Ok(ClientMessage::Ping {
                ping_seq: u32::from_be_bytes(payload[1..5].try_into()?) as u64,
            })
        }
        message_type => bail!("unexpected reliable message type: {message_type}"),
    }
}

pub fn encode_server_message(message: &ServerMessage) -> Result<Vec<u8>> {
    match message {
        ServerMessage::Welcome { player_id } => {
            let mut payload = Vec::with_capacity(2);
            payload.push(TYPE_WELCOME);
            write_u8(&mut payload, *player_id, "player id")?;
            Ok(payload)
        }
        ServerMessage::Restarted => Ok(vec![TYPE_RESTARTED]),
        ServerMessage::Pong { ping_seq } => {
            ensure!(
                *ping_seq <= u32::MAX as u64,
                "ping seq exceeds binary protocol range: {}",
                ping_seq
            );
            let mut payload = Vec::with_capacity(5);
            payload.push(TYPE_PONG);
            payload.extend_from_slice(&(*ping_seq as u32).to_be_bytes());
            Ok(payload)
        }
        ServerMessage::Error { message } => {
            let bytes = message.as_bytes();
            ensure!(
                bytes.len() <= u16::MAX as usize,
                "error message exceeds binary protocol range: {}",
                bytes.len()
            );
            let mut payload = Vec::with_capacity(3 + bytes.len());
            payload.push(TYPE_ERROR);
            payload.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
            payload.extend_from_slice(bytes);
            Ok(payload)
        }
    }
}

#[cfg(test)]
fn decode_server_message(payload: &[u8]) -> Result<ServerMessage> {
    ensure!(!payload.is_empty(), "invalid reliable message size: 0");

    match payload[0] {
        TYPE_WELCOME => {
            ensure!(
                payload.len() == 2,
                "invalid welcome message size: {}",
                payload.len()
            );
            Ok(ServerMessage::Welcome {
                player_id: payload[1] as u64,
            })
        }
        TYPE_RESTARTED => {
            ensure!(
                payload.len() == 1,
                "invalid restarted message size: {}",
                payload.len()
            );
            Ok(ServerMessage::Restarted)
        }
        TYPE_PONG => {
            ensure!(
                payload.len() == 5,
                "invalid pong message size: {}",
                payload.len()
            );
            Ok(ServerMessage::Pong {
                ping_seq: u32::from_be_bytes(payload[1..5].try_into()?) as u64,
            })
        }
        TYPE_ERROR => {
            ensure!(
                payload.len() >= 3,
                "invalid error message size: {}",
                payload.len()
            );
            let length = u16::from_be_bytes(payload[1..3].try_into()?) as usize;
            ensure!(
                payload.len() == 3 + length,
                "invalid error message size: {}, expected {}",
                payload.len(),
                3 + length
            );
            Ok(ServerMessage::Error {
                message: String::from_utf8(payload[3..].to_vec())?,
            })
        }
        message_type => bail!("unexpected reliable message type: {message_type}"),
    }
}

pub fn encode_state(state: BinaryState<'_>) -> Result<Vec<u8>> {
    ensure!(
        state.server_tick <= u32::MAX as u64,
        "server tick exceeds binary protocol range: {}",
        state.server_tick
    );
    ensure!(
        state.last_received_input_seq <= u32::MAX as u64,
        "last received input seq exceeds binary protocol range: {}",
        state.last_received_input_seq
    );
    ensure!(
        state.players.len() <= u8::MAX as usize,
        "player count exceeds binary protocol range: {}",
        state.players.len()
    );
    ensure!(
        state.boxes.len() <= u8::MAX as usize,
        "box count exceeds binary protocol range: {}",
        state.boxes.len()
    );

    let mut payload = Vec::with_capacity(
        STATE_HEADER_BYTES + state.players.len() * PLAYER_BYTES + state.boxes.len() * BOX_BYTES,
    );
    payload.push(TYPE_STATE);
    payload.extend_from_slice(&(state.server_tick as u32).to_be_bytes());
    payload.extend_from_slice(&(state.last_received_input_seq as u32).to_be_bytes());
    payload.push(state.players.len() as u8);
    payload.push(state.boxes.len() as u8);

    for player in state.players {
        write_u8(&mut payload, player.player_id, "player id")?;
        write_position(&mut payload, player.x, state.position_scale);
        write_position(&mut payload, player.y, state.position_scale);
        write_position(&mut payload, player.z, state.position_scale);
        write_position(&mut payload, player.vx, state.position_scale);
        write_position(&mut payload, player.vy, state.position_scale);
        write_position(&mut payload, player.vz, state.position_scale);
    }

    for box_snapshot in state.boxes {
        write_u8(&mut payload, box_snapshot.box_id, "box id")?;
        write_position(&mut payload, box_snapshot.x, state.position_scale);
        write_position(&mut payload, box_snapshot.y, state.position_scale);
        write_position(&mut payload, box_snapshot.z, state.position_scale);
        write_smallest_three_quaternion(
            &mut payload,
            [
                box_snapshot.qx,
                box_snapshot.qy,
                box_snapshot.qz,
                box_snapshot.qw,
            ],
            state.quaternion_scale,
        );
        write_position(&mut payload, box_snapshot.vx, state.position_scale);
        write_position(&mut payload, box_snapshot.vy, state.position_scale);
        write_position(&mut payload, box_snapshot.vz, state.position_scale);
        write_position(&mut payload, box_snapshot.wx, state.position_scale);
        write_position(&mut payload, box_snapshot.wy, state.position_scale);
        write_position(&mut payload, box_snapshot.wz, state.position_scale);
    }

    Ok(payload)
}

fn decode_buttons(buttons: u8) -> PlayerInput {
    PlayerInput {
        up: buttons & (1 << 0) != 0,
        down: buttons & (1 << 1) != 0,
        left: buttons & (1 << 2) != 0,
        right: buttons & (1 << 3) != 0,
    }
}

fn write_u8(payload: &mut Vec<u8>, value: u64, label: &str) -> Result<()> {
    if value > u8::MAX as u64 {
        bail!("{label} exceeds binary protocol range: {value}");
    }
    payload.push(value as u8);
    Ok(())
}

fn write_position(payload: &mut Vec<u8>, meters: f32, scale: f32) {
    payload.extend_from_slice(
        &quantize_i16(meters, scale, &POSITION_CLAMP_LOGGED, "position").to_be_bytes(),
    );
}

fn write_smallest_three_quaternion(payload: &mut Vec<u8>, quaternion: [f32; 4], scale: f32) {
    let mut largest_index = 0;
    let mut largest_abs = quaternion[0].abs();
    for (index, component) in quaternion.iter().enumerate().skip(1) {
        if component.abs() > largest_abs {
            largest_index = index;
            largest_abs = component.abs();
        }
    }

    let sign = if quaternion[largest_index] < 0.0 {
        -1.0
    } else {
        1.0
    };
    payload.push(largest_index as u8);
    for (index, component) in quaternion.iter().enumerate() {
        if index == largest_index {
            continue;
        }
        let scaled = (*component * sign) / SMALLEST_THREE_RANGE;
        payload.extend_from_slice(
            &quantize_i16(scaled, scale, &QUATERNION_CLAMP_LOGGED, "quaternion").to_be_bytes(),
        );
    }
}

fn quantize_i16(value: f32, scale: f32, clamp_logged: &AtomicBool, label: &str) -> i16 {
    let quantized = (value * scale).round();
    let clamped = quantized.clamp(i16::MIN as f32, i16::MAX as f32);
    if quantized != clamped && !clamp_logged.swap(true, Ordering::Relaxed) {
        warn!(value, quantized, label, "binary protocol value was clamped");
    }

    clamped as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_roundtrip() {
        let encoded = [TYPE_INPUT, 0, 0, 0, 42, 0b0101];
        assert_eq!(encoded.len(), INPUT_BYTES);
        assert_eq!(
            decode_input(&encoded).unwrap(),
            BinaryInput {
                input_seq: 42,
                input: PlayerInput {
                    up: true,
                    down: false,
                    left: true,
                    right: false,
                },
            }
        );
    }

    #[test]
    fn rejects_bad_input_datagrams() {
        assert!(decode_input(&[]).is_err());
        assert!(decode_input(&[TYPE_INPUT, 0, 0, 0, 1, 0, 0]).is_err());
        assert!(decode_input(&[TYPE_STATE, 0, 0, 0, 1, 0]).is_err());
    }

    #[test]
    fn reliable_client_messages_decode() {
        assert_eq!(
            decode_client_message(&[TYPE_JOIN]).unwrap(),
            ClientMessage::Join
        );
        assert_eq!(
            decode_client_message(&[TYPE_RESTART]).unwrap(),
            ClientMessage::Restart
        );
        assert_eq!(
            decode_client_message(&[TYPE_PING, 0, 0, 0, 42]).unwrap(),
            ClientMessage::Ping { ping_seq: 42 }
        );
    }

    #[test]
    fn reliable_server_messages_roundtrip() {
        for message in [
            ServerMessage::Welcome { player_id: 7 },
            ServerMessage::Restarted,
            ServerMessage::Pong { ping_seq: 42 },
            ServerMessage::Error {
                message: "invalid message".to_string(),
            },
        ] {
            let encoded = encode_server_message(&message).unwrap();
            assert_eq!(decode_server_message(&encoded).unwrap(), message);
        }
    }

    #[test]
    fn rejects_bad_reliable_messages() {
        assert!(decode_client_message(&[]).is_err());
        assert!(decode_client_message(&[TYPE_JOIN, 0]).is_err());
        assert!(decode_client_message(&[TYPE_PING, 0, 0, 1]).is_err());
        assert!(decode_client_message(&[TYPE_WELCOME, 1]).is_err());
        assert!(decode_server_message(&[TYPE_ERROR, 0, 4, b'o', b'o']).is_err());
        assert!(encode_server_message(&ServerMessage::Welcome { player_id: 256 }).is_err());
        assert!(encode_server_message(&ServerMessage::Pong {
            ping_seq: u32::MAX as u64 + 1
        })
        .is_err());
        assert!(encode_server_message(&ServerMessage::Error {
            message: "x".repeat(u16::MAX as usize + 1),
        })
        .is_err());
    }

    #[test]
    fn state_encoding_uses_expected_size_and_quantization() {
        let players = vec![PlayerSnapshot {
            player_id: 7,
            x: 1.234,
            y: 0.34,
            z: -3.2,
            vx: 4.5,
            vy: 0.0,
            vz: -2.25,
        }];
        let boxes = vec![BoxSnapshot {
            box_id: 9,
            x: 1.0,
            y: 0.45,
            z: 2.0,
            qx: 0.0,
            qy: 0.5,
            qz: -0.5,
            qw: 1.0,
            vx: 0.25,
            vy: 0.0,
            vz: -0.5,
            wx: 0.75,
            wy: -1.25,
            wz: 1.5,
        }];

        let encoded = encode_state(BinaryState {
            server_tick: 100,
            last_received_input_seq: 42,
            players: &players,
            boxes: &boxes,
            position_scale: 100.0,
            quaternion_scale: 32767.0,
        })
        .unwrap();

        assert_eq!(encoded.len(), STATE_HEADER_BYTES + PLAYER_BYTES + BOX_BYTES);
        assert_eq!(encoded[0], TYPE_STATE);
        assert_eq!(u32::from_be_bytes(encoded[1..5].try_into().unwrap()), 100);
        assert_eq!(u32::from_be_bytes(encoded[5..9].try_into().unwrap()), 42);
        assert_eq!(i16::from_be_bytes(encoded[12..14].try_into().unwrap()), 123);
        assert_eq!(i16::from_be_bytes(encoded[18..20].try_into().unwrap()), 450);
        assert_eq!(encoded[24], 9);
        assert_eq!(encoded[31], 3);
        assert_eq!(
            i16::from_be_bytes(encoded[36..38].try_into().unwrap()),
            -23170
        );
        assert_eq!(i16::from_be_bytes(encoded[38..40].try_into().unwrap()), 25);
        assert_eq!(i16::from_be_bytes(encoded[42..44].try_into().unwrap()), -50);
        assert_eq!(i16::from_be_bytes(encoded[44..46].try_into().unwrap()), 75);
        assert_eq!(
            i16::from_be_bytes(encoded[46..48].try_into().unwrap()),
            -125
        );
        assert_eq!(i16::from_be_bytes(encoded[48..50].try_into().unwrap()), 150);
    }
}
