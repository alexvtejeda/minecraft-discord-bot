function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));
}

/** Discord signs `timestamp + raw body` with the application's Ed25519 key. */
export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  body: string,
): Promise<boolean> {
  const key = hexToBytes(publicKeyHex);
  const sig = signatureHex ? hexToBytes(signatureHex) : null;
  if (!key || key.length !== 32 || !sig || sig.length !== 64 || !timestamp) return false;
  try {
    const pub = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", pub, sig, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}
