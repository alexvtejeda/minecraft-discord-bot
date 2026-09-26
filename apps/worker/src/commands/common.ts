import { mention } from "../discord/format";

export const NO_WORLD = "There's no active world. A maintainer can start one with `/world new`.";

export const hostingNow = (holderId: string): string =>
  `${mention(holderId)} is hosting right now. Wait for them to stop, or use \`/host release\` if the session is stuck.`;
