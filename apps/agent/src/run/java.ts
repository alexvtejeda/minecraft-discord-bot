/** 'openjdk version "25.0.4"' → 25, 'java version "1.8.0_392"' → 8. */
export function parseJavaMajor(output: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] ? Number(m[2]) : first;
}

/** Major version of the java on PATH (or javaBin), or null if it can't be run. */
export function javaMajor(javaBin = "java"): number | null {
  try {
    const p = Bun.spawnSync([javaBin, "-version"]);
    return parseJavaMajor(p.stderr.toString() + p.stdout.toString());
  } catch {
    return null;
  }
}
