# ClearSign

**Does this contract verify the domain your wallet signs?**

A static page that recomputes an EIP-712 domain separator the way a wallet
would, and compares it against the contract's own `DOMAIN_SEPARATOR()`. Built
for the bug where a one-word typo in a domain field compiles, deploys, and
silently breaks every signature — nothing reverts, the signature is simply
invalid forever.

It **never says "safe"**. When it cannot verify something, it says so.

Live: **https://0xZumii.github.io/ClearSign/**

Companion to [`evm-audit`](https://github.com/0xZumii/evm-audit), which does the
same thing from the CLI. The two are pinned to one external reference — see
*Correctness* below.

## Why a page and not just a CLI

The CLI takes a file path. A page can take the thing you are actually about to
sign:

- paste an `eth_signTypedData_v4` payload (what MetaMask is showing you),
- see the digest recomputed, the domain compared against the chain, and the
  signer recovered —

**before you click sign.** That is a capability the CLI cannot reach, not a
nicer interface.

The other tab verifies a contract: paste an address, get the declared domain,
the on-chain separator, the recomputed separator, and whether they match.

## Scope: EVM chains, and why not others

ClearSign checks **EVM chains**. It works anywhere EIP-712 signatures are used,
because that standard defines exactly how the hash is computed — which is what
makes a definitive answer possible.

Chains without an equivalent standard are **not unsupported, they are
uncheckable**, and pretending otherwise would produce confident nonsense:

- **Solana** has no standardised typed-data signing. A signature there is opaque
  bytes that only the program can interpret, and there is no domain separator to
  compare against. A Solana drain is usually an *approved transaction*, not an
  off-chain signature, so inspecting one is a transaction-decoding problem — a
  different tool with different inputs.
- **Bitcoin and similar** have no on-chain contract to query at all.

On an EVM chain, ClearSign also refuses to guess: it reads the endpoint's own
chain id and reports `WRONG CHAIN` if that does not match the payload's
`chainId`, because every other read describes whatever contract sits at that
address *on the endpoint's chain*.

## What the wallet already tells you

MetaMask and similar wallets have improved. A modern prompt says "Spending cap:
Unlimited", names the spender, and shows the network. If the wallet already says
it, ClearSign repeating it adds nothing.

What a wallet **cannot** do, because it would require querying the chain:

| ClearSign adds | Why the wallet can't |
| :--- | :--- |
| Whether the permit has been submitted yet | Needs `nonces(owner)` — the wallet calls nothing |
| Whether it expires, or never can | Needs the `deadline` interpreted, not just displayed |
| Whether the contract will *accept* the signature | Needs the separator compared |
| The spender's history — code size, transactions sent | Needs `eth_getCode` and `eth_getTransactionCount` |

So the tool's job is the part the wallet is silent about, not the part it already
covered.

## Quick start

No build step, no dependencies, no API key.

```bash
npm run serve        # http://localhost:5174
```

The server exists only to set correct MIME types for ES modules; opening
`index.html` from disk will not work because native module imports are blocked
by the `file://` origin.

## The CORS reality

A browser can only call an RPC endpoint that returns permissive CORS headers.
The page tries three public Ethereum endpoints and falls back to whatever you
paste into the RPC field. A CORS failure is reported **as** a CORS failure,
with the fix, rather than as a generic "failed to fetch" — that ambiguity is
where hours go to die.

If the defaults are blocked, paste any endpoint you trust: a local node, Alchemy,
Infura.

## Status vocabulary

The labels are deliberately not binary. `unverified` and `no_domain` are **not**
passes, and the UI never renders them as a green tick. Collapsing them into one
would be how this tool loses its credibility.

| Status | Meaning |
| :--- | :--- |
| `domain matches` | Recomputed separator equals the on-chain one |
| `MISMATCH` | They differ — this is the silent failure |
| `cannot verify` | The contract exposes `DOMAIN_SEPARATOR()` but no name to check against |
| `no EIP-712 domain found` | No separator and no declared domain |
| `EIP-7702 delegated` | The account's code is a delegation designator; the domain lives elsewhere |
| `no contract here` | Nothing deployed at the address |

### Pre-ERC-5267 contracts

USDC and DAI expose `DOMAIN_SEPARATOR()` but not `eip712Domain()`, so there is
nothing on-chain to read a name from. Supply the name the contract was
**deployed** with and it can be verified. A wrong name will show up as a
mismatch — which is the point, and is tested.

## Correctness

The EIP-712 hashing and the secp256k1 recovery are pure and dependency-free
(`lib/eip712.js`). They are validated against the **spec's own published
vector**: EIP-712's `Mail` example publishes a known signature and signer, and
`tests/spec-vector.test.mjs` asserts we recover that exact address.

That reference is external to both implementations. `evm-audit`'s Python tests
use the same vector, so the two ports cannot silently drift apart — if either
diverges, its own test fails.

`lib/keccak.js` is shared with [`arc-guard`](https://github.com/0xZumii/ArcGuard)
and is itself a port of `evm_audit/keccak.py`. It is one file, copied rather
than vendored as a package, so **a change to one must be mirrored in the other**.
The Keccak-256 permutation is fixed and tested, so this is a small risk — but it
is a real one, and worth stating.

```bash
npm test           # spec vector + rendered-output guards (no network)
npm run test:live  # against live mainnet
npm run test:all
```

The three suites answer different questions:

- **`spec-vector`** — are the hashing and the curve maths correct? Pinned to the
  EIP-712 spec's published signature, which is external to both this port and
  the Python one.
- **`render`** — does the page ever *present* an unverified result as a pass?
  This is the credibility invariant, and it is tested against the real rendering
  path, not a mock. It includes the case where the same name is pointed at a
  different address, which must be a mismatch because the separator is bound to
  the address.
- **`live`** — does it work against a real chain?
  - USDC verifies when its deployed name/version are supplied
  - a **wrong** name produces a loud mismatch, not a quiet pass
  - Aave verifies with no help at all (it implements ERC-5267)
  - a fabricated payload domain is caught against the chain
  - a 7702-delegated account is reported as delegated, not as clean

## Deploying

The site is static. Publish it anywhere that serves files over HTTP — GitHub
Pages, Netlify, an S3 bucket.

For GitHub Pages: push, then **Settings → Pages → Deploy from a branch →
`main` / `/ (root)`**. `.nojekyll` is committed, which stops Jekyll from
processing the directory; without it, Pages has a habit of rewriting or refusing
to serve files it does not recognize, and the symptom looks like "the scripts
do not load".

Pages deploys the **repository root**, so `index.html` must stay there — it is
the app, not a redirect. (This differs from `arc-guard`, where the site lives in
`docs/` and the root `index.html` exists only to redirect past Jekyll's
README fallback.)

`npm run serve` exists only for local work: it sets the correct MIME types for
native ES modules. Opening `index.html` from disk will not work, because
`file://` blocks module imports.

## Sharing a report

The page accepts query parameters, so a result can be linked rather than
described:

```
index.html?address=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&name=USD%20Coin&version=2
```

It pre-fills and runs on load.

## Layout

```
index.html      the page
app.js          DOM wiring only; no judgement lives here
styles.css
.nojekyll       stops Jekyll from processing the directory on Pages
lib/
  eip712.js     EIP-712 hashing, ERC-5267 decoding, secp256k1 recovery
  keccak.js     Keccak-256 (reused from arc-guard; a port of evm_audit/keccak.py)
  rpc.js        JSON-RPC over fetch, with CORS diagnosed explicitly
  inspect.js    orchestration for both tabs
scripts/serve.mjs
tests/
  spec-vector.test.mjs   external correctness reference
  render.test.mjs        the never-show-a-false-pass guard
  live.test.mjs          against a real chain
```

## Honest limitations

- It is **not an oracle**. "No mismatch detected" is not "safe".
- A typo inside a **message** struct's type string (e.g. in `Permit`) is only
  caught if you supply a signature — then recovery fails and says so. The type
  string cannot be read out of bytecode, because `solc` folds the `keccak256`
  into a `PUSH32` of the result.
- The RPC endpoint sees your queries. Nothing else leaves the browser: no
  server, no accounts, no analytics.
- An endpoint can lie about chain state. This tool trusts the endpoint you give
  it; it does not verify state proofs.

MIT licensed.
