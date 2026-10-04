import { pino, type Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { RequestHandler } from "express";

export type { Logger };

/** Base JSON logger; every line carries the node id. Modules derive children with `{ module }`. */
export function createLogger(options: { nodeId: string; level: string }): Logger {
  return pino({ level: options.level, base: { nodeId: options.nodeId } });
}

/** Logs each request and response with its request id. */
export function httpLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger: logger.child({ module: "http" }),
    genReqId: (req) => req.id,
    customProps: (req) => ({ requestId: req.id }),
  });
}
