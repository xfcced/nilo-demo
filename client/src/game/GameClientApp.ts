import { GameLoop } from '../engine/GameLoop'
import { KeyboardInput } from '../engine/KeyboardInput'
import { type AppElements, getAppElements } from './appElements'
import { ArenaScene } from './ArenaScene'
import { GameConnection } from './net/GameConnection'
import { DebugPanel } from './ui/DebugPanel'

const FIXED_STEP_MS = 1000 / 60
const MAX_FRAME_MS = 250
const PING_SEND_MS = 1000
const FPS_SAMPLE_MS = 500

export class GameClientApp {
  private debugPanel = new DebugPanel()
  private arena: ArenaScene
  private input = new KeyboardInput()
  private serverConnection = new GameConnection()
  private gameLoop: GameLoop

  private inputSeq = 0
  private localPlayerId: number | null = null
  private connected = false
  private pingElapsedMs = PING_SEND_MS
  private fpsElapsedMs = 0
  private fpsFrameCount = 0

  constructor(private elements: AppElements = getAppElements()) {
    this.arena = new ArenaScene(elements.canvas)
    this.gameLoop = new GameLoop({
      fixedStepMs: FIXED_STEP_MS,
      maxFrameMs: MAX_FRAME_MS,
      update: (deltaMs) => this.fixedUpdate(deltaMs),
      drawFrame: (frameMs) => this.render(frameMs),
    })
  }

  start(): void {
    this.bindConnectionEvents()
    this.bindUiEvents()
    this.gameLoop.start()
    this.debugPanel.setConnection('disconnected')
    this.debugPanel.setFps(null)
  }

  private bindConnectionEvents(): void {
    this.serverConnection.onMessage((message) => {
      if (message.type === 'welcome') {
        this.localPlayerId = message.playerId
        this.arena.setLocalPlayerId(message.playerId)
        this.debugPanel.setPlayerId(message.playerId)
        this.debugPanel.setServerTime(message.serverTime)
        this.debugPanel.log(`joined as player ${message.playerId}`)
        return
      }

      if (message.type === 'pong') {
        const now = performance.now()
        this.debugPanel.setRtt(now - message.clientTime)
        this.debugPanel.setServerTime(message.serverTime)
        return
      }

      if (message.type === 'state') {
        this.debugPanel.setServerTime(message.serverTime)
        this.arena.setPlayers(message.players)
        this.arena.setBoxes(message.boxes)
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
  }

  private async connect(): Promise<void> {
    try {
      this.debugPanel.setConnection('connecting')
      this.setButtons(false)
      this.debugPanel.log('connecting...')

      await this.serverConnection.connect(this.elements.urlInput.value.trim(), this.elements.hashInput.value.trim())
      await this.serverConnection.send({ type: 'join' })

      this.connected = true
      this.inputSeq = 0
      this.pingElapsedMs = PING_SEND_MS
      this.debugPanel.setConnection('connected')
      this.setButtons(true)
    } catch (error) {
      this.connected = false
      this.debugPanel.setConnection('disconnected')
      this.debugPanel.log(`connect failed: ${String(error)}`)
      this.setButtons(false)
    }
  }

  private async disconnect(): Promise<void> {
    await this.serverConnection.close()
    this.resetSessionState()
    this.debugPanel.setConnection('disconnected')
    this.debugPanel.setPlayerId(null)
    this.debugPanel.setRtt(null)
    this.debugPanel.setServerTime(null)
    this.setButtons(false)
  }

  // physics update
  private fixedUpdate(deltaMs: number): void {
    this.arena.update(deltaMs / 1000)

    if (!this.connected || this.localPlayerId === null) {
      return
    }

    this.pingElapsedMs += deltaMs

    this.sendInput()

    if (this.pingElapsedMs >= PING_SEND_MS) {
      this.pingElapsedMs -= PING_SEND_MS
      this.sendPing()
    }
  }

  private render(frameMs: number): void {
    this.updateFps(frameMs)
    this.arena.render()
  }

  private updateFps(frameMs: number): void {
    this.fpsElapsedMs += frameMs
    this.fpsFrameCount += 1

    if (this.fpsElapsedMs < FPS_SAMPLE_MS) {
      return
    }

    this.debugPanel.setFps((this.fpsFrameCount * 1000) / this.fpsElapsedMs)
    this.fpsElapsedMs = 0
    this.fpsFrameCount = 0
  }

  private sendPing(): void {
    void this.serverConnection.send({ type: 'ping', clientTime: performance.now() }).catch((error: unknown) => {
      if (this.connected) {
        this.debugPanel.log(`ping failed: ${String(error)}`)
      }
    })
  }

  private sendInput(): void {
    this.inputSeq += 1
    const movement = this.input.currentMovement()

    void this.serverConnection
      .send({
        type: 'input',
        seq: this.inputSeq,
        ...movement,
      })
      .catch((error: unknown) => {
        if (this.connected) {
          this.debugPanel.log(`input failed: ${String(error)}`)
        }
      })
  }

  private resetSessionState(): void {
    this.connected = false
    this.localPlayerId = null
    this.inputSeq = 0
    this.pingElapsedMs = PING_SEND_MS
    this.arena.setLocalPlayerId(null)
    this.arena.clearPlayers()
    this.arena.clearBoxes()
  }

  private setButtons(connected: boolean): void {
    this.elements.connectButton.disabled = connected
    this.elements.disconnectButton.disabled = !connected
  }
}
