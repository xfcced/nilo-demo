import { WebTransportLineClient } from '../../engine/WebTransportLineClient'
import { decodeServerMessage, encodeClientMessage, type ClientMessage, type ServerMessage } from './protocol'

type MessageHandler = (message: ServerMessage) => void
type CloseHandler = (reason: string) => void
type ErrorHandler = (error: Error) => void

export class GameProtocolClient {
  private transport = new WebTransportLineClient()
  private messageHandlers = new Set<MessageHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private errorHandlers = new Set<ErrorHandler>()

  constructor() {
    this.transport.onLine((line) => this.handleLine(line))
    this.transport.onClose((reason) => {
      this.closeHandlers.forEach((handler) => handler(reason))
    })
    this.transport.onError((error) => {
      this.emitError(error)
    })
  }

  connect(url: string, certificateHashHex: string): Promise<void> {
    return this.transport.connect(url, certificateHashHex)
  }

  send(message: ClientMessage): Promise<void> {
    return this.transport.sendLine(encodeClientMessage(message))
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

  private handleLine(line: string): void {
    try {
      const message = decodeServerMessage(line)
      this.messageHandlers.forEach((handler) => handler(message))
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private emitError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error))
  }
}
