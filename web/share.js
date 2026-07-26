// Share links without a server: the whole tab set rides in the URL hash as
// deflate-raw + base64url (CompressionStream is baseline in every modern
// browser — no dependency). Payload: { v: 1, files: [{ name, content }] }.

function toBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Response(out).arrayBuffer();
}

/** files: [{ name, content }] → hash value (without the '#code=' prefix). */
export async function encodeShare(files) {
  const payload = new TextEncoder().encode(JSON.stringify({ v: 1, files }));
  const compressed = await pipe(payload, new CompressionStream('deflate-raw'));
  return toBase64Url(compressed);
}

/** hash value → [{ name, content }] (throws on a malformed link). */
export async function decodeShare(encoded) {
  const compressed = fromBase64Url(encoded);
  const raw = await pipe(compressed, new DecompressionStream('deflate-raw'));
  const payload = JSON.parse(new TextDecoder().decode(raw));
  if (!payload || payload.v !== 1 || !Array.isArray(payload.files)) {
    throw new Error('unsupported share payload');
  }
  for (const f of payload.files) {
    if (typeof f.name !== 'string' || typeof f.content !== 'string') {
      throw new Error('malformed share payload');
    }
  }
  return payload.files;
}
