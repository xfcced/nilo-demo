import { GameLoop } from '../engine/GameLoop'
import { KeyboardInput, type MovementDirection } from '../engine/KeyboardInput'
import { type AppElements, getAppElements } from './appElements'
import { ArenaScene } from './ArenaScene'
import { defaultWebTransportUrl, FIXED_STEP_MS, gameConfig } from './config'
import { DebugTelemetry, type DebugOptions } from './debug/DebugTelemetry'
import { GameConnection } from './net/GameConnection'
import { StateSynchronizer } from './sync/StateSynchronizer'

const PING_SEND_MS = 1000

export class GameClientApp {
  private arena: ArenaScene
  private input = new KeyboardInput()
  private serverConnection = new GameConnection()
  private stateSync = new StateSynchronizer()
  private debug = new DebugTelemetry({
    getTransportStats: () => this.serverConnection.getStats(),
  })
  private debugOptions: DebugOptions = this.debug.debugOptions()
  private gameLoop: GameLoop

  private inputSeq = 0
  private localPlayerId: number | null = null
  private connected = false
  private pingElapsedMs = PING_SEND_MS
  private pingSeq = 0
  private pendingPings = new Map<number, number>()

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
    this.debug.start()
  }

  private bindConnectionEvents(): void {
    this.serverConnection.onMessage((message) => {
      if (message.type === 'welcome') {
        this.localPlayerId = message.playerId
        this.arena.setLocalPlayerId(message.playerId)
        this.debug.onWelcome(message.playerId, this.connected)
        return
      }

      if (message.type === 'restarted') {
        this.resetGameplayState()
        this.debug.onRestarted()
        return
      }

      if (message.type === 'pong') {
        const sentAt = this.pendingPings.get(message.pingSeq)
        if (sentAt !== undefined) {
          this.pendingPings.delete(message.pingSeq)
          this.debug.onPong(performance.now() - sentAt)
        } else {
          this.debug.onUnknownPong(message.pingSeq)
        }
        return
      }

      if (message.type === 'state') {
        const receivedAtMs = performance.now()
        const result = this.stateSync.pushServerSnapshot(message, receivedAtMs, this.localPlayerId)
        if (!result.accepted) {
          return
        }

        this.debug.onStateAccepted(message, result.predictionMetrics, receivedAtMs)
        return
      }

      this.debug.onServerError(message.message)
    })

    this.serverConnection.onClose((reason) => {
      this.resetSessionState()
      this.debug.onDisconnected(reason)
      this.setButtons(false)
    })

    this.serverConnection.onError((error) => {
      this.debug.onMessageError(error)
    })
  }

  private render(renderDeltaMs: number, fixedStepAlpha: number): void {
    this.debug.onFrame(renderDeltaMs, this.connected)
    const nowMs = performance.now()
    const renderDeltaSeconds = renderDeltaMs / 1000
    const renderState = this.stateSync.sampleRenderState(nowMs, this.localPlayerId, fixedStepAlpha, renderDeltaSeconds)
    this.arena.setLocalPredictionDebug(this.debugOptions.predictionDebug ? this.stateSync.localPredictionDebugState() : null)
    this.arena.setInterpolationDebug(this.debugOptions.interpolationDebug ? this.stateSync.interpolationDebugSamples(this.localPlayerId) : null)
    this.arena.applyRenderState(renderState)
    this.arena.render()
  }

  private fixedUpdate(): void {
    if (!this.connected || this.localPlayerId === null) {
      return
    }

    this.pingElapsedMs += FIXED_STEP_MS

    if (this.stateSync.canPredictLocalInput()) {
      this.sendInput()
    }

    if (this.pingElapsedMs >= PING_SEND_MS) {
      this.pingElapsedMs -= PING_SEND_MS
      this.sendPing()
    }
  }

  private bindUiEvents(): void {
    this.elements.connectButton.addEventListener('click', () => {
      void this.connect()
    })

    this.elements.disconnectButton.addEventListener('click', () => {
      void this.disconnect()
    })

    this.debug.onRestart(() => {
      void this.restart()
    })

    this.debug.onDebugOptionsChanged((options) => {
      this.debugOptions = options
      this.stateSync.setModes(options.syncModes)
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
      this.debug.onConnectStart()
      this.setButtons(false)

      await this.serverConnection.connect(this.elements.urlInput.value.trim(), this.elements.hashInput.value.trim())
      await this.serverConnection.send({ type: 'join' })

      this.connected = true
      this.inputSeq = 0
      this.pingElapsedMs = PING_SEND_MS
      this.debug.onConnected()
      this.setButtons(true)
    } catch (error) {
      this.connected = false
      this.debug.onConnectFailed(error)
      this.setButtons(false)
    }
  }

  private async disconnect(): Promise<void> {
    await this.serverConnection.close()
    this.resetSessionState()
    this.debug.onManualDisconnect()
    this.setButtons(false)
  }

  private async restart(): Promise<void> {
    if (!this.connected || this.localPlayerId === null) {
      return
    }

    this.debug.setRestartEnabled(false)
    try {
      await this.serverConnection.send({ type: 'restart' })
    } catch (error) {
      this.debug.onRestartFailed(error, this.connected)
    }
  }

  private sendPing(): void {
    this.pingSeq += 1
    const pingSeq = this.pingSeq
    this.pendingPings.set(pingSeq, performance.now())

    void this.serverConnection.send({ type: 'ping', pingSeq }).catch((error: unknown) => {
      this.pendingPings.delete(pingSeq)
      this.debug.logSendFailure('ping', error, this.connected)
    })
  }

  private sendInput(): void {
    if (!this.stateSync.canPredictLocalInput()) {
      return
    }

    const movement = this.input.currentMovement()
    this.debug.onPredictionMetrics(this.stateSync.pushLocalInput(movement))

    void this.serverConnection
      .send({
        type: 'input',
        inputSeq: ++this.inputSeq,
        ...movement,
      })
      .catch((error: unknown) => {
        this.debug.logSendFailure('input', error, this.connected)
      })
  }

  private resetSessionState(): void {
    this.connected = false
    this.localPlayerId = null
    this.inputSeq = 0
    this.resetGameplayState()
  }

  private resetGameplayState(): void {
    this.pingSeq = 0
    this.pendingPings.clear()
    this.pingElapsedMs = PING_SEND_MS
    this.arena.setLocalPlayerId(this.localPlayerId)
    this.arena.clearPlayers()
    this.arena.clearBoxes()
    this.arena.clearLocalPredictionDebug()
    this.arena.clearInterpolationDebug()
    this.stateSync.reset()
    this.debug.onGameplayReset(this.connected, this.localPlayerId)
  }

  private setButtons(connected: boolean): void {
    this.elements.connectButton.disabled = connected
    this.elements.disconnectButton.disabled = !connected
    this.debug.setRestartEnabled(connected && this.localPlayerId !== null)
  }
}

function isMovementDirection(direction: string | undefined): direction is MovementDirection {
  return direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right'
}
