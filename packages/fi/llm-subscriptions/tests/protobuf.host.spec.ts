/** Protobuf wire codec bounds and value mapping. */
import { expect, it } from 'vitest'
import { MAX_NATIVE_FRAME } from '../src/native/subscription-stream.ts'
import {
  bytes,
  decodeProto,
  decodeValue,
  encodeValue,
  frame,
  nested,
  pb,
  str,
  varint,
} from '../src/native/subscription-protobuf.ts'

it('encodes only nonnegative safe integers as varints', () => {
  expect([...varint(0)]).toEqual([0])
  expect([...varint(300)]).toEqual([0xac, 0x02])
  for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => varint(value)).toThrow('Invalid protobuf integer')
})

it('decodes fixed-width and varint fields and rejects malformed or oversized input', () => {
  const fixed64 = Buffer.concat([Buffer.from([0x09]), Buffer.alloc(8, 1)])
  const fixed32 = Buffer.concat([Buffer.from([0x15]), Buffer.alloc(4, 2)])
  const fields = decodeProto(Buffer.concat([fixed64, fixed32, pb(3, 7), pb(4, 'text')]))
  expect(fields.get(1)?.[0]).toEqual(Buffer.alloc(8, 1))
  expect(fields.get(2)?.[0]).toEqual(Buffer.alloc(4, 2))
  expect(fields.get(3)).toEqual([7])
  expect(str(fields, 4)).toBe('text')
  // Missing fields and number-valued fields read as empty.
  expect(bytes(fields, 9)).toEqual(Buffer.alloc(0))
  expect(bytes(fields, 3)).toEqual(Buffer.alloc(0))
  expect(str(fields, 9)).toBe('')
  expect(nested(fields, 9).size).toBe(0)
  expect(() => decodeProto(Buffer.alloc(MAX_NATIVE_FRAME + 1))).toThrow('too large')
  expect(() => decodeProto(Buffer.from([0x80]))).toThrow('Truncated protobuf varint')
  expect(() => decodeProto(Buffer.from([0x08, ...new Array<number>(10).fill(0x80)]))).toThrow('Invalid protobuf varint')
  expect(() => decodeProto(Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]))).toThrow('integer overflow')
  expect(() => decodeProto(Buffer.from([0x00, 0x01]))).toThrow('Invalid protobuf field')
  expect(() => decodeProto(Buffer.from([0x0b]))).toThrow('length or wire type')
  expect(() => decodeProto(Buffer.concat([Buffer.from([0x09]), Buffer.alloc(3)]))).toThrow('length or wire type')
  expect(frame(Buffer.from('ab')).readUInt32BE(1)).toBe(2)
})

it('maps JSON values through protobuf Value and bounds nesting', () => {
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(decodeValue(encodeValue(value)))) as unknown
  for (const value of [null, true, false, 0, -1.5, 'text', [], [1, [2]], {}, { a: { b: [null] } }]) expect(roundTrip(value)).toEqual(value)
  expect(decodeValue(encodeValue(undefined))).toBeNull()
  for (const value of [1n, () => 1, Symbol('x')]) expect(() => encodeValue(value)).toThrow('Unsupported protobuf value')
  let deep: unknown = 'leaf'
  for (let depth = 0; depth < 34; depth++) deep = [deep]
  expect(() => encodeValue(deep)).toThrow('nesting exceeds 32')
  let wire = pb(3, 'leaf')
  for (let depth = 0; depth < 34; depth++) wire = pb(6, pb(1, wire))
  expect(() => decodeValue(wire)).toThrow('nesting exceeds 32')
  const infinite = Buffer.alloc(9)
  infinite[0] = 17
  infinite.writeDoubleLE(Number.POSITIVE_INFINITY, 1)
  expect(() => decodeValue(infinite)).toThrow('Nonfinite protobuf number')
  expect(decodeValue(pb(4, 0))).toBe(false)
  expect(decodeValue(Buffer.alloc(0))).toEqual({})
})
