import { gameConfig } from '../config'

export type ClientMessage =
  | { type: 'join' }
  | { type: 'restart' }
  | { type: 'ping'; pingSeq: number }
  | { type: 'input'; inputSeq: number; up: boolean; down: boolean; left: boolean; right: boolean }

export type ServerMessage =
  | { type: 'welcome'; playerId: number }
  | { type: 'restarted' }
  | { type: 'pong'; pingSeq: number }
  | { type: 'state'; serverTick: number; lastReceivedInputSeq: number; players: PlayerSnapshot[]; boxes: BoxSnapshot[] }
  | { type: 'error'; message: string }

export type PlayerSnapshot = {
  playerId: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

export type BoxSnapshot = {
  boxId: number
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
  wx: number
  wy: number
  wz: number
}

const BINARY_TYPE_INPUT = 1
const BINARY_TYPE_STATE = 2
const BINARY_TYPE_JOIN = 3
const BINARY_TYPE_RESTART = 4
const BINARY_TYPE_PING = 5
const BINARY_TYPE_WELCOME = 6
const BINARY_TYPE_RESTARTED = 7
const BINARY_TYPE_PONG = 8
const BINARY_TYPE_ERROR = 9
const INPUT_BYTES = 6
const STATE_HEADER_BYTES = 11
const PLAYER_BYTES = 13
const BOX_BYTES = 26
const SMALLEST_THREE_RANGE = Math.SQRT1_2
const U32_MAX = 0xffffffff
const textDecoder = new TextDecoder()

export function encodeReliableClientMessage(message: Exclude<ClientMessage, { type: 'input' }>): Uint8Array {
  if (message.type === 'join') {
    return new Uint8Array([BINARY_TYPE_JOIN])
  }

  if (message.type === 'restart') {
    return new Uint8Array([BINARY_TYPE_RESTART])
  }

  const payload = new Uint8Array(5)
  const view = new DataView(payload.buffer)
  view.setUint8(0, BINARY_TYPE_PING)
  writeU32(view, 1, message.pingSeq, 'pingSeq')
  return payload
}

export function encodeInputDatagram(message: Extract<ClientMessage, { type: 'input' }>): Uint8Array {
  const payload = new Uint8Array(INPUT_BYTES)
  const view = new DataView(payload.buffer)
  view.setUint8(0, BINARY_TYPE_INPUT)
  view.setUint32(1, message.inputSeq, false)
  view.setUint8(5, encodeButtons(message))
  return payload
}

export function decodeStateDatagram(payload: Uint8Array): ServerMessage {
  if (payload.byteLength < STATE_HEADER_BYTES) {
    throw new Error(`Invalid state datagram size: ${payload.byteLength}`)
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const type = view.getUint8(0)
  if (type !== BINARY_TYPE_STATE) {
    throw new Error(`Unexpected datagram type: ${type}`)
  }

  const serverTick = view.getUint32(1, false)
  const lastReceivedInputSeq = view.getUint32(5, false)
  const playerCount = view.getUint8(9)
  const boxCount = view.getUint8(10)
  const expectedBytes = STATE_HEADER_BYTES + playerCount * PLAYER_BYTES + boxCount * BOX_BYTES
  if (payload.byteLength !== expectedBytes) {
    throw new Error(`Invalid state datagram size: ${payload.byteLength}, expected ${expectedBytes}`)
  }

  let offset = STATE_HEADER_BYTES
  const players: PlayerSnapshot[] = []
  for (let index = 0; index < playerCount; index += 1) {
    players.push({
      playerId: view.getUint8(offset),
      x: readPosition(view, offset + 1),
      y: readPosition(view, offset + 3),
      z: readPosition(view, offset + 5),
      vx: readPosition(view, offset + 7),
      vy: readPosition(view, offset + 9),
      vz: readPosition(view, offset + 11),
    })
    offset += PLAYER_BYTES
  }

  const boxes: BoxSnapshot[] = []
  for (let index = 0; index < boxCount; index += 1) {
    const boxId = view.getUint8(offset)
    const x = readPosition(view, offset + 1)
    const y = readPosition(view, offset + 3)
    const z = readPosition(view, offset + 5)
    const rotation = readSmallestThreeQuaternion(view, offset + 7)
    boxes.push({
      boxId,
      x,
      y,
      z,
      ...rotation,
      vx: readPosition(view, offset + 14),
      vy: readPosition(view, offset + 16),
      vz: readPosition(view, offset + 18),
      wx: readPosition(view, offset + 20),
      wy: readPosition(view, offset + 22),
      wz: readPosition(view, offset + 24),
    })
    offset += BOX_BYTES
  }

  return { type: 'state', serverTick, lastReceivedInputSeq, players, boxes }
}

export function decodeReliableServerMessage(payload: Uint8Array): ServerMessage {
  if (payload.byteLength < 1) {
    throw new Error('Invalid reliable message size: 0')
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const type = view.getUint8(0)

  if (type === BINARY_TYPE_WELCOME) {
    if (payload.byteLength !== 2) {
      throw new Error(`Invalid welcome message size: ${payload.byteLength}`)
    }
    return { type: 'welcome', playerId: view.getUint8(1) }
  }

  if (type === BINARY_TYPE_RESTARTED) {
    if (payload.byteLength !== 1) {
      throw new Error(`Invalid restarted message size: ${payload.byteLength}`)
    }
    return { type: 'restarted' }
  }

  if (type === BINARY_TYPE_PONG) {
    if (payload.byteLength !== 5) {
      throw new Error(`Invalid pong message size: ${payload.byteLength}`)
    }
    return { type: 'pong', pingSeq: view.getUint32(1, false) }
  }

  if (type === BINARY_TYPE_ERROR) {
    if (payload.byteLength < 3) {
      throw new Error(`Invalid error message size: ${payload.byteLength}`)
    }
    const length = view.getUint16(1, false)
    const expectedBytes = 3 + length
    if (payload.byteLength !== expectedBytes) {
      throw new Error(`Invalid error message size: ${payload.byteLength}, expected ${expectedBytes}`)
    }
    return { type: 'error', message: textDecoder.decode(payload.subarray(3)) }
  }

  throw new Error(`Unexpected reliable message type: ${type}`)
}

function encodeButtons(message: Extract<ClientMessage, { type: 'input' }>): number {
  let buttons = 0
  if (message.up) {
    buttons |= 1 << 0
  }
  if (message.down) {
    buttons |= 1 << 1
  }
  if (message.left) {
    buttons |= 1 << 2
  }
  if (message.right) {
    buttons |= 1 << 3
  }
  return buttons
}

function readPosition(view: DataView, offset: number): number {
  return view.getInt16(offset, false) / gameConfig.protocol.positionScale
}

function readQuaternion(view: DataView, offset: number): number {
  return (view.getInt16(offset, false) / gameConfig.protocol.quaternionScale) * SMALLEST_THREE_RANGE
}

function readSmallestThreeQuaternion(view: DataView, offset: number): Pick<BoxSnapshot, 'qx' | 'qy' | 'qz' | 'qw'> {
  const largestIndex = view.getUint8(offset)
  if (largestIndex > 3) {
    throw new Error(`Invalid quaternion largest index: ${largestIndex}`)
  }

  const components = [0, 0, 0, 0]
  let sourceOffset = offset + 1
  let omittedSum = 0
  for (let index = 0; index < components.length; index += 1) {
    if (index === largestIndex) {
      continue
    }

    const component = readQuaternion(view, sourceOffset)
    components[index] = component
    omittedSum += component * component
    sourceOffset += 2
  }

  components[largestIndex] = Math.sqrt(Math.max(0, 1 - omittedSum))
  return normalizeQuaternion({
    qx: components[0],
    qy: components[1],
    qz: components[2],
    qw: components[3],
  })
}

function writeU32(view: DataView, offset: number, value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${label} exceeds binary protocol range: ${value}`)
  }

  view.setUint32(offset, value, false)
}

function normalizeQuaternion(rotation: Pick<BoxSnapshot, 'qx' | 'qy' | 'qz' | 'qw'>): Pick<BoxSnapshot, 'qx' | 'qy' | 'qz' | 'qw'> {
  const length = Math.hypot(rotation.qx, rotation.qy, rotation.qz, rotation.qw)
  if (length <= 0) {
    return { qx: 0, qy: 0, qz: 0, qw: 1 }
  }

  return {
    qx: rotation.qx / length,
    qy: rotation.qy / length,
    qz: rotation.qz / length,
    qw: rotation.qw / length,
  }
}
