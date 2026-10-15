// Plan 18 E5 (H5.3): a model endpoint that speaks the OpenAI-style and Anthropic-style routes, answers from a script,
// and records every request. It is the one fake endpoint the tests share; the answer decides the behaviour under test.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface Recorded {
  path: string;
  method: string;
  model: string | null;
  authorization: string | undefined;
  xApiKey: string | undefined;
}

export interface FakeLlm {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** The script returns the status and the body for each request. The default answers 401: no model behind it. */
export async function startFakeLlm(script: (r: Recorded) => { status: number; body: unknown } = () => ({ status: 401, body: { error: { message: "fake endpoint" } } })): Promise<FakeLlm> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let model: string | null = null;
      try {
        model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string }).model ?? null;
      } catch {
        model = null;
      }
      const rec: Recorded = { path: req.url ?? "", method: req.method ?? "", model, authorization: req.headers["authorization"], xApiKey: req.headers["x-api-key"] as string | undefined };
      requests.push(rec);
      const answer = script(rec);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
