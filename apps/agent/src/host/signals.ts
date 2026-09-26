const hooked: (() => void)[] = [];
let installed = false;

/**
 * Run `handler` on Ctrl+C / SIGINT / SIGTERM / SIGHUP (a closed console window on Windows)
 * until the returned unhook is called; the most recently hooked handler wins. The process listeners are installed once and never removed:
 * under Bun 1.3.3, `process.off` of one SIGINT listener uninstalls the native handler even
 * while others remain, so the next signal killed mc-host without saving (exit 130).
 */
export function onStopSignal(handler: () => void): () => void {
  if (!installed) {
    installed = true;
    // With nothing hooked, exit as the signal would have without a listener.
    const dispatch = (code: number) => () => {
      const handler = hooked.at(-1);
      if (handler) handler();
      else process.exit(code);
    };
    process.on("SIGINT", dispatch(130));
    process.on("SIGTERM", dispatch(143));
    process.on("SIGHUP", dispatch(129));
  }
  hooked.push(handler);
  return () => {
    const i = hooked.lastIndexOf(handler);
    if (i >= 0) hooked.splice(i, 1);
  };
}
