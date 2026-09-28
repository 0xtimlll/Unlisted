# Network logos

Official network logos as distributed by [Trust Wallet assets](https://github.com/trustwallet/assets)
(`blockchains/<chain>/info/logo.png`, MIT-licensed repository), vendored here so the app never loads
images from third-party hosts. Each logo is a trademark of the respective network and is used solely
to identify that network.

| file | source path |
|---|---|
| ethereum.png | blockchains/ethereum/info/logo.png |
| arbitrum.png | blockchains/arbitrum/info/logo.png |
| optimism.png | blockchains/optimism/info/logo.png |
| base.png | blockchains/base/info/logo.png |
| bsc.png | blockchains/smartchain/info/logo.png |
| polygon.png | blockchains/polygon/info/logo.png |
| avalanche.png | blockchains/avalanchec/info/logo.png |
| hyperevm.png | blockchains/hyperevm/info/logo.png |
| linea.png | blockchains/linea/info/logo.png |
| scroll.png | blockchains/scroll/info/logo.png |
| solana.png | blockchains/solana/info/logo.png |

`robinhood.png` is **not** in that set and is **not** an official mark: Trust Wallet assets carries no
logo for Robinhood Chain, and putting a financial brand's own logo on a third-party bridge would
suggest an endorsement that does not exist. It is a plain generated placeholder — a slate disc with
an `R` — drawn to match the others in size and shape. Dropping an officially licensed PNG in its
place is a one-file change and needs nothing else touched.
