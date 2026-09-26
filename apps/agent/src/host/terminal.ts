interface LineSource {
  on(event: "line", cb: (line: string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
}

/**
 * The one reader of the terminal. While a question is pending the next line answers it;
 * otherwise lines go to the server console (when forwarding is on).
 */
export class TerminalInput {
  private pending: ((line: string) => void) | null = null;
  private forward: ((line: string) => void) | null = null;
  private closed = false;

  constructor(source: LineSource) {
    source.on("line", (line) => {
      if (this.pending) {
        const answer = this.pending;
        this.pending = null;
        answer(line);
      } else {
        this.forward?.(line);
      }
    });
    source.on("close", () => {
      this.closed = true;
      this.pending?.("");
      this.pending = null;
    });
  }

  /** With no terminal attached (EOF), questions get "" so defaults apply instead of hanging. */
  ask(question: string, out: (text: string) => void): Promise<string> {
    out(question);
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => (this.pending = resolve));
  }

  forwardTo(cb: ((line: string) => void) | null): void {
    this.forward = cb;
  }
}
