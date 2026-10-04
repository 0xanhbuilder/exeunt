import type { IncomingMessage, ServerResponse } from "node:http";
import { handleStreamableHttpRequest, type ExeuntChain } from "@exeunt/mcp";

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;

/** Serves the Exeunt MCP server over Streamable HTTP (stateless: one server per request, chain layer shared). */
export function createMcpHttpHandler(chain: ExeuntChain): McpHttpHandler {
  return (req, res, body) => handleStreamableHttpRequest(req, res, body, { chain });
}
