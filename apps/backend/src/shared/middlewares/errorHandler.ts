import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, ErrorCode } from "../errors/AppError.js";
import type { Logger } from "./logger.js";

/** Unknown routes become a 404 AppError. */
export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError(404, ErrorCode.NOT_FOUND, `No route for ${req.method} ${req.path}`));
  };
}

function bodyParserError(err: unknown): AppError | null {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === "entity.parse.failed") return new AppError(400, ErrorCode.INVALID_JSON, "Request body is not valid JSON");
  if (type === "entity.too.large") return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, "Request body is too large");
  return null;
}

/** The only place that shapes error responses: `{ code, message, details? }`. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  const log = logger.child({ module: "http" });
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      log.error({ err, requestId: req.id }, "error after response started");
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        code: ErrorCode.VALIDATION_ERROR,
        message: "Invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const appError = err instanceof AppError ? err : bodyParserError(err);
    if (appError) {
      if (appError.statusCode >= 500) log.error({ err: appError, requestId: req.id }, appError.message);
      const body: { code: string; message: string; details?: unknown } = { code: appError.code, message: appError.message };
      if (appError.details !== undefined) body.details = appError.details;
      res.status(appError.statusCode).json(body);
      return;
    }
    log.error({ err, requestId: req.id }, "unhandled error");
    res.status(500).json({ code: ErrorCode.INTERNAL_ERROR, message: "Internal server error" });
  };
}
