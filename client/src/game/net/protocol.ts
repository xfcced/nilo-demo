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
}

const BINARY_TYPE_INPUT = 1
const BINARY_TYPE_STATE = 2
const INPUT_BYTES = 6
const STATE_HEADER_BYTES = 11
const PLAYER_BYTES = 13
const BOX_BYTES = 14
const SMALLEST_THREE_RANGE = Math.SQRT1_2

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message)
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
    boxes.push({ boxId, x, y, z, ...rotation })
    offset += BOX_BYTES
  }

  return { type: 'state', serverTick, lastReceivedInputSeq, players, boxes }
}

export function decodeServerMessage(line: string): ServerMessage {
  const value = JSON.parse(line) as unknown
  if (!isServerMessage(value)) {
    throw new Error(`Invalid server message: ${line}`)
  }
  return value
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== 'object') {
    return false
  }

  const message = value as Partial<ServerMessage>

  if (message.type === 'welcome') {
    return typeof message.playerId === 'number'
  }

  if (message.type === 'restarted') {
    return true
  }

  if (message.type === 'pong') {
    return typeof message.pingSeq === 'number'
  }

  if (message.type === 'state') {
    return (
      typeof message.serverTick === 'number' &&
      typeof message.lastReceivedInputSeq === 'number' &&
      Array.isArray(message.players) &&
      message.players.every(isPlayerSnapshot) &&
      Array.isArray(message.boxes) &&
      message.boxes.every(isBoxSnapshot)
    )
  }

  if (message.type === 'error') {
    return typeof message.message === 'string'
  }

  return false
}

function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }

  const player = value as Partial<PlayerSnapshot>
  return (
    typeof player.playerId === 'number' &&
    typeof player.x === 'number' &&
    typeof player.y === 'number' &&
    typeof player.z === 'number' &&
    typeof player.vx === 'number' &&
    typeof player.vy === 'number' &&
    typeof player.vz === 'number'
  )
}

function isBoxSnapshot(value: unknown): value is BoxSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }

  const box = value as Partial<BoxSnapshot>
  return (
    typeof box.boxId === 'number' &&
    typeof box.x === 'number' &&
    typeof box.y === 'number' &&
    typeof box.z === 'number' &&
    typeof box.qx === 'number' &&
    typeof box.qy === 'number' &&
    typeof box.qz === 'number' &&
    typeof box.qw === 'number'
  )
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
