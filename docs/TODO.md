# Known issues, not yet acted on

Each entry says what is wrong, why it was left alone, and what would have to be true to close it.
Nothing here is a plan — it is a record, so a thing noticed once does not have to be noticed again.

---

## `decodeOptions` rejects a legacy type-2 adapter param that the relayer would accept

**Where** [`src/core/options.ts`](../src/core/options.ts), the `type === 2` branch of `decodeOptions`.

**What** It requires the body to be exactly three 32-byte words (gas, value, a 32-byte receiver),
i.e. 50 bytes in total. The contract that actually reads these bytes, `RelayerV2._getPrices`
(LayerZero-Labs/LayerZero, `contracts/RelayerV2.sol`), documents and enforces a different shape:

```
// txType 2
// bytes  [2       32        32            bytes[]         ]
// fields [txType  extraGas  dstNativeAmt  dstNativeAddress]
require(_adapterParameters.length == 34 || _adapterParameters.length > 66, …)
```

`dstNativeAddress` is a plain 20-byte address, so a real type 2 is 86 bytes and this decoder throws
on it.

**Why it was left alone** This code path serves the LayerZero **V2** tab's `extraOptions`, where the
legacy types are a corner case, and it fails safe: `sanitizeOptions` catches the throw, marks the
sample `malformed`, and copies nothing into the user's own send. The worst outcome is that a sample
transaction carrying a legacy type 2 is described as unreadable rather than as "carries a native
drop" — and a native drop would have been dropped either way. Changing a decoder on the V2 money
path to improve an error message is not a trade worth making without a reason to touch it.

The v1 tab does not share this code: [`src/protocols/lz-v1/adapterParams.ts`](../src/protocols/lz-v1/adapterParams.ts)
parses these bytes against RelayerV2's own rule, which is why the discrepancy showed up at all.

**To close it** Give `decodeOptions` the same length rule for type 2, with the receiver read as the
trailing bytes rather than a fixed word, and a unit test built from a real 86-byte type 2. Worth
doing the next time `options.ts` is opened for another reason.

---

## The `bytes` v1 standard has no live-mainnet verification

**Where** [`src/protocols/lz-v1/abi.ts`](../src/protocols/lz-v1/abi.ts), `UNVERIFIED_WIRES`.

**What** `OFT` / `ProxyOFT` — the original v1 standard, whose `_toAddress` is `bytes` and whose
destination reads the **first** 20 of them — is implemented and unit-tested, but no deployed
contract of that shape was found to test against. Searched three ways: `Packet` logs on the
UltraLightNode, `SendToChain` logs by topic (whose shape alone separates the two families), and
direct probes of candidate addresses. Every live v1 sender found is either a `bytes32` standard or
Stargate, whose contracts this app refuses for unrelated reasons.

**Why it matters** This is the standard where a mistake is unrecoverable: a 32-byte left-padded
address handed to it is delivered to twelve zero bytes.

**Held in the meantime** The route is held at UNVERIFIED by the eight checks, whatever the others
say, so the indicator is yellow with a reason that names the unverified standard and advises a test
amount first. That is information, not a cap (CLAUDE.md rule 2): nothing holds the button, and the
self-check still blocks a `bytes` recipient that is not exactly 20 bytes.

**To close it** Find a deployed `OFT` or `ProxyOFT` on a chain in the registry, add it to
`tests/integration/lzv1.live.test.ts` alongside the others, and remove `'bytes'` from
`UNVERIFIED_WIRES`.

---

## An NTT locking hub is always red, even a real one with locked supply

**Where** [`src/core/indicator.ts`](../src/core/indicator.ts) (`ntt_anchor_missing` in `RED_NOTES`),
[`src/protocols/wormhole-ntt/verify.ts`](../src/protocols/wormhole-ntt/verify.ts) (`anchor`).

**What** The owner's spec makes a locking hub green when it holds ≥ 0.1% of the token's supply and
has ≥ 20 outbound messages — the same rule the LayerZero adapters already follow. The NTT side does
not implement it yet: any manager the source token does not name as minter is red, so a genuine hub
(L3 on Ethereum, for example) shows "High risk". Only the colour is wrong. Since 2026-10-02 the
locked share IS read (`lockedBps` in `verify.ts`) and decides between the red note and the
`ntt_unvouched` block; it does not yet make a hub green, and the history part is not read at all.

**Why it was left alone** Deferred by the owner on 2026-10-01 until an outside review. The spec
also needs one decision first: a real hub usually has an anchor only on the destination side, which
the same spec lists as red. Proposed reading: locked share and history present → green; absent, and
only a destination-side anchor → red.

**To close it** Read `token.balanceOf(manager) / token.totalSupply()` on the source chain and an
outbound counter from the NttManager itself (there is no EndpointV2 in Wormhole), feed both into the
NTT indicator the way `lz-risk/adapters.ts` does, and add one green and one red case to
`tests/core/indicator.test.ts`.

---

## NTT v2 routes are refused: delivery needs the Wormhole Executor

**Where** [`src/protocols/wormhole-ntt/verify.ts`](../src/protocols/wormhole-ntt/verify.ts) (`executor_required`),
[`src/protocols/wormhole-ntt/abi.ts`](../src/protocols/wormhole-ntt/abi.ts) (`WORMHOLE_TRANSCEIVER_VERSION`).

**What** NTT 2.x (`NTT_MANAGER_VERSION` "2.0.0" live on Monad and BNB Chain, "2.0.1" on main)
dropped the standard relayer from `WormholeTransceiver`: `isWormholeRelayingEnabled` /
`isSpecialRelayingEnabled` are gone, `quoteDeliveryPrice` answers the core bridge's message fee
(zero), and the contract's own header says messages are "delivered manually via the core layer or
through external relayers/executors that call receiveMessage directly". In practice the Wormhole
Executor delivers: the sender's transaction also calls `requestExecution(dstChain, dstAddr,
refundAddr, signedQuote, requestBytes, relayInstructions)` on the Executor contract, paying a price
quoted and SIGNED by an off-chain API, and a relayer then calls `receiveMessage(vaa)` on the far
transceiver. A real Atlantis send on Monad (`0x49972f3a…8146`, 2026-10-15) went through a wrapper
(`0xc3F3dDa5…793e`: `transferFrom` user → wrapper → manager, then `manager.transfer`, then
`executor.requestExecution` on `0xC04dE634…3f65`, which emitted `RequestForExecution`); the BNB
Chain delivery (`0xd36dd0b8…6114`) came from an EOA through a small helper (`0x0e4eaf9c…e175`) into
`receiveMessage` on the spoke's transceiver.

This app builds a plain `manager.transfer(...)`. On a 2.x route that would burn or lock the tokens
and publish a message nobody delivers — the recipient would have to fetch the VAA and call
`receiveMessage` by hand. So the gate refuses a transceiver that answers no relaying getter and a
version other than 1.x, with its own reason, and the screen says what the route is.

**Why it was left alone** Supporting it is a new send path, not a fix: a signed quote from an
external API inside the calldata (CLAUDE.md rule 1 allows an API to narrow a search, and a quote is
a price, not a verdict — but the payee and the contract it goes to must be committed addresses
verified on chain, and Wormhole publishes the Executor addresses only in its SDK and docs); a second
write primitive (`requestExecution`, or `transfer` on an `NttManagerWithExecutor` whose code is not
in the `native-token-transfers` main tree); for the wrapper shape, an approve whose spender is the
wrapper rather than the verified manager, which the whitelist and guard 10 forbid today; and the
Status tab learning the Executor's request/relay states.

**To close it** Decide the shape first (two transactions from the EOA — `transfer`, then
`requestExecution` referencing the published sequence — keeps the approve on the manager and needs
no wrapper), commit the Executor contract per chain with an on-chain check, read the quote from the
Executor API as data and show the price, scope the new write to `wormhole-ntt/`, and add the
Atlantis route (`tests/integration/ntt.live.test.ts`) as the live fixture that must then verify.

---

## The red line for an address-book twin does not name the entry

**Where** [`src/core/indicator.ts`](../src/core/indicator.ts) (the `headline`),
`recipient_lookalike` in [`src/i18n/en.ts`](../src/i18n/en.ts).

**What** The spec's example is `Looks like "Bybit deposit", but this is a DIFFERENT address`. The
indicator says the generic sentence without the label. The label is already shown next to the
recipient field (`BookVerdictNote`), just not in the indicator's one visible line.

**Why it was left alone** Deferred by the owner on 2026-10-01.

**To close it** Let the screens pass the matched entry's label into `assessIndicator` and format the
`recipient_lookalike` text with it.

---

## A Hyperlane route that charges its gas in the token is refused rather than built

**Where** [`src/protocols/hyperlane/plan.ts`](../src/protocols/hyperlane/plan.ts) (`fee_token_unsupported`),
[`src/protocols/hyperlane/discover.ts`](../src/protocols/hyperlane/discover.ts) (`feeTokenIsNative`).

**What** Core 12+ warp routes can name a `feeHook()` and quote the Mailbox dispatch fee in the
token (`feeToken() == token()`). The router then pulls that fee with `transferFrom` on top of the
charge (a collateral route) or takes it from the sender's balance (a synthetic one), and the
allowance the approve has to cover is the charge plus that fee. This app models the native-fee case
only and refuses to build the other, naming the reason, so no approve is ever sent for an amount it
could not state exactly.

**Why it was left alone** No live route on the thirteen chains served here answers `feeToken()`
with anything but zero at the time of writing (checked on the registry's PAXG, ETH, HYPER, FUEL,
DOG and LUMIA routes); the generation that can is days old. Building the allowance arithmetic for a
case nobody can exercise would be code with no test behind it.

**To close it** When such a route exists on a served chain: read the hook fee through
`quoteTransferRemote`'s first quote (`token == token()`), add it to the charge for collateral routes,
model the separate `safeTransferFrom` for synthetic ones, and add the case to
`tests/core/hyperlane.test.ts` next to the 10+ quote test.

---

## A Hyperlane route's dispatch count is a window, and the window is short on a fast chain

**Where** [`src/protocols/hyperlane/discover.ts`](../src/protocols/hyperlane/discover.ts) (`countDispatches`).

**What** A warp route has no outbound counter of its own, and the Mailbox's `nonce()` is global, so
the route's history is the number of `Dispatch` events with it as the sender in the newest block
window a public provider will serve (50 000, then 10 000, then 2 000 blocks). On Ethereum that is a
week; on Arbitrum or Plasma, where a block is a second or less, it is hours. A quiet but genuine
route on such a chain can show fewer than twenty dispatches and be coloured "fresh" — a yellow
nuance with the window written into the reason, never a hold.

**Why it was left alone** Reading further back means many paged `eth_getLogs` calls on the
critical path of a verdict, against providers that already refuse long ranges. The OFT adapters have
the same signal with a counter (`outboundNonce` on the endpoint); Hyperlane simply does not keep one.

**To close it** Page backwards in the shrinking spans until twenty dispatches are found or a time
budget runs out, and say in the reason how far back the search reached (in days, from the block's
own timestamp — `windowDays` in `lz-risk/probe.ts` already does this).

---

## Monad's official RPC serves `eth_getLogs` over 100 blocks at most

**Where** [`src/core/chains.ts`](../src/core/chains.ts) (the `monad` entry),
[`src/protocols/lz-risk/probe.ts`](../src/protocols/lz-risk/probe.ts) (`scanNewest`, spans 50 000 / 10 000 / 2 000),
[`src/protocols/hyperlane/discover.ts`](../src/protocols/hyperlane/discover.ts) (`countDispatches`, the same spans).

**What** `rpc.monad.xyz` answers `eth_getLogs` only for ranges of 100 blocks (30 seconds at
Monad's 300 ms block time); the two fallbacks serve 2 000 (swiftnodes) and 1 000 (thirdweb). The
log scans try their three spans and give up, so with the official RPC as primary the route checks
that read history — check 7 and `recent_changes` in `lz-risk`, the dispatch count behind a
Hyperlane route's standing — come back "not checked" on Monad, and the indicator is yellow with
that reason. Nothing is wrong about the route; the provider simply will not say.

**Why it was left alone** A 100-block span would make the result meaningless rather than absent,
and reading further back means tens of paged calls on the verdict's critical path. The operator's
RPC stays primary because it is the one the chain's own documentation names.

**To close it** Page backwards in the spans the fallback providers serve (the same change the
Hyperlane dispatch-count entry above asks for), or let the user's own RPC take over: a node set
through `NEXT_PUBLIC_RPC_MONAD` or in Settings becomes the primary and usually serves wide ranges.

---

## The v1 form still switches to a custom recipient with a checkbox

**Where** [`src/ui/BridgeV1.tsx`](../src/ui/BridgeV1.tsx), the "I am sending to an address that is
not my wallet" control.

**What** It is an input-mode switch, not a risk acknowledgement, but it is the one checkbox left on
any send form. The V2, NTT and CCIP forms use an "Edit / Use my wallet" link for the same thing.

**Why it was left alone** Deferred by the owner on 2026-10-01.

**To close it** Replace it with the same link the other three forms use.

---

## The Solana send path still talks to its RPC from the page

**Where** [`src/core/svm/urls.ts`](../src/core/svm/urls.ts) (`svmRpcUrls`), [`src/core/svm/send.ts`](../src/core/svm/send.ts)
(`createSvmSendContext`, `umiFor`), [`src/core/rpcPolicy.ts`](../src/core/rpcPolicy.ts) (`SOLANA_PROVIDER_PATTERNS`).

**What** Every EVM read goes through the site's `/rpc` function since 2026-10-15, and the
Content-Security-Policy's connect-src is the site's origin for them. The Solana send path does not:
the LayerZero SDK's umi client assembles, dry-runs and submits the transaction through one direct
endpoint, and a submit (`sendTransaction`) is exactly what the function refuses. So the Solana hosts
stay in connect-src, a personal Solana RPC must be one of the known providers, and the Solana
dry run (as opposed to the probe, balances and status, which use `/rpc/solana`) bypasses the proxy.

**Why it was left alone** Moving the submit to the wallet (`signAndSendTransaction`) changes the
send path and the whitelist (`sendTransaction*` is forbidden under every name); letting the function
forward one write method contradicts the rule the function exists for. Either is a decision, not a fix.

**To close it** Decide between the two; with the wallet broadcasting, `/rpc/solana` can carry the
dry run too and connect-src becomes `'self'` plus the three APIs.

---

## Twenty-odd networks have one RPC operator, and sixteen have none the proxy can reach

**Where** [`src/core/networks.ts`](../src/core/networks.ts) (`NETWORKS_EXCLUDED`, and every entry with one `provider`).

**What** The generator keeps up to four verified public RPCs per chain, one per operator where it
can. For the long tail (Astar, Citrea, Conflux, Tempo and others) only one operator answers for
the chain, so the cross-check cannot run there and the route shows the `not_cross_checked` nuance;
sixteen chains the sources list have no public https RPC on the default port that answers
`eth_chainId` and serves the anchor contract at all (XRPL EVM's only endpoint names a port the
Workers runtime cannot reach, Nexus's does not resolve), and are recorded with the reason.

**Why it was left alone** A chain with one operator is still a chain with its protocols verified on
it; refusing it would contradict "every network with one of our protocols". A chain with no
reachable RPC cannot be served honestly.

**To close it** Set `RPC_<chainId>` in the Pages environment for a chain that matters (the function
puts it first, and it counts as its own operator), or add a second public RPC to
`scripts/networks-curated.json` and re-run `npm run update:networks`.
