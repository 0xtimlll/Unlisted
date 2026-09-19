# Unlisted — OFT bridge UI

A form on top of LayerZero V2 OFT / OFTAdapter contracts — for tokens whose bridge is deployed and working but has no interface. You paste a contract address (or the hash of someone else's `send` transaction), connect a wallet, pick a destination and an amount. The app reads everything else from the contract, assembles the transaction, shows you exactly what it contains, and hands it to your wallet to sign.

**Canonical domain:** `oft-bridge-ui.pages.dev` (set in [`.env.production`](.env.production); shown in the app header).
Anything else claiming to be this app is not this app.

## What it does

- Probes an OFT contract on-chain (`token`, `approvalRequired`, `sharedDecimals`, `peers`, `enforcedOptions`, …) in one multicall. Contracts that don't answer like an OFT V2 are rejected.
- Builds `send(SendParam, MessagingFee, refundAddress)` from the quote (`quoteOFT` + `quoteSend`), with a fee buffer that is refunded by the contract.
- Runs 18 safety checks before the Send button is enabled (chain match, peer exists, balance, allowance, `fee.nativeFee === msg.value`, simulation, and a self-check that decodes the calldata back and compares it with what you see on screen).
- **Defends against look-alike contracts:** the destination-side peer must name your contract back (`peers(srcEid)` on the peer, read on the destination chain) — a fake adapter can point at the real OFT, but cannot make the real OFT point at it ([`src/core/verify.ts`](src/core/verify.ts)). For lock/unlock adapters the app also shows how much the adapter holds and flags an empty one. For a plain OFT, seeing your balance under the contract *is* the proof: the contract is the token.
- **Cross-checks on two RPC providers:** contract facts (`token`, `approvalRequired`, `peers`, …) and the sample transaction's `to`/calldata are read from two independent RPCs; disagreement blocks ([`src/core/quorum.ts`](src/core/quorum.ts)).
- **Sanitizes sample-transaction options:** only a receive-gas hint is copied from someone else's `extraOptions`; `nativeDrop` (native coin to an arbitrary address), `lzCompose` and anything unknown is dropped and shown in red ([`src/core/options.ts`](src/core/options.ts)).
- Slippage is capped at 5%; approve is always exact.
- Tracks delivery via LayerZero Scan.

## What it does NOT do

- **Never holds keys, funds or sessions.** No backend, no database, no custom contracts. It is a static site.
- **Never signs anything but `approve` and `send`.** No `eth_sign`, no `signTypedData`, no `permit`, no arbitrary calldata. Enforced by [`scripts/check-whitelist.mjs`](scripts/check-whitelist.mjs), which fails the build if any other write appears in `src/`.
- **Never sends unlimited approvals.** Approve is always for exactly the amount being sent, to exactly the probed OFT address. Unlimited approve does not exist in this codebase.
- **Never copies the recipient, refund address, fee or value-moving options from a sample transaction.** Recipient and refund are always your connected wallet unless you explicitly switch to a different address and re-type its last 6 characters.
- **Never sends addresses or amounts anywhere** except to the RPC of the chain you're using and (tx hash only) to LayerZero Scan. No analytics. WalletConnect telemetry is disabled.
- Does not take contract addresses or ABIs from explorers, token lists or any external API.

## Risks you still carry

- **An adapter is what you pasted.** For a plain OFT your balance proves the contract; for an OFTAdapter your balance belongs to the token, not the bridge — a fake adapter could lock your tokens. The app checks the peer back-link and the adapter's locked balance, but take the adapter address from the project's official sources.
- **Peers are trusted by the OFT, not by us.** If the OFT's owner points a peer at a malicious contract, tokens go there. The card shows the owner and yellow flags (EOA owner, proxy) — read them.
- **Cross-chain messages can get stuck** (rate limits, missing executor gas, paused destinations). The app warns when `enforcedOptions` is empty and shows `quoteOFT` limits, but delivery is the contract's and LayerZero's job, not ours.
- **Transactions are irreversible.** Test with a small amount first.
- Public RPCs see your address, like they do for every dapp.

We never message first, never DM, never ask for keys or seed phrases.

## Run locally

Requires Node ≥ 20 (`brew install node`).

```sh
npm ci
npm run dev             # http://localhost:3000
npm test                # write whitelist check + unit tests
npm run build           # static export to out/ + security headers
npm start               # serve out/ with the same headers as production
```

Build-time env — public values live in [`.env.production`](.env.production) (committed), local overrides in `.env.local`:

| var | purpose |
|---|---|
| `NEXT_PUBLIC_CANONICAL_DOMAIN` | shown in the footer so users can spot phishing clones |
| `NEXT_PUBLIC_REPO_URL` | source link in the footer |
| `NEXT_PUBLIC_WC_PROJECT_ID` | enables WalletConnect (mobile wallets via QR). **Off in v1** — only browser wallets (MetaMask, Rabby, …). Enabling it also opens the WalletConnect relay in the CSP. Get an id at cloud.reown.com. |
| `NEXT_PUBLIC_COMMIT` | build id in the footer; defaults to `git rev-parse HEAD` (Cloudflare/Vercel commit env is picked up automatically) |
| `CSP_CONNECT_EXTRA` | extra `connect-src` hosts for the generated CSP, space-separated |

### Tests

- `npm run test:unit` — pure logic in `src/core` (amounts, encoding, plan, options, quorum, all 18 guards).
- `npm run test:integration` — read-only tests against public RPCs (TREAD, USDT0, peer back-links, two-RPC quorum, CORS/chainId health of every registry RPC), plus **fork tests** that execute real `approve`/`send` on a local anvil fork. Fork tests need Foundry (`brew install foundry`) and are skipped without it.
- The `decodeTx` live test uses a real historical TREAD send by default; `OFT_TEST_SEND_TX=0x…` checks another one.

## Deploy

No server, no VPS. The build is a folder of static files; Cloudflare Pages hosts it for free.

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
   Build command `npm run build`, output directory `out`, Node version 24 (`NODE_VERSION=24` in the project env vars).
3. Every push to `main` deploys. `out/_headers` is applied automatically — verify with `curl -I https://oft-bridge-ui.pages.dev` (look for `Content-Security-Policy`).
4. Attaching a custom domain? Update `NEXT_PUBLIC_CANONICAL_DOMAIN` in `.env.production`.

### Private deployment (you and a few friends)

The site sends `X-Robots-Tag: noindex` and a `Disallow: /` robots.txt, so search engines stay away — but the URL itself is still public. To require a login without adding any code or server, put **Cloudflare Access** in front of the Pages project (free for up to 50 users):

1. Cloudflare dashboard → Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Application domain: `oft-bridge-ui.pages.dev` (and your custom domain, if any).
3. Policy: Action *Allow*, Include → *Emails* → list the addresses of everyone who may use it.
4. Save. Visitors now get a Cloudflare login page and a one-time code by email; nobody else can even load the HTML.

Access sits in front of the static files; the app, its CSP and its "no backend" property are unchanged. Wallet connections still happen only in the visitor's own browser.

Security headers are generated into `out/_headers` (Cloudflare Pages / Netlify format) and `out/csp.txt` (for nginx & co.) by [`scripts/gen-headers.mjs`](scripts/gen-headers.mjs) after every build. What they contain:

- `script-src 'self'` + SHA-256 hashes of the inline scripts Next.js emits — no `'unsafe-inline'` for scripts.
- `connect-src` is exactly the RPC list from [`src/core/chains.ts`](src/core/chains.ts) + `scan.layerzero-api.com` (+ WalletConnect relay only when `NEXT_PUBLIC_WC_PROJECT_ID` is set).
- `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `Referrer-Policy: no-referrer`, HSTS.

Because `connect-src` is strict, a user-supplied RPC in settings only works if its host is allow-listed (`CSP_CONNECT_EXTRA`) — that is intentional on the canonical domain. Hosts that cannot apply per-path headers from the build output (e.g. Vercel with `vercel.json`) need the CSP copied from `out/csp.txt` after each build, since the script hashes change with every build.

## Layout

```
src/core     pure logic, no React: abi, chains, amounts, plan, guards, probe, decodeTx, track
src/ui       wagmi/RainbowKit providers, hooks, components, localStorage
src/i18n     UI strings (EN)
scripts      build, headers, write-whitelist check, local server
tests/core   unit tests (vitest)
tests/integration   live-RPC + anvil fork tests
```

Everything that touches money lives in `src/core` and is covered by tests. Dependencies are pinned exactly; `npm audit` is clean; every new dependency is a deliberate decision.

## License

MIT
