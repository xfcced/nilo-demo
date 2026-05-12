use crate::game::protocol::{BoxSnapshot, PlayerSnapshot};
use crate::game::room::PlayerInput;
use anyhow::{bail, ensure, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::warn;

const TYPE_INPUT: u8 = 1;
const TYPE_STATE: u8 = 2;
const INPUT_BYTES: usize = 6;
const STATE_HEADER_BYTES: usize = 7;
const PLAYER_BYTES: usize = 7;
const BOX_BYTES: usize = 14;
const POSITION_SCALE: f32 = 100.0;
const QUATERNION_SCALE: f32 = 32767.0;
const SMALLEST_THREE_RANGE: f32 = std::f32::consts::FRAC_1_SQRT_2;
static POSITION_CLAMP_LOGGED: AtomicBool = AtomicBool::new(false);
static QUATERNION_CLAMP_LOGGED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinaryInput {
    pub seq: u32,
    pub input: PlayerInput,
}

#[derive(Clone, Debug)]
pub struct BinaryState<'a> {
    pub server_tick: u64,
    pub players: &'a [PlayerSnapshot],
    pub boxes: &'a [BoxSnapshot],
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
        seq: u32::from_be_bytes(payload[1..5].try_into()?),
        input: decode_buttons(payload[5]),
    })
}

pub fn encode_state(state: BinaryState<'_>) -> Result<Vec<u8>> {
    ensure!(
        state.server_tick <= u32::MAX as u64,
        "server tick exceeds binary protocol range: {}",
        state.server_tick
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
    payload.push(state.players.len() as u8);
    payload.push(state.boxes.len() as u8);

    for player in state.players {
        write_u8(&mut payload, player.player_id, "player id")?;
        write_position(&mut payload, player.x);
        write_position(&mut payload, player.y);
        write_position(&mut payload, player.z);
    }

    for box_snapshot in state.boxes {
        write_u8(&mut payload, box_snapshot.box_id, "box id")?;
        write_position(&mut payload, box_snapshot.x);
        write_position(&mut payload, box_snapshot.y);
        write_position(&mut payload, box_snapshot.z);
        write_smallest_three_quaternion(
            &mut payload,
            [
                box_snapshot.qx,
                box_snapshot.qy,
                box_snapshot.qz,
                box_snapshot.qw,
            ],
        );
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

fn write_position(payload: &mut Vec<u8>, meters: f32) {
    payload.extend_from_slice(
        &quantize_i16(meters, POSITION_SCALE, &POSITION_CLAMP_LOGGED, "position").to_be_bytes(),
    );
}

fn write_smallest_three_quaternion(payload: &mut Vec<u8>, quaternion: [f32; 4]) {
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
            &quantize_i16(
                scaled,
                QUATERNION_SCALE,
                &QUATERNION_CLAMP_LOGGED,
                "quaternion",
            )
            .to_be_bytes(),
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
                seq: 42,
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
    fn state_encoding_uses_expected_size_and_quantization() {
        let players = vec![PlayerSnapshot {
            player_id: 7,
            x: 1.234,
            y: 0.34,
            z: -3.2,
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
        }];

        let encoded = encode_state(BinaryState {
            server_tick: 100,
            players: &players,
            boxes: &boxes,
        })
        .unwrap();

        assert_eq!(encoded.len(), STATE_HEADER_BYTES + PLAYER_BYTES + BOX_BYTES);
        assert_eq!(encoded[0], TYPE_STATE);
        assert_eq!(u32::from_be_bytes(encoded[1..5].try_into().unwrap()), 100);
        assert_eq!(i16::from_be_bytes(encoded[8..10].try_into().unwrap()), 123);
        assert_eq!(encoded[14], 9);
        assert_eq!(encoded[21], 3);
        assert_eq!(
            i16::from_be_bytes(encoded[26..28].try_into().unwrap()),
            -23170
        );
    }
}
