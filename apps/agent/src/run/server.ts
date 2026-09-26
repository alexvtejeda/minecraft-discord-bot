import { LAUNCHER_JAR, type ServerMarker } from "../server/build";

/** Run the server in the foreground with the console attached. Returns the exit code. */
export async function runServer(o: { dir: string; marker: ServerMarker; javaBin?: string }): Promise<number> {
  const proc = Bun.spawn(
    [o.javaBin ?? "java", `-Xms${o.marker.memory.min}`, `-Xmx${o.marker.memory.max}`, "-jar", LAUNCHER_JAR, "nogui"],
    { cwd: o.dir, stdio: ["inherit", "inherit", "inherit"] },
  );
  return await proc.exited;
}
