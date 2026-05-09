export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

type DebugPanelElements = {
  connectionValue: HTMLElement
  playerIdValue: HTMLElement
  rttValue: HTMLElement
  serverTimeValue: HTMLElement
  log: HTMLPreElement
}

export class DebugPanel {
  private elements: DebugPanelElements

  constructor() {
    this.elements = {
      connectionValue: getElement('connectionValue'),
      playerIdValue: getElement('playerIdValue'),
      rttValue: getElement('rttValue'),
      serverTimeValue: getElement('serverTimeValue'),
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

  setServerTime(serverTime: number | null): void {
    this.elements.serverTimeValue.textContent =
      serverTime === null ? '-' : new Date(serverTime).toLocaleTimeString()
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
