#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpConfig } from "./config.js";
import { createExeuntMcpServer } from "./server.js";

// stdout carries the MCP protocol; diagnostics go to stderr only.
async function main(): Promise<void> {
  const server = createExeuntMcpServer(loadMcpConfig());
  await server.connect(new StdioServerTransport());
  process.stderr.write("exeunt-mcp: ready on stdio (read, simulate and build unsigned transactions; never signs)\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`exeunt-mcp: failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
