/**
 * Minimal JSON-RPC over fetch. No SDK, no build step, no API key.
 *
 * The CORS reality, stated plainly because it decides what this page can do:
 * a browser can only call an RPC endpoint that returns permissive CORS headers.
 * Arc's public RPC echoes the request Origin, which is why arc-guard works as a
 * static page. Ethereum's public endpoints are less predictable, so the default
 * list is a starting point and the user can supply their own endpoint. A CORS
 * failure is surfaced as such rather than as a generic "failed to fetch",
 * because that ambiguity is where hours go to die.
 */

export const DEFAULT_URLS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
];

/** EIP-7702 delegation designator: 0xef0100 followed by a 20-byte address. */
export function delegationTarget(code) {
  if (typeof code !== "string") return null;
  const hex = code.toLowerCase();
  if (!hex.startsWith("0xef0100")) return null;
  const body = hex.slice(8);
  if (body.length !== 40) return null;
  return "0x" + body;
}

export class RpcError extends Error {}

export class Rpc {
  /**
   * @param {string|null} url force a single endpoint, or null to use the defaults
   * @param {number} timeoutMs
   */
  constructor(url = null, timeoutMs = 15000) {
    this.urls = url ? [url] : [...DEFAULT_URLS];
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.lastUrl = null;
  }

  async call(method, params = []) {
    let lastError = null;
    for (const url of this.urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: controller.signal,
        });
        if (!response.ok) throw new RpcError(`${url} returned HTTP ${response.status}`);
        const body = await response.json();
        if (body.error) {
          throw new RpcError(`${url}: ${body.error.message ?? JSON.stringify(body.error)}`);
        }
        this.lastUrl = url;
        return body.result;
      } catch (error) {
        // A TypeError from fetch is the CORS/network case. Name it, so the UI
        // can tell the user to supply their own endpoint instead of guessing.
        const isCors =
          error.name === "TypeError" &&
          /failed to fetch|networkerror|load failed/i.test(String(error.message));
        lastError = isCors
          ? new RpcError(
              `${url}: blocked or unreachable from the browser (likely CORS). ` +
                `Paste your own RPC endpoint above.`
            )
          : error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new RpcError(`no endpoint answered ${method}: ${lastError?.message ?? "unknown error"}`);
  }

  async chainId() {
    return Number(BigInt(await this.call("eth_chainId")));
  }

  async getCode(address) {
    return (await this.call("eth_getCode", [address, "latest"])) ?? "0x";
  }

  /** Read-only contract call. Returns "0x" when the call reverts on some nodes. */
  async callContract(to, data) {
    return await this.call("eth_call", [{ to, data }, "latest"]);
  }
}
