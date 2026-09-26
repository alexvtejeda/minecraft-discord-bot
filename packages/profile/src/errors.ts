/** An error written for the person running the tool. The CLI prints only its message. */
export class UserError extends Error {
  override name = "UserError";
}
