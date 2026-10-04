import { z } from "zod";
import { networkKeySchema } from "../../shared/utils/validation.js";

export const rpcParamsSchema = z.object({ network: networkKeySchema });

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});

/** A single JSON-RPC call or a batch of at most 50. */
export const rpcBodySchema = z.union([requestSchema, z.array(requestSchema).min(1).max(50)]);
