/** Apply overrides to a server.properties text: replace keys in place, append new ones sorted. */
export function mergeProperties(existing: string, overrides: Record<string, string | number | boolean>): string {
  const remaining = new Map(Object.entries(overrides).map(([k, v]) => [k, String(v)]));
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const out = lines.map((line) => {
    const m = /^([^#!=\s][^=]*)=/.exec(line);
    const key = m?.[1]?.trim();
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const key of [...remaining.keys()].sort()) out.push(`${key}=${remaining.get(key)}`);
  return out.join("\n") + "\n";
}
