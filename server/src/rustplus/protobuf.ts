// ---------------------------------------------------------------------------
// Minimal protobuf wire codec.
//
// Rust+ speaks protobuf over a websocket. Rather than take a dependency we
// implement the wire format directly — it is small and completely specified:
//
//   key       = (field_number << 3) | wire_type
//   wire 0    varint          uint32/uint64/int32/int64/bool/enum
//   wire 1    fixed 64-bit    double, fixed64
//   wire 2    length-delim    string, bytes, embedded message, packed repeated
//   wire 5    fixed 32-bit    float, fixed32
//
// Two details that bite:
//   * a NEGATIVE int32 is sign-extended to 64 bits, so it occupies the full
//     10-byte varint. playerToken is an int32 and is routinely negative.
//   * floats are wire type 5, little-endian — AppTime and team member
//     coordinates are all floats.
// ---------------------------------------------------------------------------

export const WIRE_VARINT = 0
export const WIRE_64 = 1
export const WIRE_BYTES = 2
export const WIRE_32 = 5

export class Writer {
  private chunks: number[] = []

  private raw(b: number): void {
    this.chunks.push(b & 0xff)
  }

  varint(value: bigint | number): this {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
    if (v < 0n) v += 1n << 64n // two's complement, sign-extended
    do {
      let byte = Number(v & 0x7fn)
      v >>= 7n
      if (v > 0n) byte |= 0x80
      this.raw(byte)
    } while (v > 0n)
    return this
  }

  tag(field: number, wire: number): this {
    return this.varint((field << 3) | wire)
  }

  uint32(field: number, value: number): this {
    if (value === 0) return this // proto3 omits defaults
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  /** Always written, even when zero — for fields the server requires. */
  uint32Always(field: number, value: number): this {
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  uint64(field: number, value: bigint | number): this {
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  int32(field: number, value: number): this {
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  bool(field: number, value: boolean): this {
    if (!value) return this
    return this.tag(field, WIRE_VARINT).varint(1)
  }

  float(field: number, value: number): this {
    this.tag(field, WIRE_32)
    const b = Buffer.alloc(4)
    b.writeFloatLE(value, 0)
    for (const x of b) this.raw(x)
    return this
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, WIRE_BYTES).varint(value.length)
    for (const x of value) this.raw(x)
    return this
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, 'utf8'))
  }

  /** Embedded message: length-delimited payload built by `fn`. */
  message(field: number, fn: (w: Writer) => void): this {
    const inner = new Writer()
    fn(inner)
    return this.bytes(field, inner.finish())
  }

  /** An empty embedded message still has to occupy its field. */
  empty(field: number): this {
    return this.bytes(field, new Uint8Array(0))
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks)
  }
}

export interface Field {
  field: number
  wire: number
  /** varint value, for wire 0 */
  varint?: bigint
  /** raw payload, for wire 2 */
  bytes?: Uint8Array
  /** decoded float, for wire 5 */
  float?: number
  /** raw 8 bytes, for wire 1 */
  double?: number
}

export class Reader {
  private pos = 0
  private buf: Uint8Array
  constructor(buf: Uint8Array) {
    this.buf = buf
  }

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  private readVarint(): bigint {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('protobuf: truncated varint')
      const byte = this.buf[this.pos++]
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7n
      if (shift > 70n) throw new Error('protobuf: varint too long')
    }
    return result
  }

  next(): Field {
    const key = Number(this.readVarint())
    const field = key >>> 3
    const wire = key & 0x07

    switch (wire) {
      case WIRE_VARINT:
        return { field, wire, varint: this.readVarint() }
      case WIRE_64: {
        const view = Buffer.from(this.buf.buffer, this.buf.byteOffset + this.pos, 8)
        this.pos += 8
        return { field, wire, double: view.readDoubleLE(0) }
      }
      case WIRE_BYTES: {
        const len = Number(this.readVarint())
        if (this.pos + len > this.buf.length) throw new Error('protobuf: truncated bytes')
        const bytes = this.buf.subarray(this.pos, this.pos + len)
        this.pos += len
        return { field, wire, bytes }
      }
      case WIRE_32: {
        const view = Buffer.from(this.buf.buffer, this.buf.byteOffset + this.pos, 4)
        this.pos += 4
        return { field, wire, float: view.readFloatLE(0) }
      }
      default:
        throw new Error(`protobuf: unsupported wire type ${wire}`)
    }
  }

  /** Walk every field, handing each to `visit`. Unknown fields are skipped. */
  each(visit: (f: Field) => void): void {
    while (!this.done) visit(this.next())
  }
}

export const asNumber = (f: Field): number => Number(f.varint ?? 0)
export const asBool = (f: Field): boolean => (f.varint ?? 0n) !== 0n
export const asString = (f: Field): string =>
  f.bytes ? Buffer.from(f.bytes).toString('utf8') : ''
/** int32 fields arrive sign-extended; fold back into signed 32-bit range. */
export const asInt32 = (f: Field): number => {
  const v = BigInt.asIntN(64, f.varint ?? 0n)
  return Number(BigInt.asIntN(32, v))
}
