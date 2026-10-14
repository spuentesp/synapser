import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import { validateLibraryDocument, NO_LIBRARY_POLICY } from "../../src/library/validate.ts";
import { destinationFetch, guardedLookup, isBlockedAddress, type Resolver } from "../../src/model/destinations.ts";

// Plan 15 D3 and P15.5. A library provider reaches public addresses and loopback (its local models), never private,
// link-local, metadata or reserved ones. A name is refused when any address it resolves to is one of those.

describe("which addresses a library provider may reach (plan 15 D3)", () => {
  test("private, link-local, metadata and reserved addresses are blocked", () => {
    for (const address of [
      "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "224.0.0.1", "240.0.0.1",
      "fc00::1", "fd00:ec2::254", "fe80::1", "::", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    ]) {
      assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
    }
  });

  test("public addresses and loopback are allowed", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:127.0.0.1"]) {
      assert.equal(isBlockedAddress(address), false, `${address} must be allowed`);
    }
  });
});

describe("the lookup refuses a name that resolves to a private address", () => {
  const lookupWith = (resolve: Resolver, all: boolean) =>
    new Promise<unknown>((ok, bad) => {
      guardedLookup(resolve)("provider.example", { all }, (err: Error | null, address?: unknown, family?: number) => {
        if (err) bad(err);
        else ok(all ? address : { address, family });
      });
    });

  test("one private answer refuses the name, even beside a public one", async () => {
    const mixed: Resolver = async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.7", family: 4 }];
    await assert.rejects(lookupWith(mixed, false), /resolves to 10\.0\.0\.7, a private address \(plan 15 D3\)/);
    await assert.rejects(lookupWith(mixed, true), /private address/);
  });

  test("a public name answers as the connection asked: one address, or the list", async () => {
    const pub: Resolver = async () => [{ address: "8.8.8.8", family: 4 }];
    assert.deepEqual(await lookupWith(pub, false), { address: "8.8.8.8", family: 4 });
    assert.deepEqual(await lookupWith(pub, true), [{ address: "8.8.8.8", family: 4 }]);
  });
});

describe("the fetch of a library provider", () => {
  let server: Server;
  let port: number;
  test("setup: a local server stands for the provider's own machine", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
  });

  test("a name that resolves to loopback reaches the local model", async () => {
    const local: Resolver = async (host) => (host === "local.test" ? [{ address: "127.0.0.1", family: 4 }] : []);
    const response = await destinationFetch(local)(`http://local.test:${port}/v1/models`);
    assert.equal(await response.text(), "reached");
  });

  test("a name that resolves to a private address never connects", async () => {
    const private_: Resolver = async () => [{ address: "10.9.9.9", family: 4 }];
    await assert.rejects(destinationFetch(private_)(`http://evil.example:${port}/v1/chat/completions`), /private address \(plan 15 D3\)/);
  });

  test("a private address written as a literal is refused before any call", async () => {
    await assert.rejects(destinationFetch()("http://169.254.169.254/latest/meta-data/"), /destination 169\.254\.169\.254 is a private address/);
    await assert.rejects(destinationFetch()("http://[fd00:ec2::254]/latest/"), /is a private address/);
  });

  test("teardown", async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  });
});

describe("a library provider's literal address is checked when it is written (plan 15 D3)", () => {
  const policy = { ...NO_LIBRARY_POLICY, providerKeyEnv: ["MODEL_KEY"] };
  const doc = (baseUrl: string) => ({ protocol: "openai-compatible", baseUrl, apiKeyEnv: ["MODEL_KEY"], models: [{ id: "m" }] });

  test("a metadata address is refused, with the reason", () => {
    assert.match(validateLibraryDocument("providers", "p", doc("http://169.254.169.254/v1/"), policy).join("\n"), /baseUrl 169\.254\.169\.254 is a private address/);
  });

  test("a loopback address is accepted for a local model", () => {
    assert.deepEqual(validateLibraryDocument("providers", "p", doc("http://127.0.0.1:8000/v1/"), policy), []);
  });
});
