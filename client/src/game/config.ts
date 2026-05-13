import configJson from '../../../config/game.json'

export type GameConfig = typeof configJson

export const gameConfig: GameConfig = configJson
export const FIXED_STEP_SECONDS = 1 / gameConfig.simulation.tickRate
export const FIXED_STEP_MS = FIXED_STEP_SECONDS * 1000

export function defaultWebTransportUrl(): string {
  const { defaultPort, webTransportPath } = gameConfig.network
  return `https://localhost:${defaultPort}${webTransportPath}`
}
