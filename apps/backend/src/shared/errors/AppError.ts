/** The only error class thrown on purpose; the error handler turns it into `{ code, message, details? }`. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_JSON: "INVALID_JSON",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  DEPLOYMENT_NOT_FOUND: "DEPLOYMENT_NOT_FOUND",
  ALERT_NOT_FOUND: "ALERT_NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  FAUCET_FORK_ONLY: "FAUCET_FORK_ONLY",
  FAUCET_RATE_LIMITED: "FAUCET_RATE_LIMITED",
  FAUCET_BUSY: "FAUCET_BUSY",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  NOT_READY: "NOT_READY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
