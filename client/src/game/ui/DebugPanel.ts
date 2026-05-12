export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export type NetworkStats = {
  rxMessages: number
  txMessages: number
  rxMessagesPerSec: number
  txMessagesPerSec: number
  rxBytesPerSec: number
  txBytesPerSec: number
}

export type PredictionMetrics = {
  pendingInputCount: number
  lastAckedInputSeq: number
  predictionError: number
  correctionCount: number
}

type DebugPanelElements = {
  panel: HTMLElement
  toggleButton: HTMLButtonElement
  connectionValue: HTMLElement
  playerIdValue: HTMLElement
  rttValue: HTMLElement
  fpsValue: HTMLElement
  serverTickValue: HTMLElement
  rxMessageValue: HTMLElement
  txMessageValue: HTMLElement
  downloadValue: HTMLElement
  uploadValue: HTMLElement
  pendingInputValue: HTMLElement
  ackSeqValue: HTMLElement
  predictionErrorValue: HTMLElement
  correctionValue: HTMLElement
  log: HTMLPreElement
}

export class DebugPanel {
  private elements: DebugPanelElements
  private visible = true

  constructor() {
    this.elements = {
      panel: getElement('debugPanel'),
      toggleButton: getElement('debugToggle'),
      connectionValue: getElement('connectionValue'),
      playerIdValue: getElement('playerIdValue'),
      rttValue: getElement('rttValue'),
      fpsValue: getElement('fpsValue'),
      serverTickValue: getElement('serverTickValue'),
      rxMessageValue: getElement('rxMessageValue'),
      txMessageValue: getElement('txMessageValue'),
      downloadValue: getElement('downloadValue'),
      uploadValue: getElement('uploadValue'),
      pendingInputValue: getElement('pendingInputValue'),
      ackSeqValue: getElement('ackSeqValue'),
      predictionErrorValue: getElement('predictionErrorValue'),
      correctionValue: getElement('correctionValue'),
      log: getElement('log'),
    }

    this.elements.toggleButton.addEventListener('click', () => {
      this.setVisible(!this.visible)
    })
  }

  private setVisible(visible: boolean): void {
    this.visible = visible
    this.elements.panel.hidden = !visible
    this.elements.toggleButton.textContent = visible ? 'Hide Dev' : 'Show Dev'
    this.elements.toggleButton.setAttribute('aria-expanded', String(visible))
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

  setNetworkStats(stats: NetworkStats | null): void {
    if (!stats) {
      this.elements.rxMessageValue.textContent = '-'
      this.elements.txMessageValue.textContent = '-'
      this.elements.downloadValue.textContent = '-'
      this.elements.uploadValue.textContent = '-'
      return
    }

    this.elements.rxMessageValue.textContent = `${stats.rxMessages} (${formatRate(stats.rxMessagesPerSec)})`
    this.elements.txMessageValue.textContent = `${stats.txMessages} (${formatRate(stats.txMessagesPerSec)})`
    this.elements.downloadValue.textContent = formatBytesPerSec(stats.rxBytesPerSec)
    this.elements.uploadValue.textContent = formatBytesPerSec(stats.txBytesPerSec)
  }

  setPredictionMetrics(metrics: PredictionMetrics | null): void {
    if (!metrics) {
      this.elements.pendingInputValue.textContent = '-'
      this.elements.ackSeqValue.textContent = '-'
      this.elements.predictionErrorValue.textContent = '-'
      this.elements.correctionValue.textContent = '-'
      return
    }

    this.elements.pendingInputValue.textContent = String(metrics.pendingInputCount)
    this.elements.ackSeqValue.textContent = String(metrics.lastAckedInputSeq)
    this.elements.predictionErrorValue.textContent = `${(metrics.predictionError * 100).toFixed(1)} cm`
    this.elements.correctionValue.textContent = String(metrics.correctionCount)
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

function formatRate(value: number): string {
  return `${Math.round(value)}/s`
}

function formatBytesPerSec(bytesPerSec: number): string {
  if (bytesPerSec < 1024) {
    return `${Math.round(bytesPerSec)} B/s`
  }

  const kbPerSec = bytesPerSec / 1024
  if (kbPerSec < 1024) {
    return `${kbPerSec.toFixed(1)} KB/s`
  }

  return `${(kbPerSec / 1024).toFixed(1)} MB/s`
}
