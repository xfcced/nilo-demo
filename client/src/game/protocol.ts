export type ClientMessage =
  | { type: 'join' }
  | { type: 'ping'; clientTime: number }
  | { type: 'input'; seq: number; up: boolean; down: boolean; left: boolean; right: boolean }

export type ServerMessage =
  | { type: 'welcome'; playerId: number; serverTime: number }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'state'; serverTime: number; players: PlayerSnapshot[] }
  | { type: 'error'; message: string }

export type PlayerSnapshot = {
  playerId: number
  x: number
  z: number
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
    return typeof message.serverTime === 'number' && Array.isArray(message.players) && message.players.every(isPlayerSnapshot)
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
  return typeof player.playerId === 'number' && typeof player.x === 'number' && typeof player.z === 'number'
}
