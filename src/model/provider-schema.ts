// Structural provider shapes shared by operator config and library validation (plan 16, P16.6).
// Unknown keys intentionally pass through: existing operator files may carry them without being rewritten here.
import { z } from "zod";

export const providerModelShape = z.object({
  id: z.unknown().optional(),
  usdPer1MIn: z.unknown().optional(),
  usdPer1MOut: z.unknown().optional(),
}).passthrough();

// Match the validator's historical object boundary exactly: arrays are objects here and receive field-level errors.
export const providerDocumentShape = z.custom<Record<string, unknown>>(
  (value) => value !== null && typeof value === "object",
);

export const providerProtocolShape = z.string();
export const providerBaseUrlShape = z.string();
export const providerKeyNamesShape = z.array(z.unknown());
export const providerModelsShape = z.array(z.unknown());
