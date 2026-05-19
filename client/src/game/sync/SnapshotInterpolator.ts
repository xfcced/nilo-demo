import * as THREE from 'three'
import { gameConfig } from '../config'
import type { BoxSnapshot, PlayerSnapshot, ServerMessage } from '../net/protocol'
import type { RenderBox, RenderPlayer } from '../renderState'

const SERVER_TICK_MS = 1000 / gameConfig.simulation.tickRate
const MAX_SAMPLES_PER_ENTITY = Math.max(2, Math.ceil(gameConfig.interpolation.delayTicks) + 1)
const BOX_TELEPORT_DISTANCE = gameConfig.slope.halfZ

type StateMessage = Extract<ServerMessage, { type: 'state' }>

export type PlayerSample = PlayerSnapshot & {
  serverTick: number
}

export type BoxSample = BoxSnapshot & {
  serverTick: number
  teleported: boolean
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

  pushSnapshot(snapshot: StateMessage, receivedAtMs: number): void {
    this.latestSnapshot = snapshot
    this.latestSnapshotReceivedAtMs = receivedAtMs
    const updatedBoxIds = new Set<number>()

    for (const player of snapshot.players) {
      this.pushPlayerSample(player.playerId, { ...player, serverTick: snapshot.serverTick })
    }

    for (const box of snapshot.boxes) {
      updatedBoxIds.add(box.boxId)
      this.pushBoxSample(box.boxId, { ...box, serverTick: snapshot.serverTick, teleported: false })
    }

    for (const [boxId, samples] of this.boxSamples) {
      if (updatedBoxIds.has(boxId)) {
        continue
      }

      const latest = samples.at(-1)
      if (latest) {
        this.pushBoxSample(boxId, { ...latest, serverTick: snapshot.serverTick, teleported: false })
      }
    }
  }

  sampleLocalPlayer(nowMs: number, localPlayerId: number | null): RenderPlayer | null {
    if (localPlayerId === null || !this.latestSnapshot) {
      return null
    }

    const samples = this.playerSamples.get(localPlayerId)
    if (!samples) {
      return null
    }

    const renderTick = this.renderTick(nowMs)
    if (isExpired(samples, renderTick)) {
      this.playerSamples.delete(localPlayerId)
      return null
    }

    return samplePlayer(samples, renderTick, true)
  }

  sampleRemotePlayers(nowMs: number, localPlayerId: number | null): RenderPlayer[] {
    if (!this.latestSnapshot) {
      return []
    }

    const renderTick = this.renderTick(nowMs)
    const players: RenderPlayer[] = []

    for (const [playerId, samples] of this.playerSamples) {
      if (playerId === localPlayerId) {
        continue
      }

      if (isExpired(samples, renderTick)) {
        this.playerSamples.delete(playerId)
        continue
      }

      const sample = samplePlayer(samples, renderTick, false)
      if (sample) {
        players.push(sample)
      }
    }

    return players
  }

  sampleBoxes(nowMs: number): RenderBox[] {
    if (!this.latestSnapshot) {
      return []
    }

    const renderTick = this.renderTick(nowMs)
    const boxes: RenderBox[] = []

    for (const [boxId, samples] of this.boxSamples) {
      const sample = sampleBox(samples, renderTick)
      if (sample) {
        boxes.push(sample)
      }
    }

    return boxes
  }

  debugSamples(
    localPlayerId: number | null,
    options: { includeLocalPlayer: boolean; includeRemotePlayers: boolean; includeBoxes: boolean },
  ): InterpolationDebugState {
    const players: InterpolationDebugPlayerSample[] = []
    const boxes: InterpolationDebugBoxSample[] = []

    for (const [playerId, samples] of this.playerSamples) {
      const isLocalPlayer = playerId === localPlayerId
      if ((isLocalPlayer && !options.includeLocalPlayer) || (!isLocalPlayer && !options.includeRemotePlayers)) {
        continue
      }

      samples.forEach((sample, sampleIndex) => {
        players.push({ ...sample, sampleIndex, sampleCount: samples.length })
      })
    }

    if (options.includeBoxes) {
      for (const samples of this.boxSamples.values()) {
        samples.forEach((sample, sampleIndex) => {
          boxes.push({ ...sample, sampleIndex, sampleCount: samples.length })
        })
      }
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
    samples.push({ ...sample, teleported: isBoxTeleport(samples.at(-1), sample) })
    trimSamples(samples)
    this.boxSamples.set(boxId, samples)
  }

  private renderTick(nowMs: number): number {
    if (!this.latestSnapshot) {
      return 0
    }

    const elapsedTicks = (nowMs - this.latestSnapshotReceivedAtMs) / SERVER_TICK_MS
    return this.latestSnapshot.serverTick + elapsedTicks - gameConfig.interpolation.delayTicks
  }
}

function isBoxTeleport(previous: BoxSample | undefined, next: BoxSample): boolean {
  if (!previous) {
    return false
  }

  return distance(previous, next) > BOX_TELEPORT_DISTANCE
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

function samplePlayer(samples: PlayerSample[], renderTick: number, isLocal: boolean): RenderPlayer | null {
  const pair = findSamplePair(samples, renderTick)
  if (!pair) {
    return null
  }

  const { before, after, sampleAlpha } = pair

  return {
    playerId: before.playerId,
    isLocal,
    x: lerp(before.x, after.x, sampleAlpha),
    y: lerp(before.y, after.y, sampleAlpha),
    z: lerp(before.z, after.z, sampleAlpha),
  }
}

function sampleBox(samples: BoxSample[], renderTick: number): RenderBox | null {
  const pair = findBoxSamplePair(samples, renderTick)
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

function findBoxSamplePair(samples: BoxSample[], renderTick: number): { before: BoxSample; after: BoxSample; sampleAlpha: number } | null {
  if (samples.length === 0) {
    return null
  }

  if (renderTick <= samples[0].serverTick) {
    return { before: samples[0], after: samples[0], sampleAlpha: 0 }
  }

  for (let index = 0; index < samples.length - 1; index += 1) {
    const before = samples[index]
    const after = samples[index + 1]
    if (renderTick < before.serverTick || renderTick > after.serverTick) {
      continue
    }

    if (after.teleported) {
      if (renderTick < after.serverTick) {
        return { before, after: before, sampleAlpha: 0 }
      }
      continue
    }

    const span = after.serverTick - before.serverTick
    return {
      before,
      after,
      sampleAlpha: span <= 0 ? 0 : (renderTick - before.serverTick) / span,
    }
  }

  const latest = samples.at(-1)!
  return { before: latest, after: latest, sampleAlpha: 0 }
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

function distance(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
}
