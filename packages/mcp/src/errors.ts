/** An error caused by the caller's input or the current market state, returned to the agent as a tool error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Message shown to the agent for any failure inside a tool. */
export function errorMessage(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof Error) {
    const short = (err as Error & { shortMessage?: unknown }).shortMessage;
    return `Chain request failed: ${typeof short === "string" ? short : err.message}`;
  }
  return "Unknown error";
}
