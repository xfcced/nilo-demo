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
  lastReceivedInputSeq: number
  predictionError: number
  correctionCount: number
}

export type DebugOptions = {
  predictionDebug: boolean
  interpolationDebug: boolean
}

const STATE_ARRIVAL_WINDOW_MS = 4000
const LOSS_SAMPLE_COUNT = 120
const LOSS_CHART_MIN_MAX = 3

type LossSample = {
  stateLoss: number
  inputLoss: number
}

type DebugPanelElements = {
  panel: HTMLElement
  toggleButton: HTMLButtonElement
  restartButton: HTMLButtonElement
  predictionDebugToggle: HTMLInputElement
  interpolationDebugToggle: HTMLInputElement
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
  stateLossValue: HTMLElement
  stateLossChart: HTMLCanvasElement
  inputLossValue: HTMLElement
  inputLossChart: HTMLCanvasElement
}

export class DebugPanel {
  private elements: DebugPanelElements
  private visible = true
  private lastStateReceivedAtMs: number | null = null
  private stateArrivalSamples: number[] = []
  private previousLossServerTick: number | null = null
  private previousLossInputSeq: number | null = null
  private lossSamples: LossSample[] = []

  constructor() {
    this.elements = {
      panel: getElement('debugPanel'),
      toggleButton: getElement('debugToggle'),
      restartButton: getElement('restartButton'),
      predictionDebugToggle: getElement('predictionDebugToggle'),
      interpolationDebugToggle: getElement('interpolationDebugToggle'),
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
      stateLossValue: getElement('stateLossValue'),
      stateLossChart: getElement('stateLossChart'),
      inputLossValue: getElement('inputLossValue'),
      inputLossChart: getElement('inputLossChart'),
    }

    this.elements.toggleButton.addEventListener('click', () => {
      this.setVisible(!this.visible)
    })

    this.drawStateIntervalChart()
    this.drawLossCharts()
  }

  onRestart(handler: () => void): void {
    this.elements.restartButton.addEventListener('click', handler)
  }

  onDebugOptionsChanged(handler: (options: DebugOptions) => void): void {
    const notify = (): void => handler(this.debugOptions())
    this.elements.predictionDebugToggle.addEventListener('change', notify)
    this.elements.interpolationDebugToggle.addEventListener('change', notify)
  }

  debugOptions(): DebugOptions {
    return {
      predictionDebug: this.elements.predictionDebugToggle.checked,
      interpolationDebug: this.elements.interpolationDebugToggle.checked,
    }
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
      this.elements.stateIntervalValue.textContent = `${intervalMs.toFixed(1)} ms`
    }

    this.stateArrivalSamples.push(receivedAtMs)
    this.trimStateArrivalSamples(receivedAtMs)
    this.lastStateReceivedAtMs = receivedAtMs
    this.drawStateIntervalChart()
  }

  resetStateIntervalChart(): void {
    this.lastStateReceivedAtMs = null
    this.stateArrivalSamples = []
    this.elements.stateIntervalValue.textContent = '-'
    this.drawStateIntervalChart()
  }

  recordLossSample(serverTick: number, lastReceivedInputSeq: number): void {
    if (this.previousLossServerTick !== null && this.previousLossInputSeq !== null) {
      const stateLoss = Math.max(0, serverTick - this.previousLossServerTick - 1)
      const inputLoss = Math.max(0, lastReceivedInputSeq - this.previousLossInputSeq - 1)
      this.lossSamples.push({ stateLoss, inputLoss })
      if (this.lossSamples.length > LOSS_SAMPLE_COUNT) {
        this.lossSamples.shift()
      }
      this.elements.stateLossValue.textContent = String(stateLoss)
      this.elements.inputLossValue.textContent = String(inputLoss)
      this.drawLossCharts()
    }

    this.previousLossServerTick = serverTick
    this.previousLossInputSeq = lastReceivedInputSeq
  }

  resetLossChart(): void {
    this.previousLossServerTick = null
    this.previousLossInputSeq = null
    this.lossSamples = []
    this.elements.stateLossValue.textContent = '-'
    this.elements.inputLossValue.textContent = '-'
    this.drawLossCharts()
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
    this.elements.ackSeqValue.textContent = String(metrics.lastReceivedInputSeq)
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

    const { width, height, pixelRatio } = prepareCanvas(canvas, context)
    const leftPadding = 32 * pixelRatio
    const rightPadding = 6 * pixelRatio
    const topPadding = 14 * pixelRatio
    const bottomPadding = 14 * pixelRatio
    const chartLeft = leftPadding
    const chartRight = width - rightPadding
    const chartTop = topPadding
    const chartBottom = height - bottomPadding
    const chartWidth = chartRight - chartLeft
    const chartHeight = chartBottom - chartTop
    const expectedMs = 1000 / gameConfig.simulation.tickRate
    const newestArrival = this.stateArrivalSamples.at(-1)
    const windowEnd = newestArrival ?? performance.now()
    const windowStart = windowEnd - STATE_ARRIVAL_WINDOW_MS
    const expectedSpacing = (expectedMs / STATE_ARRIVAL_WINDOW_MS) * chartWidth

    context.font = `${10 * pixelRatio}px ui-sans-serif, system-ui, sans-serif`
    context.fillStyle = '#555555'
    context.strokeStyle = '#eeeeee'
    context.lineWidth = pixelRatio
    context.textBaseline = 'top'
    context.textAlign = 'left'
    context.fillText('arrivals', chartLeft, 2 * pixelRatio)

    context.strokeStyle = '#777777'
    context.beginPath()
    context.moveTo(chartLeft, chartTop)
    context.lineTo(chartLeft, chartBottom)
    context.lineTo(chartRight, chartBottom)
    context.stroke()

    context.textBaseline = 'top'
    context.textAlign = 'left'
    context.fillText('-4s', chartLeft, chartBottom + 3 * pixelRatio)
    context.textAlign = 'right'
    context.fillText('now', chartRight, chartBottom + 3 * pixelRatio)
    context.textAlign = 'left'
    context.fillText(`~${Math.round(expectedMs)}ms`, chartLeft + expectedSpacing + 3 * pixelRatio, chartTop + 2 * pixelRatio)

    context.strokeStyle = '#e6e6e6'
    context.beginPath()
    context.moveTo(chartLeft + expectedSpacing, chartTop)
    context.lineTo(chartLeft + expectedSpacing, chartBottom)
    context.stroke()

    context.strokeStyle = '#2f6fda'
    context.lineWidth = Math.max(pixelRatio, 1.5 * pixelRatio)
    for (const arrivalMs of this.stateArrivalSamples) {
      if (arrivalMs < windowStart || arrivalMs > windowEnd) {
        continue
      }
      const x = chartLeft + ((arrivalMs - windowStart) / STATE_ARRIVAL_WINDOW_MS) * chartWidth
      context.beginPath()
      context.moveTo(x, chartTop)
      context.lineTo(x, chartBottom)
      context.stroke()
    }
  }

  private trimStateArrivalSamples(nowMs: number): void {
    const minArrivalMs = nowMs - STATE_ARRIVAL_WINDOW_MS
    while (this.stateArrivalSamples.length > 0 && this.stateArrivalSamples[0] < minArrivalMs) {
      this.stateArrivalSamples.shift()
    }
  }

  private drawLossCharts(): void {
    this.drawSingleLossChart(this.elements.stateLossChart, 'stateLoss', '#2f6fda')
    this.drawSingleLossChart(this.elements.inputLossChart, 'inputLoss', '#d64545')
  }

  private drawSingleLossChart(canvas: HTMLCanvasElement, key: keyof LossSample, color: string): void {
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    const { width, height, pixelRatio } = prepareCanvas(canvas, context)
    const leftPadding = 34 * pixelRatio
    const rightPadding = 8 * pixelRatio
    const topPadding = 14 * pixelRatio
    const bottomPadding = 22 * pixelRatio
    const chartLeft = leftPadding
    const chartRight = width - rightPadding
    const chartTop = topPadding
    const chartBottom = height - bottomPadding
    const chartWidth = chartRight - chartLeft
    const chartHeight = chartBottom - chartTop
    const maxLoss = Math.max(LOSS_CHART_MIN_MAX, ...this.lossSamples.map((sample) => sample[key]))
    const midLoss = Math.ceil(maxLoss / 2)

    context.font = `${10 * pixelRatio}px ui-sans-serif, system-ui, sans-serif`
    context.fillStyle = '#555555'
    context.strokeStyle = '#eeeeee'
    context.lineWidth = pixelRatio
    context.textBaseline = 'middle'

    for (const loss of [0, midLoss, maxLoss]) {
      const y = lossToY(loss, maxLoss, chartHeight, chartTop)
      context.beginPath()
      context.moveTo(chartLeft, y)
      context.lineTo(chartRight, y)
      context.stroke()
      context.textAlign = 'right'
      context.fillText(String(loss), chartLeft - 4 * pixelRatio, y)
    }

    context.strokeStyle = '#777777'
    context.beginPath()
    context.moveTo(chartLeft, chartTop)
    context.lineTo(chartLeft, chartBottom)
    context.lineTo(chartRight, chartBottom)
    context.stroke()

    context.textBaseline = 'top'
    context.textAlign = 'left'
    context.fillText('old', chartLeft, chartBottom + 3 * pixelRatio)
    context.textAlign = 'right'
    context.fillText('now', chartRight, chartBottom + 3 * pixelRatio)
    context.textAlign = 'left'
    context.fillText('lost/sample', chartLeft, 2 * pixelRatio)

    drawLossLine(context, this.lossSamples, key, color, chartLeft, chartWidth, chartHeight, chartTop, maxLoss, pixelRatio)
  }
}

function prepareCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): { width: number; height: number; pixelRatio: number } {
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

  return { width, height, pixelRatio }
}

function drawLossLine(
  context: CanvasRenderingContext2D,
  samples: LossSample[],
  key: keyof LossSample,
  color: string,
  chartLeft: number,
  chartWidth: number,
  chartHeight: number,
  chartTop: number,
  maxLoss: number,
  pixelRatio: number,
): void {
  if (samples.length < 2) {
    return
  }

  context.strokeStyle = color
  context.lineWidth = 1.5 * pixelRatio
  context.beginPath()

  const lastIndex = samples.length - 1
  for (let index = 0; index < samples.length; index += 1) {
    const x = chartLeft + (chartWidth * index) / lastIndex
    const y = lossToY(samples[index][key], maxLoss, chartHeight, chartTop)
    if (index === 0) {
      context.moveTo(x, y)
    } else {
      context.lineTo(x, y)
    }
  }

  context.stroke()
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

function lossToY(loss: number, maxLoss: number, chartHeight: number, paddingY: number): number {
  const clamped = Math.max(0, Math.min(maxLoss, loss))
  return paddingY + chartHeight - (clamped / maxLoss) * chartHeight
}
