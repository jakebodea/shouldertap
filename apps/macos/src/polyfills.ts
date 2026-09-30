// biome-ignore-all lint/suspicious/noBitwiseOperators: this is a UTF-8 codec
// biome-ignore-all lint/style/noIncrementDecrement: byte cursor
// Hermes on macOS lacks TextEncoder/TextDecoder, which Effect uses. UTF-8 only.
class Utf8Encoder {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    const bytes: number[] = [];
    for (const char of input) {
      let code = char.codePointAt(0) ?? 0;
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x8_00) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x1_00_00) {
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      } else {
        code = Math.min(code, 0x10_ff_ff);
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return new Uint8Array(bytes);
  }
}

class Utf8Decoder {
  readonly encoding = "utf-8";

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) {
      return "";
    }
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++] ?? 0;
      let code = b0;
      if (b0 >= 0xf0) {
        code =
          ((b0 & 0x07) << 18) |
          (((bytes[i++] ?? 0) & 0x3f) << 12) |
          (((bytes[i++] ?? 0) & 0x3f) << 6) |
          ((bytes[i++] ?? 0) & 0x3f);
      } else if (b0 >= 0xe0) {
        code =
          ((b0 & 0x0f) << 12) |
          (((bytes[i++] ?? 0) & 0x3f) << 6) |
          ((bytes[i++] ?? 0) & 0x3f);
      } else if (b0 >= 0xc0) {
        code = ((b0 & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
      }
      out += String.fromCodePoint(code);
    }
    return out;
  }
}

const scope = globalThis as Record<string, unknown>;
scope.TextEncoder ??= Utf8Encoder;
scope.TextDecoder ??= Utf8Decoder;
