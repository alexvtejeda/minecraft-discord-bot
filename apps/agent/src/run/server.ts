import { LAUNCHER_JAR, type ServerMarker } from "../server/build";

/** Run the server in the foreground with the console attached. Returns the exit code. */
export async function runServer(o: { dir: string; marker: ServerMarker; javaBin?: string }): Promise<number> {
  const proc = Bun.spawn(
    [o.javaBin ?? "java", `-Xms${o.marker.memory.min}`, `-Xmx${o.marker.memory.max}`, "-jar", LAUNCHER_JAR, "nogui"],
    { cwd: o.dir, stdio: ["inherit", "inherit", "inherit"] },
  );
  return whileChildRuns(proc.exited);
}

/**
 * Ignore Ctrl+C in mc-host while the server runs. The terminal sends it to Java too, which
 * saves the world and exits; mc-host must wait for that instead of returning the prompt early.
 */
export async function whileChildRuns<T>(exited: Promise<T>): Promise<T> {
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    return await exited;
  } finally {
    process.off("SIGINT", ignore);
  }
}
