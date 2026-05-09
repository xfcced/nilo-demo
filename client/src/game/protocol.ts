export type ClientMessage = { type: 'join' } | { type: 'ping'; clientTime: number } | { type: 'input'; seq: number; up: boolean; down: boolean; left: boolean; right: boolean }

export type ServerMessage =
  | { type: 'welcome'; playerId: number; serverTime: number }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'state'; serverTime: number; players: PlayerSnapshot[]; boxes: BoxSnapshot[] }
  | { type: 'error'; message: string }

export type PlayerSnapshot = {
  playerId: number
  x: number
  y: number
  z: number
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

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message)
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
    return typeof message.playerId === 'number' && typeof message.serverTime === 'number'
  }

  if (message.type === 'pong') {
    return typeof message.clientTime === 'number' && typeof message.serverTime === 'number'
  }

  if (message.type === 'state') {
    return typeof message.serverTime === 'number' && Array.isArray(message.players) && message.players.every(isPlayerSnapshot) && Array.isArray(message.boxes) && message.boxes.every(isBoxSnapshot)
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
  return typeof player.playerId === 'number' && typeof player.x === 'number' && typeof player.y === 'number' && typeof player.z === 'number'
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
