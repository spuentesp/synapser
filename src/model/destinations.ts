// Where a library provider may send its prompts and its key (plan 15 D3, P15.5). A name is resolved through a lookup that
// refuses every address it returns outside the public range; loopback stays allowed, because local models run there. An
// address written as a literal in the URL never goes through a lookup, so it is checked before the call. Redirects stay
// refused by the provider itself (IC3). File providers are the operator's own and keep their behaviour.

import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

const BLOCKED = new BlockList();
// IPv4: unspecified, private, carrier-grade NAT, link-local (the cloud metadata address lives here), documentation,
// benchmarking, multicast and reserved ranges
for (const range of [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
]) {
  const [net, prefix] = range.split("/");
  BLOCKED.addSubnet(net!, Number(prefix), "ipv4");
}
// IPv6: unspecified, unique local (includes the cloud metadata address fd00:ec2::254), link-local, multicast, documentation
BLOCKED.addAddress("::", "ipv6");
BLOCKED.addSubnet("fc00::", 7, "ipv6");
BLOCKED.addSubnet("fe80::", 10, "ipv6");
BLOCKED.addSubnet("ff00::", 8, "ipv6");
BLOCKED.addSubnet("2001:db8::", 32, "ipv6");

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is judged by the IPv4 address it carries. */
function plain(address: string): { address: string; family: 4 | 6 } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: 4 };
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

/** True for an address a library provider may not reach: private, link-local, metadata or reserved. Loopback is allowed. */
export function isBlockedAddress(address: string): boolean {
  const { address: a, family } = plain(address);
  if (family === 4 && a.startsWith("127.")) return false;
  if (family === 6 && a === "::1") return false;
  return BLOCKED.check(a, family === 4 ? "ipv4" : "ipv6");
}

/** Resolves a name to all its addresses. The default is the system resolver; tests inject their own. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The lookup the connection uses. Every address the name resolves to must be allowed; one private address refuses the
 * name, because a name with a public and a private answer is how a rebinding attack starts.
 */
export function guardedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: unknown, family?: number) => void) => {
    resolve(hostname).then(
      (addresses) => {
        const blocked = addresses.find((a) => isBlockedAddress(a.address));
        if (blocked) {
          callback(new Error(`destination ${hostname} resolves to ${blocked.address}, a private address (plan 15 D3)`));
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]?.address, addresses[0]?.family);
      },
      (err: Error) => callback(err),
    );
  }) as LookupFunction;
}

/** A fetch for library providers: undici with the guarded lookup, and a literal private address refused before the call. */
export function destinationFetch(resolve?: Resolver): typeof fetch {
  const agent = new Agent({ connect: { lookup: guardedLookup(resolve) } });
  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isBlockedAddress(host)) return Promise.reject(new Error(`destination ${host} is a private address (plan 15 D3)`));
    // undici wraps a refused connection in "fetch failed": the reason of a D3 refusal is the cause, and that is what is raised
    return (undiciFetch(input as never, { ...(init ?? {}), dispatcher: agent } as never) as unknown as Promise<Response>).catch((e: unknown) => {
      const cause = (e as { cause?: unknown })?.cause;
      throw cause instanceof Error && /plan 15 D3/.test(cause.message) ? cause : e;
    });
  };
  return guarded as unknown as typeof fetch;
}

let shared: typeof fetch | undefined;
/** The one guarded fetch the process shares for library providers (its agent pools connections). */
export function libraryFetch(): typeof fetch {
  shared ??= destinationFetch();
  return shared;
}
