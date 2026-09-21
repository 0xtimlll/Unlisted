/**
 * Stand-in for the ROOT entry of @layerzerolabs/lz-solana-sdk-v2 (see ../README.md). The OFT SDK
 * imports one string constant from it; the real entry is ~1 MB of web3.js-flavoured admin/wiring
 * code (endpoint, ULN, executor, DVN, price-feed instructions) this app never calls. The `/umi`
 * entry, which the OFT SDK actually builds `send` with, is NOT replaced.
 */
export const LZ_RECEIVE_TYPES_SEED = 'LzReceiveTypes'
