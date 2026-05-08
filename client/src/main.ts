import './style.css'
import { DebugPanel } from './debugPanel'
import { ArenaScene } from './scene'
import { WebTransportClient } from './transport'

const urlInput = getElement<HTMLInputElement>('urlInput')
const hashInput = getElement<HTMLInputElement>('hashInput')
const connectButton = getElement<HTMLButtonElement>('connectButton')
const disconnectButton = getElement<HTMLButtonElement>('disconnectButton')
const canvas = getElement<HTMLCanvasElement>('scene')

const debugPanel = new DebugPanel()
const arena = new ArenaScene(canvas)
const transport = new WebTransportClient()

let pingTimer: number | null = null

arena.start()
debugPanel.setConnection('disconnected')

transport.onMessage((message) => {
  if (message.type === 'welcome') {
    debugPanel.setPlayerId(message.playerId)
    debugPanel.setServerTime(message.serverTime)
    debugPanel.log(`joined as player ${message.playerId}`)
    return
  }

  if (message.type === 'pong') {
    const now = performance.now()
    debugPanel.setRtt(now - message.clientTime)
    debugPanel.setServerTime(message.serverTime)
    return
  }

  debugPanel.log(`server error: ${message.message}`)
})

transport.onClose((reason) => {
  stopPing()
  debugPanel.setConnection('disconnected')
  debugPanel.log(`connection closed: ${reason}`)
  setButtons(false)
})

transport.onError((error) => {
  debugPanel.log(`message error: ${error.message}`)
})

connectButton.addEventListener('click', () => {
  void connect()
})

disconnectButton.addEventListener('click', () => {
  void disconnect()
})

async function connect(): Promise<void> {
  try {
    debugPanel.setConnection('connecting')
    setButtons(false)
    debugPanel.log('connecting...')

    await transport.connect(urlInput.value.trim(), hashInput.value.trim())
    await transport.send({ type: 'join' })

    debugPanel.setConnection('connected')
    setButtons(true)
    startPing()
  } catch (error) {
    debugPanel.setConnection('disconnected')
    debugPanel.log(`connect failed: ${String(error)}`)
    setButtons(false)
  }
}

async function disconnect(): Promise<void> {
  stopPing()
  await transport.close()
  debugPanel.setConnection('disconnected')
  debugPanel.setPlayerId(null)
  debugPanel.setRtt(null)
  debugPanel.setServerTime(null)
  setButtons(false)
}

function startPing(): void {
  stopPing()

  const sendPing = () => {
    void transport.send({ type: 'ping', clientTime: performance.now() }).catch((error: unknown) => {
      debugPanel.log(`ping failed: ${String(error)}`)
    })
  }

  sendPing()
  pingTimer = window.setInterval(sendPing, 1000)
}

function stopPing(): void {
  if (pingTimer !== null) {
    window.clearInterval(pingTimer)
    pingTimer = null
  }
}

function setButtons(connected: boolean): void {
  connectButton.disabled = connected
  disconnectButton.disabled = !connected
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing element #${id}`)
  }
  return element as T
}
