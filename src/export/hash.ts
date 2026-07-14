export type Sha256Input = string | Uint8Array | ArrayBuffer | Blob;

export class WebCryptoUnavailableError extends Error {
  constructor() {
    super('SHA-256 is unavailable because this browser does not provide Web Crypto.');
    this.name = 'WebCryptoUnavailableError';
  }
}

export async function sha256Hex(input: Sha256Input): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new WebCryptoUnavailableError();
  const bytes = await toBytes(input);
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifySha256(input: Sha256Input, expectedHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
  const actual = await sha256Hex(input);
  const expected = expectedHex.toLowerCase();
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function toBytes(input: Sha256Input): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  return Uint8Array.from(input);
}
