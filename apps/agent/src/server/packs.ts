/** "afk display v1.1.17 (MC 26.2).zip" → "afk-display". Null for non-zip files. */
export function packNameFromFilename(filename: string): string | null {
  if (!filename.toLowerCase().endsWith(".zip")) return null;
  const base = filename.slice(0, -4).replace(/\s+v\d[\w.]*(\s*\([^)]*\))?\s*$/i, "");
  const name = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name || null;
}

/** Match profile pack ids ("vt:afk-display") to files by the part after the colon. */
export function matchPacks(ids: string[], filenames: string[]): { found: Map<string, string>; missing: string[] } {
  const byName = new Map<string, string>();
  for (const f of filenames) {
    const n = packNameFromFilename(f);
    if (n) byName.set(n, f);
  }
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const file = byName.get(id.slice(id.indexOf(":") + 1));
    if (file) found.set(id, file);
    else missing.push(id);
  }
  return { found, missing };
}
