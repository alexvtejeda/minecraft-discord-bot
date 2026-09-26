import { LAUNCHER_JAR, type ServerMarker } from "../server/build";

export interface ServerProcess {
  /** Send one command line to the server's stdin. */
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  exited: Promise<number>;
}

export class LineSplitter {
  private buf = "";

  push(text: string): string[] {
    this.buf += text;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop()!;
    return parts;
  }
}

interface Waiter {
  pattern: RegExp;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The agent's view of the running server. Every write is one whole line, so commands you type
 * and commands the agent injects (save-off, chunky …) can never interleave inside a line.
 */
export class ServerConsole {
  private waiters: Waiter[] = [];
  private listeners: ((line: string) => void)[] = [];

  constructor(private server: ServerProcess) {
    server.onLine((line) => this.seen(line));
    void server.exited.then(() => this.close());
  }

  send(command: string): void {
    this.server.write(command);
  }

  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }

  waitFor(pattern: RegExp, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drop(w);
          reject(new Error(`Timed out waiting for ${pattern}`));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  private drop(w: Waiter) {
    this.waiters = this.waiters.filter((x) => x !== w);
  }

  private seen(line: string) {
    for (const cb of this.listeners) cb(line);
    for (const w of [...this.waiters]) {
      if (w.pattern.test(line)) {
        clearTimeout(w.timer);
        this.drop(w);
        w.resolve(line);
      }
    }
  }

  private close() {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("The server stopped."));
    }
    this.waiters = [];
  }
}

export function javaCommand(marker: ServerMarker, javaBin = "java"): string[] {
  return [javaBin, `-Xms${marker.memory.min}`, `-Xmx${marker.memory.max}`, "-jar", LAUNCHER_JAR, "nogui"];
}

/** Start the server with piped stdin/stdout; `echo` receives the raw output for the terminal. */
export function spawnProcess(cmd: string[], cwd: string, echo: (text: string) => void): ServerProcess {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const listeners: ((line: string) => void)[] = [];
  const split = new LineSplitter();
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      echo(text);
      for (const line of split.push(text)) for (const cb of listeners) cb(line);
    }
  })();
  return {
    write(line) {
      try {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      } catch {
        // The server already exited; the session notices through `exited`.
      }
    },
    onLine(cb) {
      listeners.push(cb);
    },
    exited: proc.exited,
  };
}
