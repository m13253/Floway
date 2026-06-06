// Run an HTTP/1.1 request over an already-TLS-wrapped or plain duplex stream.
// Used both for native Workers Sockets (which expose readable/writable directly)
// and for our userspace-TLS-wrapped streams.

import { type TargetSpec } from './targets.js'

export interface DuplexBytes {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export async function runHttp1Stream(stream: DuplexBytes, target: TargetSpec): Promise<Response> {
  const writer = stream.writable.getWriter()
  const enc = new TextEncoder()
  const headers = { ...target.headers }
  if (!('host' in lowerKeys(headers))) headers.Host = target.host
  if (!('connection' in lowerKeys(headers))) headers.Connection = 'close'
  if (!('accept-encoding' in lowerKeys(headers))) headers['Accept-Encoding'] = 'identity'

  const requestLine = `${target.method} ${target.path} HTTP/1.1\r\n`
  let head = requestLine
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`
  head += '\r\n'
  await writer.write(enc.encode(head))
  writer.releaseLock()

  return await parseResponse(stream.readable)
}

function lowerKeys(o: Record<string, string>): Record<string, string> {
  const r: Record<string, string> = {}
  for (const k in o) r[k.toLowerCase()] = o[k]!
  return r
}

async function parseResponse(readable: ReadableStream<Uint8Array>): Promise<Response> {
  const reader = readable.getReader()
  let buffer = new Uint8Array(0)

  let headerEnd = -1
  while (headerEnd < 0) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`unexpected EOF before headers; got ${buffer.byteLength} bytes`)
    buffer = concat(buffer, copy(value))
    headerEnd = findDoubleCrlf(buffer)
  }

  const headerBytes = buffer.subarray(0, headerEnd)
  const remainder = copy(buffer.subarray(headerEnd + 4))

  const headerText = new TextDecoder().decode(headerBytes)
  const lines = headerText.split('\r\n')
  const statusLine = lines.shift()!
  const m = /^HTTP\/(1\.[01]) (\d{3}) ?(.*)$/.exec(statusLine)
  if (!m) throw new Error(`bad status line: ${JSON.stringify(statusLine)}`)
  const status = parseInt(m[2]!, 10)

  const respHeaders = new Headers()
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    respHeaders.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }

  const transferEncoding = (respHeaders.get('transfer-encoding') ?? '').toLowerCase()
  const contentLength = respHeaders.get('content-length')

  let body: ReadableStream<Uint8Array>
  let mode: 'chunked' | 'length' | 'eof'
  if (transferEncoding.includes('chunked')) {
    body = chunkedBody(reader, remainder)
    mode = 'chunked'
    respHeaders.delete('transfer-encoding')
  } else if (contentLength !== null) {
    const total = parseInt(contentLength, 10)
    body = lengthBody(reader, remainder, total)
    mode = 'length'
  } else {
    body = untilEofBody(reader, remainder)
    mode = 'eof'
  }
  respHeaders.set('x-content-stream-mode', mode)

  return new Response(body, { status, headers: respHeaders })
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength)
  r.set(u)
  return r
}

function lengthBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
  total: number,
): ReadableStream<Uint8Array> {
  let consumed = 0
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (head.byteLength) {
        const take = Math.min(head.byteLength, total)
        controller.enqueue(head.subarray(0, take))
        consumed += take
      }
      if (consumed >= total) {
        controller.close()
        try { await reader.cancel() } catch {}
      }
    },
    async pull(controller) {
      while (consumed < total) {
        const { value, done } = await reader.read()
        if (done) {
          controller.error(new Error(`upstream EOF after ${consumed}/${total} body bytes`))
          return
        }
        const remain = total - consumed
        if (value.byteLength <= remain) {
          controller.enqueue(copy(value))
          consumed += value.byteLength
        } else {
          controller.enqueue(copy(value.subarray(0, remain)))
          consumed += remain
        }
        if (consumed >= total) {
          controller.close()
          try { await reader.cancel() } catch {}
          return
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
}

function untilEofBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head)
    },
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(copy(value))
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
}

function chunkedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> {
  let buf = head
  let state: 'size' | 'data' | 'after-data-crlf' | 'trailers' | 'done' = 'size'
  let need = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (state === 'size') {
          const idx = findCrlf(buf)
          if (idx < 0) {
            const more = await reader.read()
            if (more.done) {
              controller.error(new Error('chunked: EOF in size'))
              return
            }
            buf = concat(buf, copy(more.value))
            continue
          }
          const sizeLine = new TextDecoder().decode(buf.subarray(0, idx))
          const semi = sizeLine.indexOf(';')
          const hex = (semi < 0 ? sizeLine : sizeLine.slice(0, semi)).trim()
          need = parseInt(hex, 16)
          if (Number.isNaN(need)) {
            controller.error(new Error(`chunked: bad size line ${JSON.stringify(sizeLine)}`))
            return
          }
          buf = buf.subarray(idx + 2)
          state = need === 0 ? 'trailers' : 'data'
        } else if (state === 'data') {
          if (buf.byteLength === 0) {
            const more = await reader.read()
            if (more.done) {
              controller.error(new Error('chunked: EOF mid-data'))
              return
            }
            buf = copy(more.value)
            continue
          }
          const take = Math.min(buf.byteLength, need)
          controller.enqueue(copy(buf.subarray(0, take)))
          buf = buf.subarray(take)
          need -= take
          if (need === 0) state = 'after-data-crlf'
          if (take > 0) return
        } else if (state === 'after-data-crlf') {
          while (buf.byteLength < 2) {
            const more = await reader.read()
            if (more.done) {
              controller.error(new Error('chunked: EOF before CRLF after data'))
              return
            }
            buf = concat(buf, copy(more.value))
          }
          if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
            controller.error(new Error('chunked: missing CRLF after data'))
            return
          }
          buf = buf.subarray(2)
          state = 'size'
        } else if (state === 'trailers') {
          const idx = findCrlf(buf)
          if (idx < 0) {
            const more = await reader.read()
            if (more.done) {
              controller.error(new Error('chunked: EOF in trailers'))
              return
            }
            buf = concat(buf, copy(more.value))
            continue
          }
          if (idx === 0) {
            buf = buf.subarray(2)
            state = 'done'
            controller.close()
            try { await reader.cancel() } catch {}
            return
          }
          buf = buf.subarray(idx + 2)
        } else {
          controller.close()
          return
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
}

function findCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i
  }
  return -1
}

function findDoubleCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i
  }
  return -1
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.byteLength === 0) return copy(b)
  if (b.byteLength === 0) return copy(a)
  const r = new Uint8Array(a.byteLength + b.byteLength)
  r.set(a, 0)
  r.set(b, a.byteLength)
  return r
}
