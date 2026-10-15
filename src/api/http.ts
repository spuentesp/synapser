// Shared by the API routes: the JSON and error replies, the body reader, and the operator the server acts as.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../workflow/manager.ts";

export const OPERATOR: Actor = { id: "ui:operator", role: "operator" };

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
};
export const fail = (res: ServerResponse, status: number, code: string, detail?: string): void => json(res, status, { error: code, ...(detail ? { detail } : {}) });

export async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) return void fail(res, 413, "TOO_LARGE");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return void fail(res, 400, "BAD_JSON");
  }
}
