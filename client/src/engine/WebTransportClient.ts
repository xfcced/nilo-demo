type ReliableMessageHandler = (payload: Uint8Array) => void
type DatagramHandler = (payload: Uint8Array) => void
type CloseHandler = (reason: string) => void
type ErrorHandler = (error: Error) => void

export type TransportCounters = {
  rxMessages: number
  txMessages: number
  rxBytes: number
  txBytes: number
}

type ReliableChannel = {
  writer: WritableStreamDefaultWriter<Uint8Array>
}

type WebTransportDatagrams = WebTransport['datagrams'] & {
  createWritable?: () => WritableStream<Uint8Array>
  writable?: WritableStream<Uint8Array>
}

const FRAME_HEADER_BYTES = 4
const MAX_FRAME_BYTES = 1024 * 1024

export class WebTransportClient {
  private transport: WebTransport | null = null
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  private reliableChannels = new Map<string, ReliableChannel>()
  private openingChannels = new Map<string, Promise<void>>()
  private reliableMessageHandlers = new Map<string, Set<ReliableMessageHandler>>()
  private datagramHandlers = new Set<DatagramHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private errorHandlers = new Set<ErrorHandler>()
  private encoder = new TextEncoder()
  private counters: TransportCounters = createEmptyCounters()

  async connect(url: string, certificateHashHex: string): Promise<void> {
    if (!window.WebTransport) {
      throw new Error('This browser does not support WebTransport')
    }

    this.counters = createEmptyCounters()
    this.transport = new WebTransport(url, createTransportOptions(certificateHashHex))

    await this.transport.ready

    this.datagramWriter = createDatagramWriter(this.transport)
    void this.readDatagrams(this.transport.datagrams.readable as ReadableStream<Uint8Array>)

    this.transport.closed
      .then(() => this.emitClose('closed'))
      .catch((error: unknown) => this.emitClose(String(error)))
  }

  async openReliableChannel(name: string): Promise<void> {
    this.assertValidChannelName(name)

    if (this.reliableChannels.has(name)) {
      return
    }

    const pending = this.openingChannels.get(name)
    if (pending) {
      return pending
    }

    const openPromise = this.openReliableChannelInternal(name).finally(() => {
      this.openingChannels.delete(name)
    })
    this.openingChannels.set(name, openPromise)
    return openPromise
  }

  async sendReliable(name: string, payload: Uint8Array): Promise<void> {
    await this.openReliableChannel(name)
    const channel = this.reliableChannels.get(name)
    if (!channel) {
      throw new Error(`Reliable channel "${name}" is not connected`)
    }

    await channel.writer.write(encodeFrame(payload))
    this.counters.txMessages += 1
    this.counters.txBytes += payload.byteLength
  }

  async sendDatagram(payload: Uint8Array): Promise<void> {
    if (!this.datagramWriter) {
      throw new Error('WebTransport datagrams are not connected')
    }

    await this.datagramWriter.write(payload)
    this.counters.txMessages += 1
    this.counters.txBytes += payload.byteLength
  }

  getStats(): TransportCounters {
    return { ...this.counters }
  }

  onReliableMessage(name: string, handler: ReliableMessageHandler): () => void {
    const handlers = this.reliableMessageHandlers.get(name) ?? new Set<ReliableMessageHandler>()
    handlers.add(handler)
    this.reliableMessageHandlers.set(name, handlers)
    return () => handlers.delete(handler)
  }

  onDatagram(handler: DatagramHandler): () => void {
    this.datagramHandlers.add(handler)
    return () => this.datagramHandlers.delete(handler)
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
      await Promise.allSettled([...this.reliableChannels.values()].map((channel) => channel.writer.close()))
      await this.datagramWriter?.close()
    } finally {
      this.datagramWriter = null
      this.reliableChannels.clear()
      this.openingChannels.clear()
      this.transport?.close({ closeCode: 0, reason: 'client closed' })
      this.transport = null
    }
  }

  private async openReliableChannelInternal(name: string): Promise<void> {
    if (!this.transport) {
      throw new Error('WebTransport is not connected')
    }

    const stream = await this.transport.createBidirectionalStream()
    const writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>
    await writer.write(encodeFrame(this.encoder.encode(name)))

    this.reliableChannels.set(name, { writer })
    void this.readReliableChannel(name, stream.readable as ReadableStream<Uint8Array>)
  }

  private async readReliableChannel(name: string, readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()
    let buffer: Uint8Array = new Uint8Array(0)

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          return
        }

        buffer = appendBytes(buffer, value)
        const result = decodeAvailableFrames(buffer)
        buffer = result.remaining

        for (const payload of result.frames) {
          this.counters.rxMessages += 1
          this.counters.rxBytes += payload.byteLength
          this.reliableMessageHandlers.get(name)?.forEach((handler) => handler(payload))
        }
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
      this.reliableChannels.delete(name)
    }
  }

  private async readDatagrams(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          return
        }

        this.counters.rxMessages += 1
        this.counters.rxBytes += value.byteLength
        this.datagramHandlers.forEach((handler) => handler(value))
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
    }
  }

  private assertValidChannelName(name: string): void {
    if (!name.trim()) {
      throw new Error('Reliable channel name cannot be empty')
    }
  }

  private emitClose(reason: string): void {
    this.datagramWriter = null
    this.reliableChannels.clear()
    this.openingChannels.clear()
    this.transport = null
    this.closeHandlers.forEach((handler) => handler(reason))
  }

  private emitError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error))
  }
}

function createTransportOptions(certificateHashHex: string): WebTransportOptions {
  const normalizedHash = certificateHashHex.trim()
  if (!normalizedHash) {
    return {}
  }

  return {
    serverCertificateHashes: [
      {
        algorithm: 'sha-256',
        value: hexToBytes(normalizedHash),
      },
    ],
  }
}

function createEmptyCounters(): TransportCounters {
  return {
    rxMessages: 0,
    txMessages: 0,
    rxBytes: 0,
    txBytes: 0,
  }
}

function createDatagramWriter(transport: WebTransport): WritableStreamDefaultWriter<Uint8Array> {
  const datagrams = transport.datagrams as WebTransportDatagrams
  const writable = datagrams.createWritable?.() ?? datagrams.writable

  if (!writable) {
    throw new Error('This browser does not support writable WebTransport datagrams')
  }

  return writable.getWriter()
}

function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`Frame exceeds max size: ${payload.byteLength}`)
  }

  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
  frame.set(payload, FRAME_HEADER_BYTES)
  return frame
}

function decodeAvailableFrames(buffer: Uint8Array): { frames: Uint8Array[]; remaining: Uint8Array } {
  const frames: Uint8Array[] = []
  let offset = 0

  while (buffer.byteLength - offset >= FRAME_HEADER_BYTES) {
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset, FRAME_HEADER_BYTES).getUint32(0, false)
    if (length > MAX_FRAME_BYTES) {
      throw new Error(`Received frame exceeds max size: ${length}`)
    }

    const frameEnd = offset + FRAME_HEADER_BYTES + length
    if (buffer.byteLength < frameEnd) {
      break
    }

    frames.push(buffer.slice(offset + FRAME_HEADER_BYTES, frameEnd))
    offset = frameEnd
  }

  return { frames, remaining: buffer.slice(offset) }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right
  }

  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left)
  combined.set(right, left.byteLength)
  return combined
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
