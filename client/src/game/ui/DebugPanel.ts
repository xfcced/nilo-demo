export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

type DebugPanelElements = {
  connectionValue: HTMLElement
  playerIdValue: HTMLElement
  rttValue: HTMLElement
  fpsValue: HTMLElement
  serverTickValue: HTMLElement
  log: HTMLPreElement
}

export class DebugPanel {
  private elements: DebugPanelElements

  constructor() {
    this.elements = {
      connectionValue: getElement('connectionValue'),
      playerIdValue: getElement('playerIdValue'),
      rttValue: getElement('rttValue'),
      fpsValue: getElement('fpsValue'),
      serverTickValue: getElement('serverTickValue'),
      log: getElement('log'),
    }
  }

  setConnection(state: ConnectionState): void {
    this.elements.connectionValue.textContent = state
    this.elements.connectionValue.dataset.state = state
  }

  setPlayerId(playerId: number | null): void {
    this.elements.playerIdValue.textContent = playerId === null ? '-' : String(playerId)
  }

  setRtt(rttMs: number | null): void {
    this.elements.rttValue.textContent = rttMs === null ? '-' : `${Math.round(rttMs)} ms`
  }

  setFps(fps: number | null): void {
    this.elements.fpsValue.textContent = fps === null ? '-' : `${Math.round(fps)}`
  }

  setServerTick(serverTick: number | null): void {
    this.elements.serverTickValue.textContent = serverTick === null ? '-' : String(serverTick)
  }

  log(message: string): void {
    const time = new Date().toLocaleTimeString()
    this.elements.log.textContent += `[${time}] ${message}\n`
    this.elements.log.scrollTop = this.elements.log.scrollHeight
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing element #${id}`)
  }
  return element as T
}
