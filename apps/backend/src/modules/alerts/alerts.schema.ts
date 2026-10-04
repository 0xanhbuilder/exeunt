import { z } from "zod";
import { addressSchema, networkKeySchema } from "../../shared/utils/validation.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** https anywhere, or plain http only to this machine (local development receivers). */
export function isAllowedWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

export const createAlertSchema = z.object({
  network: networkKeySchema,
  thresholdBps: z.number().int().min(1).max(10_000),
  webhookUrl: z
    .string()
    .max(2_048)
    .refine(isAllowedWebhookUrl, "webhookUrl must be https, or http://localhost / http://127.0.0.1")
    .optional(),
  owner: addressSchema,
});
export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const ownerQuerySchema = z.object({ owner: addressSchema });
export type OwnerQuery = z.infer<typeof ownerQuerySchema>;

export const alertIdParamsSchema = z.object({ id: z.string().uuid() });
export type AlertIdParams = z.infer<typeof alertIdParamsSchema>;
