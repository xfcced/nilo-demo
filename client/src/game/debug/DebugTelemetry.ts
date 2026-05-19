import type { TransportCounters } from '../../engine/WebTransportClient'
import type { ServerMessage } from '../net/protocol'
import type { PredictionMetrics } from '../sync/LocalPlayerPredictor'
import { DebugPanel, type DebugOptions } from './DebugPanel'

export type { DebugOptions }

type StateMessage = Extract<ServerMessage, { type: 'state' }>

type DebugTelemetryOptions = {
  panel?: DebugPanel
  getTransportStats: () => TransportCounters
}

const FPS_SAMPLE_MS = 500
const NETWORK_STATS_SAMPLE_MS = 1000

export class DebugTelemetry {
  private panel: DebugPanel
  private fpsElapsedMs = 0
  private fpsFrameCount = 0
  private networkStatsElapsedMs = 0
  private previousNetworkCounters: TransportCounters | null = null

  constructor(private options: DebugTelemetryOptions) {
    this.panel = options.panel ?? new DebugPanel()
  }

  start(): void {
    this.panel.setConnection('disconnected')
    this.panel.setFps(null)
    this.panel.setNetworkStats(null)
    this.panel.setPredictionMetrics(null)
    this.panel.resetStateIntervalChart()
  }

  debugOptions(): DebugOptions {
    return this.panel.debugOptions()
  }

  onRestart(handler: () => void): void {
    this.panel.onRestart(handler)
  }

  onDebugOptionsChanged(handler: (options: DebugOptions) => void): void {
    this.panel.onDebugOptionsChanged(handler)
  }

  onConnectStart(): void {
    this.panel.setConnection('connecting')
    this.panel.log('connecting...')
  }

  onConnected(): void {
    this.resetNetworkStatsSample()
    this.panel.setConnection('connected')
    this.panel.resetStateIntervalChart()
    this.panel.resetLossChart()
  }

  onConnectFailed(error: unknown): void {
    this.previousNetworkCounters = null
    this.networkStatsElapsedMs = 0
    this.panel.setConnection('disconnected')
    this.panel.log(`connect failed: ${String(error)}`)
  }

  onDisconnected(reason: string): void {
    this.panel.setConnection('disconnected')
    this.panel.log(`connection closed: ${reason}`)
  }

  onManualDisconnect(): void {
    this.panel.setConnection('disconnected')
    this.panel.setPlayerId(null)
    this.panel.setRtt(null)
  }

  onWelcome(playerId: number, connected: boolean): void {
    this.panel.setPlayerId(playerId)
    this.setRestartEnabled(connected)
    this.panel.log(`joined as player ${playerId}`)
  }

  onRestarted(): void {
    this.panel.log('game restarted')
  }

  onRestartFailed(error: unknown, connected: boolean): void {
    if (connected) {
      this.panel.log(`restart failed: ${String(error)}`)
    }
    this.setRestartEnabled(true)
  }

  onPong(rttMs: number): void {
    this.panel.setRtt(rttMs)
  }

  onUnknownPong(pingSeq: number): void {
    this.panel.log(`ignored pong for unknown ping ${pingSeq}`)
  }

  onStateAccepted(message: StateMessage, predictionMetrics: PredictionMetrics | null, receivedAtMs: number): void {
    this.panel.setServerTick(message.serverTick)
    this.panel.recordStateReceived(receivedAtMs)
    this.panel.recordLossSample(message.serverTick, message.lastReceivedInputSeq, receivedAtMs)
    if (predictionMetrics) {
      this.panel.setPredictionMetrics(predictionMetrics)
    }
  }

  onServerError(message: string): void {
    this.panel.log(`server error: ${message}`)
  }

  onMessageError(error: Error): void {
    this.panel.log(`message error: ${error.message}`)
  }

  onFrame(renderDeltaMs: number, connected: boolean): void {
    this.updateFps(renderDeltaMs)
    this.updateNetworkStats(renderDeltaMs, connected)
  }

  onPredictionMetrics(metrics: PredictionMetrics): void {
    this.panel.setPredictionMetrics(metrics)
  }

  onGameplayReset(connected: boolean, localPlayerId: number | null): void {
    this.panel.setServerTick(null)
    this.panel.setPredictionMetrics(null)
    this.panel.resetStateIntervalChart()
    this.panel.resetLossChart()
    this.setRestartEnabled(connected && localPlayerId !== null)
  }

  setRestartEnabled(enabled: boolean): void {
    this.panel.setRestartEnabled(enabled)
  }

  logSendFailure(kind: 'input' | 'ping', error: unknown, connected: boolean): void {
    if (connected) {
      this.panel.log(`${kind} failed: ${String(error)}`)
    }
  }

  private updateFps(renderDeltaMs: number): void {
    this.fpsElapsedMs += renderDeltaMs
    this.fpsFrameCount += 1

    if (this.fpsElapsedMs < FPS_SAMPLE_MS) {
      return
    }

    this.panel.setFps((this.fpsFrameCount * 1000) / this.fpsElapsedMs)
    this.fpsElapsedMs = 0
    this.fpsFrameCount = 0
  }

  private updateNetworkStats(renderDeltaMs: number, connected: boolean): void {
    if (!connected || !this.previousNetworkCounters) {
      return
    }

    this.networkStatsElapsedMs += renderDeltaMs
    if (this.networkStatsElapsedMs < NETWORK_STATS_SAMPLE_MS) {
      return
    }

    const current = this.options.getTransportStats()
    const sampleSeconds = this.networkStatsElapsedMs / 1000
    this.panel.setNetworkStats({
      rxMessages: current.rxMessages,
      txMessages: current.txMessages,
      rxMessagesPerSec: (current.rxMessages - this.previousNetworkCounters.rxMessages) / sampleSeconds,
      txMessagesPerSec: (current.txMessages - this.previousNetworkCounters.txMessages) / sampleSeconds,
      rxBytesPerSec: (current.rxBytes - this.previousNetworkCounters.rxBytes) / sampleSeconds,
      txBytesPerSec: (current.txBytes - this.previousNetworkCounters.txBytes) / sampleSeconds,
    })

    this.previousNetworkCounters = current
    this.networkStatsElapsedMs = 0
  }

  private resetNetworkStatsSample(): void {
    this.previousNetworkCounters = this.options.getTransportStats()
    this.networkStatsElapsedMs = 0
    this.panel.setNetworkStats({
      rxMessages: this.previousNetworkCounters.rxMessages,
      txMessages: this.previousNetworkCounters.txMessages,
      rxMessagesPerSec: 0,
      txMessagesPerSec: 0,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
    })
  }
}
