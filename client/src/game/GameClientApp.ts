import { GameLoop } from '../engine/GameLoop'
import { KeyboardInput } from '../engine/KeyboardInput'
import { type AppElements, getAppElements } from './appElements'
import { ArenaScene } from './ArenaScene'
import { GameProtocolClient } from './GameProtocolClient'
import { DebugPanel } from './ui/DebugPanel'

const FIXED_STEP_MS = 1000 / 60
const MAX_FRAME_MS = 250
const PING_SEND_MS = 1000

export class GameClientApp {
  private debugPanel = new DebugPanel()
  private arena: ArenaScene
  private input = new KeyboardInput()
  private transport = new GameProtocolClient()
  private gameLoop: GameLoop

  private inputSeq = 0
  private localPlayerId: number | null = null
  private connected = false
  private pingElapsedMs = PING_SEND_MS

  constructor(private elements: AppElements = getAppElements()) {
    this.arena = new ArenaScene(elements.canvas)
    this.gameLoop = new GameLoop({
      fixedStepMs: FIXED_STEP_MS,
      maxFrameMs: MAX_FRAME_MS,
      update: (deltaMs) => this.fixedUpdate(deltaMs),
      render: () => this.arena.render(),
    })
  }

  start(): void {
    this.bindTransportEvents()
    this.bindUiEvents()
    this.gameLoop.start()
    this.debugPanel.setConnection('disconnected')
  }

  private bindTransportEvents(): void {
    this.transport.onMessage((message) => {
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
        return
      }

      this.debugPanel.log(`server error: ${message.message}`)
    })

    this.transport.onClose((reason) => {
      this.resetSessionState()
      this.debugPanel.setConnection('disconnected')
      this.debugPanel.log(`connection closed: ${reason}`)
      this.setButtons(false)
    })

    this.transport.onError((error) => {
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

      await this.transport.connect(
        this.elements.urlInput.value.trim(),
        this.elements.hashInput.value.trim()
      )
      await this.transport.send({ type: 'join' })

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
    await this.transport.close()
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

  private sendPing(): void {
    void this.transport.send({ type: 'ping', clientTime: performance.now() }).catch((error: unknown) => {
      if (this.connected) {
        this.debugPanel.log(`ping failed: ${String(error)}`)
      }
    })
  }

  private sendInput(): void {
    this.inputSeq += 1
    const movement = this.input.currentMovement()

    void this.transport
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
  }

  private setButtons(connected: boolean): void {
    this.elements.connectButton.disabled = connected
    this.elements.disconnectButton.disabled = !connected
  }
}
