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

**Held in the meantime** The route is held at UNVERIFIED by the risk indicator, whatever the other
checks say, with a reason that names the unverified standard and advises a test amount first. That
is a warning, not a cap (CLAUDE.md rule 2): the single tick opens any amount, and the self-check
still blocks a `bytes` recipient that is not exactly 20 bytes.

**To close it** Find a deployed `OFT` or `ProxyOFT` on a chain in the registry, add it to
`tests/integration/lzv1.live.test.ts` alongside the others, and remove `'bytes'` from
`UNVERIFIED_WIRES`.
