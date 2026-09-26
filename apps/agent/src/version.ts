import pkg from "../package.json";

/** Baked in by `bun build --compile`; the release tag must match it. */
export const VERSION: string = pkg.version;
