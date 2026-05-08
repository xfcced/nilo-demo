export type ClientMessage =
  | { type: 'join' }
  | { type: 'ping'; clientTime: number }

export type ServerMessage =
  | { type: 'welcome'; playerId: number; serverTime: number }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'error'; message: string }

export function encodeMessage(message: ClientMessage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`)
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

  if (message.type === 'error') {
    return typeof message.message === 'string'
  }

  return false
}
