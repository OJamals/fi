/** Native subscription-protobuf protocol adapted from auth2api; see README protocol sources. */
import { MAX_NATIVE_FRAME } from './subscription-stream.ts'

// Minimal protobuf wire codec. No generated SDK or protobuf runtime dependency.
/**
 * Encode a nonnegative protobuf integer.
 * @param value - integer to encode.
 * @returns varint bytes.
 */
export function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protobuf integer')
  let n = BigInt(value)
  const bytes: number[] = []
  do {
    bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0))
    n >>= 7n
  } while (n)
  return Buffer.from(bytes)
}
/**
 * Encode one length-delimited or integer protobuf field.
 * @param field - positive protobuf field number.
 * @param value - field contents.
 * @returns encoded field bytes.
 */
export function pb(field: number, value: string | Uint8Array | number): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(field * 8), varint(value)])
  const bytes = Buffer.from(value)
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes])
}
/**
 * Decoded protobuf fields preserving repeated occurrences.
 */
export type Fields = Map<number, Array<Buffer | number>>
/**
 * Decode bounded protobuf data, rejecting truncated lengths and unsupported wire types.
 * @param bytes - untrusted protobuf message.
 * @returns decoded repeated fields.
 */
export function decodeProto(bytes: Uint8Array): Fields {
  const data = Buffer.from(bytes)
  if (data.length > MAX_NATIVE_FRAME) throw new Error('Protobuf frame too large')
  let offset = 0
  const read = () => {
    let result = 0n
    for (let i = 0; i < 10; i++) {
      if (offset >= data.length) throw new Error('Truncated protobuf varint')
      const byte = data.readUInt8(offset++)
      result |= BigInt(byte & 127) << BigInt(i * 7)
      if (!(byte & 128)) {
        if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Protobuf integer overflow')
        return Number(result)
      }
    }
    throw new Error('Invalid protobuf varint')
  }
  const result: Fields = new Map()
  while (offset < data.length) {
    const tag = read()
    const field = Math.floor(tag / 8)
    const wire = tag & 7
    if (!field) throw new Error('Invalid protobuf field')
    let value: Buffer | number
    if (wire === 0) value = read()
    else {
      const length = wire === 2 ? read() : wire === 1 ? 8 : wire === 5 ? 4 : -1
      if (length < 0 || offset + length > data.length) throw new Error('Invalid protobuf length or wire type')
      value = data.subarray(offset, offset + length)
      offset += length
    }
    const values = result.get(field) || []
    values.push(value)
    result.set(field, values)
  }
  return result
}
/**
 * Read the first byte-valued field; absent fields produce an empty buffer.
 * @param fields - decoded message.
 * @param field - requested field number.
 * @returns field bytes.
 */
export function bytes(fields: Fields, field: number): Buffer {
  const value = fields.get(field)?.[0]
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0)
}
/**
 * Read the first byte-valued field as UTF-8.
 * @param fields - decoded message.
 * @param field - requested field number.
 * @returns decoded string or empty string.
 */
export function str(fields: Fields, field: number): string {
  return bytes(fields, field).toString('utf8')
}
/**
 * Decode the first byte-valued field as a nested message.
 * @param fields - decoded message.
 * @param field - requested field number.
 * @returns nested repeated fields.
 */
export function nested(fields: Fields, field: number): Fields {
  return decodeProto(bytes(fields, field))
}
/**
 * Wrap protobuf bytes in an uncompressed Connect stream frame.
 * @param payload - encoded message.
 * @returns framed bytes.
 */
export function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
/**
 * Encode protobuf Value with bounded recursive depth.
 * @param value - JSON-compatible value.
 * @param depth - current nesting depth.
 * @returns protobuf Value bytes.
 */
export function encodeValue(value: unknown, depth = 0): Buffer {
  if (depth > 32) throw new Error('Protobuf value nesting exceeds 32')
  if (value == null) return pb(1, 0)
  if (typeof value === 'boolean') return pb(4, Number(value))
  if (typeof value === 'number') {
    const out = Buffer.alloc(9)
    out[0] = 17
    out.writeDoubleLE(value, 1)
    return out
  }
  if (typeof value === 'string') return pb(3, value)
  if (Array.isArray(value)) return pb(6, Buffer.concat(value.map(v => pb(1, encodeValue(v, depth + 1)))))
  if (typeof value !== 'object') throw new Error('Unsupported protobuf value')
  return pb(
    5,
    Buffer.concat(
      Object.entries(value).map(([key, v]) => pb(1, Buffer.concat([pb(1, key), pb(2, encodeValue(v, depth + 1))]))),
    ),
  )
}
/**
 * Decode protobuf Value, rejecting excessive nesting and nonfinite numbers.
 * @param value - encoded Value bytes.
 * @param depth - current nesting depth.
 * @returns decoded dynamic JSON value.
 */
export function decodeValue(value: Uint8Array, depth = 0): unknown {
  if (depth > 32) throw new Error('Protobuf value nesting exceeds 32')
  const fields = decodeProto(value)
  if (fields.has(1)) return null
  if (fields.has(2)) {
    const n = bytes(fields, 2).readDoubleLE()
    if (!Number.isFinite(n)) throw new Error('Nonfinite protobuf number')
    return n
  }
  if (fields.has(3)) return str(fields, 3)
  if (fields.has(4)) return fields.get(4)?.[0] !== 0
  if (fields.has(6)) return (nested(fields, 6).get(1) || []).map(v => decodeValue(v as Buffer, depth + 1))
  const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const entry of nested(fields, 5).get(1) || []) {
    const pair = decodeProto(entry as Buffer)
    object[str(pair, 1)] = decodeValue(bytes(pair, 2), depth + 1)
  }
  return object
}
