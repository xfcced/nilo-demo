import { GameLoop } from '../engine/GameLoop'
import { KeyboardInput, type MovementDirection } from '../engine/KeyboardInput'
import type { TransportCounters } from '../engine/WebTransportClient'
import { type AppElements, getAppElements } from './appElements'
import { ArenaScene } from './ArenaScene'
import { defaultWebTransportUrl, FIXED_STEP_MS, gameConfig } from './config'
import { GameConnection } from './net/GameConnection'
import type { ServerMessage } from './net/protocol'
import { LocalPlayerPredictor } from './sync/LocalPlayerPredictor'
import { SnapshotInterpolator } from './sync/SnapshotInterpolator'
import { DebugPanel, type DebugOptions } from './ui/DebugPanel'

const PING_SEND_MS = 1000
const FPS_SAMPLE_MS = 500
const NETWORK_STATS_SAMPLE_MS = 1000

export class GameClientApp {
  private debugPanel = new DebugPanel()
  private arena: ArenaScene
  private input = new KeyboardInput()
  private serverConnection = new GameConnection()
  private interpolator = new SnapshotInterpolator()
  private localPlayerPredictor = new LocalPlayerPredictor()
  private debugOptions: DebugOptions = this.debugPanel.debugOptions()
  private gameLoop: GameLoop

  private localPredictionTick: number | null = null
  private inputSeq = 0
  private localPlayerId: number | null = null
  private connected = false
  private pingElapsedMs = PING_SEND_MS
  private pingSeq = 0
  private pendingPings = new Map<number, number>()
  private fpsElapsedMs = 0
  private fpsFrameCount = 0
  private networkStatsElapsedMs = 0
  private previousNetworkCounters: TransportCounters | null = null

  constructor(private elements: AppElements = getAppElements()) {
    this.elements.urlInput.value = defaultWebTransportUrl()
    this.applyBuildDefaults()
    this.arena = new ArenaScene(elements.canvas)
    this.gameLoop = new GameLoop({
      fixedStepMs: FIXED_STEP_MS,
      maxFrameMs: gameConfig.simulation.maxFrameMs,
      fixedUpdate: () => this.fixedUpdate(),
      drawFrame: (renderDeltaMs, fixedStepAlpha) => this.render(renderDeltaMs, fixedStepAlpha),
    })
  }

  private applyBuildDefaults(): void {
    const webTransportUrl = import.meta.env.VITE_WEBTRANSPORT_URL?.trim()
    if (webTransportUrl) {
      this.elements.urlInput.value = webTransportUrl
    }

    if ('VITE_CERTIFICATE_HASH' in import.meta.env) {
      this.elements.hashInput.value = import.meta.env.VITE_CERTIFICATE_HASH.trim()
    }
  }

  start(): void {
    this.bindConnectionEvents()
    this.bindUiEvents()
    this.gameLoop.start()
    this.debugPanel.setConnection('disconnected')
    this.debugPanel.setFps(null)
    this.debugPanel.setNetworkStats(null)
    this.debugPanel.setPredictionMetrics(null)
    this.debugPanel.resetStateIntervalChart()
  }

  private bindConnectionEvents(): void {
    this.serverConnection.onMessage((message) => {
      if (message.type === 'welcome') {
        this.localPlayerId = message.playerId
        this.arena.setLocalPlayerId(message.playerId)
        this.debugPanel.setPlayerId(message.playerId)
        this.debugPanel.setRestartEnabled(this.connected)
        this.debugPanel.log(`joined as player ${message.playerId}`)
        return
      }

      if (message.type === 'restarted') {
        this.resetGameplayState()
        this.debugPanel.log('game restarted')
        return
      }

      if (message.type === 'pong') {
        const sentAt = this.pendingPings.get(message.pingSeq)
        if (sentAt !== undefined) {
          this.pendingPings.delete(message.pingSeq)
          this.debugPanel.setRtt(performance.now() - sentAt)
        } else {
          this.debugPanel.log(`ignored pong for unknown ping ${message.pingSeq}`)
        }
        return
      }

      if (message.type === 'state') {
        const receivedAtMs = performance.now()
        if (!this.interpolator.pushSnapshot(message, receivedAtMs)) {
          return
        }

        this.debugPanel.setServerTick(message.serverTick)
        this.debugPanel.recordStateReceived(receivedAtMs)
        this.debugPanel.recordLossSample(message.serverTick, message.lastReceivedInputSeq)
        this.reconcileLocalPlayer(message)
        return
      }

      this.debugPanel.log(`server error: ${message.message}`)
    })

    this.serverConnection.onClose((reason) => {
      this.resetSessionState()
      this.debugPanel.setConnection('disconnected')
      this.debugPanel.log(`connection closed: ${reason}`)
      this.setButtons(false)
    })

    this.serverConnection.onError((error) => {
      this.debugPanel.log(`message error: ${error.message}`)
    })
  }

  private bindUiEvents(): void {
    this.elements.connectButton.addEventListener('click', () => {
      void this.connect()
    })

    this.elements.disconnectButton.addEventListener('click', () => {
      void this.disconnect()
    })

    this.debugPanel.onRestart(() => {
      void this.restart()
    })

    this.debugPanel.onDebugOptionsChanged((options) => {
      this.debugOptions = options
      if (!options.predictionDebug) {
        this.arena.clearLocalPredictionDebug()
      }
      if (!options.interpolationDebug) {
        this.arena.clearInterpolationDebug()
      }
    })

    this.bindMovementControls()
  }

  private bindMovementControls(): void {
    this.elements.movementButtons.forEach((button) => {
      const direction = button.dataset.movementDirection as MovementDirection | undefined
      if (!isMovementDirection(direction)) {
        return
      }

      const activePointers = new Set<number>()
      const releasePointer = (event: PointerEvent): void => {
        activePointers.delete(event.pointerId)
        if (activePointers.size === 0) {
          this.input.setVirtualDirection(direction, false)
        }
      }

      button.addEventListener('pointerdown', (event) => {
        activePointers.add(event.pointerId)
        button.setPointerCapture(event.pointerId)
        this.input.setVirtualDirection(direction, true)
        event.preventDefault()
      })

      button.addEventListener('pointerup', releasePointer)
      button.addEventListener('pointercancel', releasePointer)
      button.addEventListener('lostpointercapture', releasePointer)
      button.addEventListener('contextmenu', (event) => event.preventDefault())
    })
  }

  private async connect(): Promise<void> {
    try {
      this.debugPanel.setConnection('connecting')
      this.setButtons(false)
      this.debugPanel.log('connecting...')

      await this.serverConnection.connect(this.elements.urlInput.value.trim(), this.elements.hashInput.value.trim())
      this.resetNetworkStatsSample()
      await this.serverConnection.send({ type: 'join' })

      this.connected = true
      this.localPredictionTick = null
      this.inputSeq = 0
      this.pingElapsedMs = PING_SEND_MS
      this.debugPanel.setConnection('connected')
      this.debugPanel.resetStateIntervalChart()
      this.debugPanel.resetLossChart()
      this.setButtons(true)
    } catch (error) {
      this.connected = false
      this.debugPanel.setConnection('disconnected')
      this.debugPanel.log(`connect failed: ${String(error)}`)
      this.previousNetworkCounters = null
      this.networkStatsElapsedMs = 0
      this.setButtons(false)
    }
  }

  private async disconnect(): Promise<void> {
    await this.serverConnection.close()
    this.resetSessionState()
    this.debugPanel.setConnection('disconnected')
    this.debugPanel.setPlayerId(null)
    this.debugPanel.setRtt(null)
    this.setButtons(false)
  }

  private async restart(): Promise<void> {
    if (!this.connected || this.localPlayerId === null) {
      return
    }

    this.debugPanel.setRestartEnabled(false)
    try {
      await this.serverConnection.send({ type: 'restart' })
    } catch (error) {
      if (this.connected) {
        this.debugPanel.log(`restart failed: ${String(error)}`)
      }
      this.debugPanel.setRestartEnabled(true)
    }
  }

  private fixedUpdate(): void {
    if (!this.connected || this.localPlayerId === null) {
      return
    }

    this.pingElapsedMs += FIXED_STEP_MS

    if (this.localPredictionTick !== null) {
      this.sendInput()
    }

    if (this.pingElapsedMs >= PING_SEND_MS) {
      this.pingElapsedMs -= PING_SEND_MS
      this.sendPing()
    }
  }

  private render(renderDeltaMs: number, fixedStepAlpha: number): void {
    this.updateFps(renderDeltaMs)
    this.updateNetworkStats(renderDeltaMs)
    const renderDeltaSeconds = renderDeltaMs / 1000
    const localPlayer = this.localPlayerId === null ? null : this.localPlayerPredictor.renderPlayer(this.localPlayerId, fixedStepAlpha, renderDeltaSeconds)
    const renderState = this.interpolator.sample(performance.now(), this.localPlayerId, localPlayer)
    this.arena.setLocalPredictionDebug(this.debugOptions.predictionDebug && localPlayer ? this.localPlayerPredictor.debugState() : null)
    this.arena.setInterpolationDebug(this.debugOptions.interpolationDebug ? this.interpolator.debugSamples(this.localPlayerId) : null)
    this.arena.applyRenderState(renderState)
    this.arena.render()
  }

  private updateFps(renderDeltaMs: number): void {
    this.fpsElapsedMs += renderDeltaMs
    this.fpsFrameCount += 1

    if (this.fpsElapsedMs < FPS_SAMPLE_MS) {
      return
    }

    this.debugPanel.setFps((this.fpsFrameCount * 1000) / this.fpsElapsedMs)
    this.fpsElapsedMs = 0
    this.fpsFrameCount = 0
  }

  private updateNetworkStats(renderDeltaMs: number): void {
    if (!this.connected || !this.previousNetworkCounters) {
      return
    }

    this.networkStatsElapsedMs += renderDeltaMs
    if (this.networkStatsElapsedMs < NETWORK_STATS_SAMPLE_MS) {
      return
    }

    const current = this.serverConnection.getStats()
    const sampleSeconds = this.networkStatsElapsedMs / 1000
    this.debugPanel.setNetworkStats({
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
    this.previousNetworkCounters = this.serverConnection.getStats()
    this.networkStatsElapsedMs = 0
    this.debugPanel.setNetworkStats({
      rxMessages: this.previousNetworkCounters.rxMessages,
      txMessages: this.previousNetworkCounters.txMessages,
      rxMessagesPerSec: 0,
      txMessagesPerSec: 0,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
    })
  }

  private sendPing(): void {
    this.pingSeq += 1
    const pingSeq = this.pingSeq
    this.pendingPings.set(pingSeq, performance.now())

    void this.serverConnection.send({ type: 'ping', pingSeq }).catch((error: unknown) => {
      this.pendingPings.delete(pingSeq)
      if (this.connected) {
        this.debugPanel.log(`ping failed: ${String(error)}`)
      }
    })
  }

  private sendInput(): void {
    if (this.localPredictionTick === null) {
      return
    }

    this.localPredictionTick += 1
    const movement = this.input.currentMovement()
    this.localPlayerPredictor.pushLocalInput(this.localPredictionTick, movement)
    this.debugPanel.setPredictionMetrics(this.localPlayerPredictor.metrics())

    void this.serverConnection
      .send({
        type: 'input',
        inputSeq: ++this.inputSeq,
        ...movement,
      })
      .catch((error: unknown) => {
        if (this.connected) {
          this.debugPanel.log(`input failed: ${String(error)}`)
        }
      })
  }

  private reconcileLocalPlayer(message: Extract<ServerMessage, { type: 'state' }>): void {
    if (this.localPlayerId === null) {
      return
    }

    const authoritativePlayer = message.players.find((player) => player.playerId === this.localPlayerId)
    if (!authoritativePlayer) {
      return
    }

    if (this.localPredictionTick === null) {
      this.localPredictionTick = message.serverTick
    } else {
      this.localPredictionTick = Math.max(this.localPredictionTick, message.serverTick)
    }

    this.localPlayerPredictor.reconcile(authoritativePlayer, message.serverTick, message.lastReceivedInputSeq)
    this.debugPanel.setPredictionMetrics(this.localPlayerPredictor.metrics())
  }

  private resetSessionState(): void {
    this.connected = false
    this.localPlayerId = null
    this.inputSeq = 0
    this.resetGameplayState()
  }

  private resetGameplayState(): void {
    this.localPredictionTick = null
    this.pingSeq = 0
    this.pendingPings.clear()
    this.pingElapsedMs = PING_SEND_MS
    this.arena.setLocalPlayerId(this.localPlayerId)
    this.arena.clearPlayers()
    this.arena.clearBoxes()
    this.arena.clearLocalPredictionDebug()
    this.arena.clearInterpolationDebug()
    this.interpolator.reset()
    this.localPlayerPredictor.reset()
    this.debugPanel.setServerTick(null)
    this.debugPanel.setPredictionMetrics(null)
    this.debugPanel.resetStateIntervalChart()
    this.debugPanel.resetLossChart()
    this.debugPanel.setRestartEnabled(this.connected && this.localPlayerId !== null)
  }

  private setButtons(connected: boolean): void {
    this.elements.connectButton.disabled = connected
    this.elements.disconnectButton.disabled = !connected
    this.debugPanel.setRestartEnabled(connected && this.localPlayerId !== null)
  }
}

function isMovementDirection(direction: string | undefined): direction is MovementDirection {
  return direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right'
}
