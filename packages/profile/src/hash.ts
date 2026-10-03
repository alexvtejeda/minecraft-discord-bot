function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Copying into a fresh Uint8Array gives an ArrayBuffer-backed view, which WebCrypto's
// BufferSource type requires (Node Buffers are typed as ArrayBufferLike).
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha512Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-512", new Uint8Array(data)));
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", new Uint8Array(data)));
}
