import type { ExeuntChain } from "@exeunt/mcp";
import { createMcpHttpHandler } from "./adapters/mcp.adapter.js";
import { createMcpController } from "./mcp.controller.js";
import { createMcpRouter } from "./mcp.routes.js";

/** Mounts the Exeunt MCP server (read, simulate, build unsigned transactions; never signs) at /mcp. */
export function createMcpModule(deps: { chain: ExeuntChain }) {
  return { router: createMcpRouter(createMcpController(createMcpHttpHandler(deps.chain))) };
}
