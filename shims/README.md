# Dependency stand-ins

`@layerzerolabs/oft-v2-solana-sdk` (the LayerZero Solana OFT SDK we use to build the `send`
instruction) declares helper packages that this app never needs at runtime but which pull in a
large, node-oriented dependency tree: mnemonic/keypair libraries for six chains (`bip39`,
`ed25519-hd-key`, `tronweb`, `aptos`, `@ton/*`, `@mysten/sui`, `@initia/*`), `ethers`, `pino`, and
node core modules (`fs`, `http`). None of that belongs in a browser wallet UI — or, for that matter,
in `node_modules` of one.

Two mechanisms keep them out, and `tests/core/shims.test.ts` guards both:

1. **`package.json` → `overrides`** replaces the four packages with `empty-npm-package@1.0.0`
   (a 328-byte package containing nothing; pinned by version and lockfile integrity hash). They are
   never installed, so `npm ci` brings ~500 fewer packages and no key-derivation code exists on disk.
2. **`next.config.ts` (the browser build) and `vitest.config.mts` (tests)** alias the module names
   to the files in this folder, which provide the six functions the SDK's built code actually imports:

| package                               | what the SDK actually imports from it            | stand-in            |
| ------------------------------------- | ------------------------------------------------ | ------------------- |
| `@layerzerolabs/lz-utilities`         | `arrayify`, `hexlify`, `isHex`, `padify`          | `lz-utilities/`     |
| `@layerzerolabs/lz-foundation`        | `keccak_256`, `sha2_256`                          | `lz-foundation/`    |
| `@layerzerolabs/lz-serdes`            | nothing (declared, never imported by `dist/`)     | `false` (build) / empty package |
| `@layerzerolabs/lz-corekit-solana`    | nothing (declared, never imported by `dist/`)     | `false` (build) / empty package |
| `@layerzerolabs/tron-utilities`       | nothing (declared, never imported by `dist/`)     | `false` (build)     |
| `@layerzerolabs/lz-solana-sdk-v2` — **root entry only**; the `/umi` entry the OFT SDK builds `send` with stays real | `LZ_RECEIVE_TYPES_SEED` | `lz-solana-sdk-v2/` |

The functions are re-implemented line for line from the originals (3.0.168) and checked against
outputs recorded from the real packages (`tests/core/shim-vectors.json`). The same test asserts that
the SDK's built files still import only these names, and that the replaced packages are empty on
disk — a future SDK version that needs more fails the test instead of silently breaking.
