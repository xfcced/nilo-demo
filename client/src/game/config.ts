import configJson from '../../../config/game.json'

export type GameConfig = typeof configJson

export const gameConfig: GameConfig = configJson

export function defaultWebTransportUrl(): string {
  const { defaultPort, webTransportPath } = gameConfig.network
  return `https://localhost:${defaultPort}${webTransportPath}`
}
