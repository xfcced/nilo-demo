import { gameConfig } from '../config'

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

const STATE_INTERVAL_SAMPLE_COUNT = 120
const STATE_INTERVAL_CHART_MAX_MS = 120

type DebugPanelElements = {
  panel: HTMLElement
  toggleButton: HTMLButtonElement
  restartButton: HTMLButtonElement
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
  stateIntervalValue: HTMLElement
  stateIntervalChart: HTMLCanvasElement
}

export class DebugPanel {
  private elements: DebugPanelElements
  private visible = true
  private lastStateReceivedAtMs: number | null = null
  private stateIntervalSamples: number[] = []

  constructor() {
    this.elements = {
      panel: getElement('debugPanel'),
      toggleButton: getElement('debugToggle'),
      restartButton: getElement('restartButton'),
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
      stateIntervalValue: getElement('stateIntervalValue'),
      stateIntervalChart: getElement('stateIntervalChart'),
    }

    this.elements.toggleButton.addEventListener('click', () => {
      this.setVisible(!this.visible)
    })

    this.drawStateIntervalChart()
  }

  onRestart(handler: () => void): void {
    this.elements.restartButton.addEventListener('click', handler)
  }

  setRestartEnabled(enabled: boolean): void {
    this.elements.restartButton.disabled = !enabled
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

  recordStateReceived(receivedAtMs: number): void {
    if (this.lastStateReceivedAtMs !== null) {
      const intervalMs = receivedAtMs - this.lastStateReceivedAtMs
      this.stateIntervalSamples.push(intervalMs)
      if (this.stateIntervalSamples.length > STATE_INTERVAL_SAMPLE_COUNT) {
        this.stateIntervalSamples.shift()
      }
      this.elements.stateIntervalValue.textContent = `${intervalMs.toFixed(1)} ms`
      this.drawStateIntervalChart()
    }

    this.lastStateReceivedAtMs = receivedAtMs
  }

  resetStateIntervalChart(): void {
    this.lastStateReceivedAtMs = null
    this.stateIntervalSamples = []
    this.elements.stateIntervalValue.textContent = '-'
    this.drawStateIntervalChart()
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

  private drawStateIntervalChart(): void {
    const canvas = this.elements.stateIntervalChart
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width * pixelRatio))
    const height = Math.max(1, Math.round(rect.height * pixelRatio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    context.clearRect(0, 0, width, height)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)

    const paddingX = 6 * pixelRatio
    const paddingY = 5 * pixelRatio
    const chartWidth = width - paddingX * 2
    const chartHeight = height - paddingY * 2
    const expectedMs = 1000 / gameConfig.simulation.tickRate
    const expectedY = valueToY(expectedMs, chartHeight, paddingY)

    context.strokeStyle = '#d0d0d0'
    context.lineWidth = pixelRatio
    context.beginPath()
    context.moveTo(paddingX, expectedY)
    context.lineTo(width - paddingX, expectedY)
    context.stroke()

    if (this.stateIntervalSamples.length < 2) {
      return
    }

    context.strokeStyle = '#2f6fda'
    context.lineWidth = 1.5 * pixelRatio
    context.beginPath()

    const lastIndex = this.stateIntervalSamples.length - 1
    for (let index = 0; index < this.stateIntervalSamples.length; index += 1) {
      const x = paddingX + (chartWidth * index) / lastIndex
      const y = valueToY(this.stateIntervalSamples[index], chartHeight, paddingY)
      if (index === 0) {
        context.moveTo(x, y)
      } else {
        context.lineTo(x, y)
      }
    }

    context.stroke()
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

function valueToY(valueMs: number, chartHeight: number, paddingY: number): number {
  const clamped = Math.max(0, Math.min(STATE_INTERVAL_CHART_MAX_MS, valueMs))
  return paddingY + chartHeight - (clamped / STATE_INTERVAL_CHART_MAX_MS) * chartHeight
}
