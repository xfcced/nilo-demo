import { WebTransportClient, type TransportCounters } from '../../engine/WebTransportClient'
import { decodeServerMessage, encodeClientMessage, type ClientMessage, type ServerMessage } from './protocol'

type MessageHandler = (message: ServerMessage) => void
type CloseHandler = (reason: string) => void
type ErrorHandler = (error: Error) => void

const CONTROL_CHANNEL = 'control'
const PROBE_CHANNEL = 'probe'
const DATAGRAM_PROBE = 'nilo-dgram-probe'

export class GameConnection {
  private transport = new WebTransportClient()
  private messageHandlers = new Set<MessageHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private errorHandlers = new Set<ErrorHandler>()
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()

  constructor() {
    this.transport.onReliableMessage(CONTROL_CHANNEL, (payload) => this.handleControlPayload(payload))
    this.transport.onClose((reason) => {
      this.closeHandlers.forEach((handler) => handler(reason))
    })
    this.transport.onError((error) => {
      this.emitError(error)
    })
  }

  async connect(url: string, certificateHashHex: string): Promise<void> {
    await this.transport.connect(url, certificateHashHex)
    await this.transport.openReliableChannel(CONTROL_CHANNEL)
    await this.sendProbeMessages()
  }

  send(message: ClientMessage): Promise<void> {
    return this.transport.sendReliable(CONTROL_CHANNEL, this.encoder.encode(encodeClientMessage(message)))
  }

  getStats(): TransportCounters {
    return this.transport.getStats()
  }

  close(): Promise<void> {
    return this.transport.close()
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  private handleControlPayload(payload: Uint8Array): void {
    try {
      const line = this.decoder.decode(payload)
      const message = decodeServerMessage(line)
      this.messageHandlers.forEach((handler) => handler(message))
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async sendProbeMessages(): Promise<void> {
    await Promise.allSettled([
      this.transport.sendDatagram(this.encoder.encode(DATAGRAM_PROBE)),
      this.transport.sendReliable(PROBE_CHANNEL, this.encoder.encode('nilo-stream-probe')),
    ])
  }

  private emitError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error))
  }
}
