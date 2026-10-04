import type { RequestHandler } from "express";

/** CORS for the web app and remote MCP clients. `origins` is "*" or a comma-separated allow-list. */
export function cors(origins: string): RequestHandler {
  const allowList = origins === "*" ? null : origins.split(",").map((o) => o.trim()).filter(Boolean);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!allowList) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      res.append("Vary", "Origin");
      if (origin && allowList.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, X-Request-Id, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    );
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
