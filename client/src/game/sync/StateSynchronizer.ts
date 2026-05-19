import type { RenderWorldState } from '../renderState'
import type { ServerMessage } from '../net/protocol'
import { BoxExtrapolator } from './BoxExtrapolator'
import {
  LocalPlayerPredictor,
  type LocalPredictionDebugState,
  type MovementInput,
  type PredictionMetrics,
} from './LocalPlayerPredictor'
import { PlayerExtrapolator } from './PlayerExtrapolator'
import { SnapshotInterpolator, type InterpolationDebugState } from './SnapshotInterpolator'

type StateMessage = Extract<ServerMessage, { type: 'state' }>

export type LocalPlayerSyncMode = 'prediction' | 'interpolation'
export type RemoteEntitySyncMode = 'extrapolation' | 'interpolation'

export type SyncModes = {
  localPlayer: LocalPlayerSyncMode
  remotePlayers: RemoteEntitySyncMode
  boxes: RemoteEntitySyncMode
}

export const defaultSyncModes: SyncModes = {
  localPlayer: 'prediction',
  remotePlayers: 'extrapolation',
  boxes: 'extrapolation',
}

export type PushServerSnapshotResult = {
  accepted: boolean
  predictionMetrics: PredictionMetrics | null
}

export class StateSynchronizer {
  private interpolator = new SnapshotInterpolator()
  private playerExtrapolator = new PlayerExtrapolator()
  private boxExtrapolator = new BoxExtrapolator()
  private localPlayerPredictor = new LocalPlayerPredictor()
  private modes: SyncModes = { ...defaultSyncModes }
  private latestAcceptedServerTick: number | null = null
  private localPredictionTick: number | null = null

  setModes(modes: SyncModes): void {
    this.modes = { ...modes }
  }

  pushServerSnapshot(snapshot: StateMessage, receivedAtMs: number, localPlayerId: number | null): PushServerSnapshotResult {
    if (this.latestAcceptedServerTick !== null && snapshot.serverTick <= this.latestAcceptedServerTick) {
      return { accepted: false, predictionMetrics: null }
    }

    this.latestAcceptedServerTick = snapshot.serverTick
    this.interpolator.pushSnapshot(snapshot, receivedAtMs)
    this.playerExtrapolator.pushSnapshot(snapshot, receivedAtMs)
    this.boxExtrapolator.pushSnapshot(snapshot, receivedAtMs)

    const predictionMetrics = this.reconcileLocalPlayer(snapshot, localPlayerId)
    return { accepted: true, predictionMetrics }
  }

  canPredictLocalInput(): boolean {
    return this.localPredictionTick !== null
  }

  pushLocalInput(input: MovementInput): PredictionMetrics {
    if (this.localPredictionTick === null) {
      return this.localPlayerPredictor.metrics()
    }

    this.localPredictionTick += 1
    this.localPlayerPredictor.pushLocalInput(this.localPredictionTick, input)
    return this.localPlayerPredictor.metrics()
  }

  sampleRenderState(
    nowMs: number,
    localPlayerId: number | null,
    fixedStepAlpha: number,
    renderDeltaSeconds: number,
  ): RenderWorldState {
    const localPlayer =
      this.modes.localPlayer === 'prediction' && localPlayerId !== null
        ? this.localPlayerPredictor.renderPlayer(localPlayerId, fixedStepAlpha, renderDeltaSeconds)
        : this.interpolator.sampleLocalPlayer(nowMs, localPlayerId)

    const players =
      this.modes.remotePlayers === 'interpolation'
        ? this.interpolator.sampleRemotePlayers(nowMs, localPlayerId)
        : this.playerExtrapolator.sample(nowMs, localPlayerId)

    if (localPlayer) {
      players.unshift(localPlayer)
    }

    const boxes =
      this.modes.boxes === 'interpolation'
        ? this.interpolator.sampleBoxes(nowMs)
        : this.boxExtrapolator.sample(nowMs)

    return { players, boxes }
  }

  interpolationDebugSamples(localPlayerId: number | null): InterpolationDebugState {
    return this.interpolator.debugSamples(localPlayerId, {
      includeLocalPlayer: this.modes.localPlayer === 'interpolation',
      includeRemotePlayers: this.modes.remotePlayers === 'interpolation',
      includeBoxes: this.modes.boxes === 'interpolation',
    })
  }

  localPredictionDebugState(): LocalPredictionDebugState {
    return this.localPlayerPredictor.debugState()
  }

  reset(): void {
    this.interpolator.reset()
    this.playerExtrapolator.reset()
    this.boxExtrapolator.reset()
    this.localPlayerPredictor.reset()
    this.latestAcceptedServerTick = null
    this.localPredictionTick = null
  }

  private reconcileLocalPlayer(snapshot: StateMessage, localPlayerId: number | null): PredictionMetrics | null {
    if (localPlayerId === null) {
      return null
    }

    const authoritativePlayer = snapshot.players.find((player) => player.playerId === localPlayerId)
    if (!authoritativePlayer) {
      return null
    }

    if (this.localPredictionTick === null) {
      this.localPredictionTick = snapshot.serverTick
    } else {
      this.localPredictionTick = Math.max(this.localPredictionTick, snapshot.serverTick)
    }

    this.localPlayerPredictor.reconcile(authoritativePlayer, snapshot.serverTick, snapshot.lastReceivedInputSeq)
    return this.localPlayerPredictor.metrics()
  }
}
