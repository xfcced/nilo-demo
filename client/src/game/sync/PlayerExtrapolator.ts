import * as THREE from 'three'
import { gameConfig } from '../config'
import type { PlayerSnapshot, ServerMessage } from '../net/protocol'
import type { RenderPlayer } from '../renderState'

const SERVER_TICK_MS = 1000 / gameConfig.simulation.tickRate
const MAX_EXTRAPOLATION_SECONDS = 0.15
const MIN_ANGULAR_SPEED = 0.0001

type StateMessage = Extract<ServerMessage, { type: 'state' }>

type PlayerState = PlayerSnapshot & {
  serverTick: number
}

export class PlayerExtrapolator {
  private latestPlayerStates = new Map<number, PlayerState>()
  private latestServerTick = 0
  private latestSnapshotReceivedAtMs = 0

  pushSnapshot(snapshot: StateMessage, receivedAtMs: number): void {
    if (snapshot.serverTick < this.latestServerTick) {
      return
    }

    this.latestServerTick = snapshot.serverTick
    this.latestSnapshotReceivedAtMs = receivedAtMs

    const activePlayerIds = new Set<number>()
    for (const player of snapshot.players) {
      activePlayerIds.add(player.playerId)
      this.latestPlayerStates.set(player.playerId, { ...player, serverTick: snapshot.serverTick })
    }

    for (const playerId of this.latestPlayerStates.keys()) {
      if (!activePlayerIds.has(playerId)) {
        this.latestPlayerStates.delete(playerId)
      }
    }
  }

  sample(nowMs: number, localPlayerId: number | null, localPlayerOverride: RenderPlayer | null = null): RenderPlayer[] {
    const players: RenderPlayer[] = []
    if (localPlayerOverride) {
      players.push(localPlayerOverride)
    }

    if (this.latestServerTick <= 0) {
      return players
    }

    const elapsedSinceLatestSnapshotTicks = (nowMs - this.latestSnapshotReceivedAtMs) / SERVER_TICK_MS
    for (const player of this.latestPlayerStates.values()) {
      if (player.playerId === localPlayerId) {
        continue
      }

      const elapsedTicks = this.latestServerTick + elapsedSinceLatestSnapshotTicks - player.serverTick
      const deltaSeconds = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, elapsedTicks / gameConfig.simulation.tickRate))
      const rotation = extrapolateRotation(player, deltaSeconds)
      players.push({
        playerId: player.playerId,
        isLocal: false,
        x: player.x + player.vx * deltaSeconds,
        y: player.y + player.vy * deltaSeconds,
        z: player.z + player.vz * deltaSeconds,
        qx: rotation.x,
        qy: rotation.y,
        qz: rotation.z,
        qw: rotation.w,
      })
    }

    return players
  }

  reset(): void {
    this.latestPlayerStates.clear()
    this.latestServerTick = 0
    this.latestSnapshotReceivedAtMs = 0
  }
}

function extrapolateRotation(player: PlayerState, deltaSeconds: number): THREE.Quaternion {
  const rotation = new THREE.Quaternion(player.qx, player.qy, player.qz, player.qw).normalize()
  const angularSpeed = Math.hypot(player.wx, player.wy, player.wz)

  if (angularSpeed < MIN_ANGULAR_SPEED || deltaSeconds <= 0) {
    return rotation
  }

  const axis = new THREE.Vector3(player.wx / angularSpeed, player.wy / angularSpeed, player.wz / angularSpeed)
  const deltaRotation = new THREE.Quaternion().setFromAxisAngle(axis, angularSpeed * deltaSeconds)
  return rotation.premultiply(deltaRotation).normalize()
}
