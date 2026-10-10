const PREFIX = 'gz.'
const MAX_ENCODED_BYTES = 1_000_000
const MAX_DECODED_BYTES = 4_000_000

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const reader = input.pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximumBytes) {
      await reader.cancel()
      throw new Error('Compact share state exceeds the size limit')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function encodeCompactShareState(
  params: URLSearchParams,
): Promise<string> {
  const bytes = new Uint8Array(new TextEncoder().encode(params.toString()))
  if (bytes.byteLength > MAX_DECODED_BYTES) {
    throw new Error('Share state is too large to encode')
  }
  const compressed = await transform(
    bytes,
    new CompressionStream('gzip'),
    MAX_ENCODED_BYTES,
  )
  return `${PREFIX}${bytesToBase64Url(compressed)}`
}

export async function decodeCompactShareState(
  value: string | null,
): Promise<URLSearchParams | null> {
  if (!value?.startsWith(PREFIX) || value.length > MAX_ENCODED_BYTES) return null
  try {
    const compressed = base64UrlToBytes(value.slice(PREFIX.length))
    const decompressed = await transform(
      compressed,
      new DecompressionStream('gzip'),
      MAX_DECODED_BYTES,
    )
    return new URLSearchParams(new TextDecoder().decode(decompressed))
  } catch {
    return null
  }
}
