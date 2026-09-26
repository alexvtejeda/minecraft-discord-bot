import type { ServerProcess } from "../src/host/console";

/** Answer the commands a real server answers, asynchronously like a real process. */
export function defaultRespond(line: string, s: FakeServer): void {
  if (line === "save-all flush") queueMicrotask(() => s.emit("[Server thread/INFO]: Saved the game"));
  if (line === "stop") queueMicrotask(() => s.exit(0));
}

export class FakeServer implements ServerProcess {
  written: string[] = [];
  private listeners: ((line: string) => void)[] = [];
  private resolveExit!: (code: number) => void;
  exited = new Promise<number>((resolve) => (this.resolveExit = resolve));

  constructor(
    private respond: (line: string, s: FakeServer) => void = defaultRespond,
    private events?: string[],
  ) {}

  write(line: string): void {
    this.written.push(line);
    this.events?.push(`server:${line}`);
    this.respond(line, this);
  }

  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }

  emit(line: string): void {
    for (const cb of this.listeners) cb(line);
  }

  exit(code: number): void {
    this.resolveExit(code);
  }
}
