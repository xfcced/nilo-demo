type LineHandler = (line: string) => void
type CloseHandler = (reason: string) => void
type ErrorHandler = (error: Error) => void

export class WebTransportLineClient {
  private transport: WebTransport | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private lineHandlers = new Set<LineHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private errorHandlers = new Set<ErrorHandler>()
  private encoder = new TextEncoder()

  async connect(url: string, certificateHashHex: string): Promise<void> {
    if (!window.WebTransport) {
      throw new Error('This browser does not support WebTransport')
    }

    this.transport = new WebTransport(url, {
      serverCertificateHashes: [
        {
          algorithm: 'sha-256',
          value: hexToBytes(certificateHashHex),
        },
      ],
    })

    await this.transport.ready

    const stream = await this.transport.createBidirectionalStream()
    this.writer = stream.writable.getWriter()
    void this.readLoop(stream.readable)

    this.transport.closed
      .then(() => this.emitClose('closed'))
      .catch((error: unknown) => this.emitClose(String(error)))
  }

  async sendLine(line: string): Promise<void> {
    if (!this.writer) {
      throw new Error('WebTransport stream is not connected')
    }

    await this.writer.write(this.encoder.encode(`${line}\n`))
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler)
    return () => this.lineHandlers.delete(handler)
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  async close(): Promise<void> {
    try {
      await this.writer?.close()
    } finally {
      this.writer = null
      this.transport?.close({ closeCode: 0, reason: 'client closed' })
      this.transport = null
    }
  }

  private async readLoop(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.trim()) {
            this.lineHandlers.forEach((handler) => handler(line))
          }
        }
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
    }
  }

  private emitClose(reason: string): void {
    this.writer = null
    this.transport = null
    this.closeHandlers.forEach((handler) => handler(reason))
  }

  private emitError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error))
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const cleanHex = hex.trim().replaceAll(/\s/g, '')
  if (!/^[0-9a-fA-F]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
    throw new Error('Certificate hash must be an even-length hex string')
  }

  const bytes = new Uint8Array(new ArrayBuffer(cleanHex.length / 2))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(cleanHex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
