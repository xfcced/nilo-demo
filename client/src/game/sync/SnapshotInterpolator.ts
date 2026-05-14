import * as THREE from 'three'
import { gameConfig } from '../config'
import type { BoxSnapshot, PlayerSnapshot, ServerMessage } from '../net/protocol'
import type { RenderBox, RenderPlayer, RenderWorldState } from '../renderState'

const SERVER_TICK_MS = 1000 / gameConfig.simulation.tickRate
const MAX_SAMPLES_PER_ENTITY = Math.max(2, Math.ceil(gameConfig.interpolation.delayTicks) + 1)

type StateMessage = Extract<ServerMessage, { type: 'state' }>

export type PlayerSample = PlayerSnapshot & {
  serverTick: number
}

export type BoxSample = BoxSnapshot & {
  serverTick: number
  synthetic: boolean
}

export type InterpolationDebugPlayerSample = PlayerSample & {
  sampleIndex: number
  sampleCount: number
}

export type InterpolationDebugBoxSample = BoxSample & {
  sampleIndex: number
  sampleCount: number
}

export type InterpolationDebugState = {
  players: InterpolationDebugPlayerSample[]
  boxes: InterpolationDebugBoxSample[]
}

export class SnapshotInterpolator {
  private playerSamples = new Map<number, PlayerSample[]>()
  private boxSamples = new Map<number, BoxSample[]>()
  private latestSnapshot: StateMessage | null = null
  private latestSnapshotReceivedAtMs = 0

  pushSnapshot(snapshot: StateMessage, receivedAtMs: number): boolean {
    if (this.latestSnapshot && snapshot.serverTick <= this.latestSnapshot.serverTick) {
      return false
    }

    this.latestSnapshot = snapshot
    this.latestSnapshotReceivedAtMs = receivedAtMs

    for (const player of snapshot.players) {
      this.pushPlayerSample(player.playerId, { ...player, serverTick: snapshot.serverTick })
    }

    for (const box of snapshot.boxes) {
      this.pushBoxSample(box.boxId, { ...box, serverTick: snapshot.serverTick, synthetic: false })
    }

    return true
  }

  sample(nowMs: number, localPlayerId: number | null, localPlayerOverride: RenderPlayer | null = null): RenderWorldState {
    if (!this.latestSnapshot) {
      return { players: [], boxes: [] }
    }

    const elapsedTicks = (nowMs - this.latestSnapshotReceivedAtMs) / SERVER_TICK_MS
    const renderTick = this.latestSnapshot.serverTick + elapsedTicks - gameConfig.interpolation.delayTicks
    const players: RenderPlayer[] = []
    const boxes: RenderBox[] = []

    if (localPlayerOverride) {
      players.push(localPlayerOverride)
    } else if (localPlayerId !== null) {
      const localPlayer = this.latestSnapshot.players.find((player) => player.playerId === localPlayerId)
      if (localPlayer) {
        players.push({
          playerId: localPlayer.playerId,
          isLocal: true,
          x: localPlayer.x,
          y: localPlayer.y,
          z: localPlayer.z,
        })
      }
    }

    for (const [playerId, samples] of this.playerSamples) {
      if (playerId === localPlayerId) {
        continue
      }

      if (isExpired(samples, renderTick)) {
        this.playerSamples.delete(playerId)
        continue
      }

      const sample = samplePlayer(samples, renderTick)
      if (sample) {
        players.push(sample)
      }
    }

    for (const [boxId, samples] of this.boxSamples) {
      const sample = sampleBox(samples, renderTick)
      if (sample) {
        boxes.push(sample)
      }
    }

    return { players, boxes }
  }

  debugSamples(localPlayerId: number | null): InterpolationDebugState {
    const players: InterpolationDebugPlayerSample[] = []
    const boxes: InterpolationDebugBoxSample[] = []

    for (const [playerId, samples] of this.playerSamples) {
      if (playerId === localPlayerId) {
        continue
      }

      samples.forEach((sample, sampleIndex) => {
        players.push({ ...sample, sampleIndex, sampleCount: samples.length })
      })
    }

    for (const samples of this.boxSamples.values()) {
      const authoritativeSamples = samples.filter((sample) => !sample.synthetic)
      authoritativeSamples.forEach((sample, sampleIndex) => {
        boxes.push({ ...sample, sampleIndex, sampleCount: authoritativeSamples.length })
      })
    }

    return { players, boxes }
  }

  reset(): void {
    this.playerSamples.clear()
    this.boxSamples.clear()
    this.latestSnapshot = null
    this.latestSnapshotReceivedAtMs = 0
  }

  private pushPlayerSample(playerId: number, sample: PlayerSample): void {
    const samples = this.playerSamples.get(playerId) ?? []
    samples.push(sample)
    trimSamples(samples)
    this.playerSamples.set(playerId, samples)
  }

  private pushBoxSample(boxId: number, sample: BoxSample): void {
    const samples = this.boxSamples.get(boxId) ?? []
    appendBoxHoldSamples(samples, sample.serverTick)
    samples.push(sample)
    trimSamples(samples)
    this.boxSamples.set(boxId, samples)
  }
}

function appendBoxHoldSamples(samples: BoxSample[], incomingTick: number): void {
  const latest = samples.at(-1)
  if (!latest) {
    return
  }

  const gap = incomingTick - latest.serverTick
  if (gap <= 1) {
    return
  }

  const firstHoldTick = Math.max(latest.serverTick + 1, incomingTick - Math.ceil(gameConfig.interpolation.delayTicks))
  for (let serverTick = firstHoldTick; serverTick < incomingTick; serverTick += 1) {
    samples.push({ ...latest, serverTick, synthetic: true })
  }
}

function trimSamples<T>(samples: T[]): void {
  if (samples.length > MAX_SAMPLES_PER_ENTITY) {
    samples.splice(0, samples.length - MAX_SAMPLES_PER_ENTITY)
  }
}

function isExpired(samples: Array<{ serverTick: number }>, renderTick: number): boolean {
  const latest = samples.at(-1)
  return !latest || renderTick - latest.serverTick > gameConfig.interpolation.entityExpireTicks
}

function samplePlayer(samples: PlayerSample[], renderTick: number): RenderPlayer | null {
  const pair = findSamplePair(samples, renderTick)
  if (!pair) {
    return null
  }

  const { before, after, sampleAlpha } = pair
  return {
    playerId: before.playerId,
    isLocal: false,
    x: lerp(before.x, after.x, sampleAlpha),
    y: lerp(before.y, after.y, sampleAlpha),
    z: lerp(before.z, after.z, sampleAlpha),
  }
}

function sampleBox(samples: BoxSample[], renderTick: number): RenderBox | null {
  const pair = findSamplePair(samples, renderTick)
  if (!pair) {
    return null
  }

  const { before, after, sampleAlpha } = pair
  const from = new THREE.Quaternion(before.qx, before.qy, before.qz, before.qw)
  const to = new THREE.Quaternion(after.qx, after.qy, after.qz, after.qw)
  const rotation = from.slerp(to, sampleAlpha)

  return {
    boxId: before.boxId,
    x: lerp(before.x, after.x, sampleAlpha),
    y: lerp(before.y, after.y, sampleAlpha),
    z: lerp(before.z, after.z, sampleAlpha),
    qx: rotation.x,
    qy: rotation.y,
    qz: rotation.z,
    qw: rotation.w,
  }
}

function findSamplePair<T extends { serverTick: number }>(samples: T[], renderTick: number): { before: T; after: T; sampleAlpha: number } | null {
  if (samples.length === 0) {
    return null
  }

  if (renderTick <= samples[0].serverTick) {
    return { before: samples[0], after: samples[0], sampleAlpha: 0 }
  }

  for (let index = 0; index < samples.length - 1; index += 1) {
    const before = samples[index]
    const after = samples[index + 1]
    if (renderTick >= before.serverTick && renderTick <= after.serverTick) {
      const span = after.serverTick - before.serverTick
      return {
        before,
        after,
        sampleAlpha: span <= 0 ? 0 : (renderTick - before.serverTick) / span,
      }
    }
  }

  const latest = samples.at(-1)!
  return { before: latest, after: latest, sampleAlpha: 0 }
}

function lerp(from: number, to: number, sampleAlpha: number): number {
  return from + (to - from) * sampleAlpha
}
