// Structural pieces for workflow drafts (plan 16, P16.6). Context-dependent checks such as command/profile
// references and workspace path containment stay in model.ts; this file owns reusable JSON shape predicates.
import { z } from "zod";

export const workflowObjectShape = z.custom<Record<string, unknown>>(
  (value) => value !== null && typeof value === "object",
);
export const workflowBooleanShape = z.boolean();
export const workflowCheckerKindShape = z.string();

export function workflowStringShape(min: number, max: number) {
  return z.string().refine((value) => value.trim().length >= min && value.length <= max);
}

export function workflowStringListShape(max: number) {
  return z.array(workflowStringShape(1, 600)).max(max);
}
