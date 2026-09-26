import { UserError } from "@mc/profile";

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

/** Throw a UserError unless a new enough Java is available. */
export function requireJava(marker: { minecraft: string; javaMajor: number }, javaBin?: string): void {
  const java = javaMajor(javaBin);
  if (java === null) {
    throw new UserError(`Java isn't installed or isn't on your PATH. Minecraft ${marker.minecraft} needs Java ${marker.javaMajor}.`);
  }
  if (java < marker.javaMajor) {
    throw new UserError(
      `Minecraft ${marker.minecraft} needs Java ${marker.javaMajor}, but this PC has Java ${java}. Install Java ${marker.javaMajor} and try again.`,
    );
  }
}
