# Network logos

Marks for the networks this app serves, vendored here so the app never loads images from
third-party hosts (CSP `img-src 'self'`). Each mark is a trademark of the respective network and is
used solely to identify that network. Unlisted is not affiliated with or endorsed by any of them.

The first table is hand-placed, from [web3icons](https://github.com/0xa3k5/web3icons)
(`raw-svgs/networks/`, MIT). The second is written by `scripts/update-networks.ts` from the
table in `scripts/networks-brand.json`, which names each network's tile colour and the source of its
mark: web3icons (MIT), the [Hyperlane registry](https://github.com/hyperlane-xyz/hyperlane-registry)
(`chains/<name>/logo.svg`, MIT), [ethereum-lists/chains](https://github.com/ethereum-lists/chains)
(`_data/icons`, MIT; icons submitted by each network's own team, fetched from IPFS), or the
network's own website. "mono" marks are white and turned near-black on a light tile; a mark drawn
"every colour set to white" is the official mark as a one-colour silhouette; the tile colour is
applied around it (`src/core/networks.ts`, `brand`). A network with no mark anywhere shows its
initials on its tile; those are listed at the end.

| file | source | variant |
|---|---|---|
| ethereum.svg | networks/branded/ethereum.svg | branded |
| arbitrum.svg | networks/mono/arbitrum-one.svg | mono, white |
| optimism.svg | networks/mono/optimism.svg | mono, white |
| base.svg | networks/mono/base.svg | mono, white |
| bsc.svg | networks/mono/binance-smart-chain.svg | mono, #0B0E11 |
| polygon.svg | networks/mono/polygon.svg | mono, white |
| avalanche.svg | networks/mono/avalanche.svg | mono, white |
| hyperevm.svg | networks/branded/hyper-evm.svg | branded |
| linea.svg | networks/mono/linea.svg | mono, #0B0E11 |
| scroll.svg | networks/mono/scroll.svg | mono, #101010 |
| robinhood.svg | networks/branded/robinhood.svg | branded |
| ink.svg | networks/mono/ink.svg | mono, white |
| plasma.svg | networks/mono/plasma.svg | mono, white (as published) |
| monad.svg | networks/mono/monad.svg | mono, white (as published) |
| solana.svg | networks/branded/solana.svg | branded |

## Generated

| file | source | variant |
|---|---|---|
| abcore.png | the network's own site, www.ab.org | raster, resized; tile #2055C9 |
| abstract.svg | web3icons raw-svgs/networks/mono/abstract.svg (MIT) | mono, white as published; tile #054729 |
| adichain.svg | web3icons raw-svgs/tokens/mono/ADI.svg (MIT) | mono, white as published; tile linear-gradient(180deg, #FE7109, #003BFF) |
| ape.svg | web3icons raw-svgs/networks/mono/apechain.svg (MIT) | mono, white as published; tile #0054FA |
| apexfusionnexus.png | ethereum-lists/chains _data/icons/apexfusion.json (MIT) | raster, resized; tile #0F1B1A |
| arc.svg | hyperlane-registry chains/arc/logo.svg (MIT) | every colour set to white; tile #1B3158 |
| astar.svg | web3icons raw-svgs/networks/mono/astar.svg (MIT) | mono, white as published; tile linear-gradient(180deg, #0AE2FF, #0279C2) |
| b2.png | ethereum-lists/chains _data/icons/bsquare.json (MIT) | raster, resized; tile #FFB852 |
| beam.svg | web3icons raw-svgs/networks/mono/beam.svg (MIT) | mono, white as published; tile #0B76FF |
| bera.svg | web3icons raw-svgs/networks/branded/berachain.svg (MIT) | as published; tile #472920 |
| bitlayer.svg | hyperlane-registry chains/bitlayer/logo.svg (MIT) | as published; tile #000000 |
| blast.svg | web3icons raw-svgs/networks/mono/blast.svg (MIT) | mono, recoloured near-black; tile #FCFC03 |
| bob.svg | web3icons raw-svgs/networks/mono/bob.svg (MIT) | mono, white as published; tile #F25D00 |
| celo.svg | web3icons raw-svgs/networks/mono/celo.svg (MIT) | mono, recoloured near-black; tile #FCFE52 |
| chiliz.svg | web3icons raw-svgs/networks/mono/chiliz.svg (MIT) | mono, white as published; tile #F60250 |
| citrea.svg | web3icons raw-svgs/networks/mono/citrea.svg (MIT) | mono, white as published; tile #FD7F00 |
| codex.svg | web3icons raw-svgs/networks/mono/codex.svg (MIT) | mono, recoloured near-black; tile #F8E6B6 |
| conflux.svg | web3icons raw-svgs/networks/mono/conflux.svg (MIT) | mono, white as published; tile #37A1DB |
| coredao.svg | hyperlane-registry chains/coredao/logo.svg (MIT) | every colour set to white; tile #FF9211 |
| creditcoin.png | ethereum-lists/chains _data/icons/creditcoin.json (MIT) | raster, cropped to a rounded square; tile #4976FF |
| cronosevm.svg | web3icons raw-svgs/networks/mono/cronos.svg (MIT) | mono, white as published; tile #051221 |
| cronoszkevm.svg | web3icons raw-svgs/networks/mono/cronos-zkevm.svg (MIT) | mono, white as published; tile #051221 |
| dexalot.png | ethereum-lists/chains _data/icons/dexalot.json (MIT) | raster turned into a white silhouette; tile #E71771 |
| doma.png | ethereum-lists/chains _data/icons/doma.json (MIT) | raster turned into a white silhouette; tile #4B76FA |
| edge.png | the network's own site, pro.edgex.exchange | raster, cropped to a rounded square; tile #000000 |
| etherlink.svg | web3icons raw-svgs/networks/mono/etherlink.svg (MIT) | mono, recoloured near-black; tile #38FF9C |
| fantom.svg | web3icons raw-svgs/networks/mono/fantom.svg (MIT) | mono, white as published; tile #1969FF |
| flare.svg | web3icons raw-svgs/networks/mono/flare.svg (MIT) | mono, white as published; tile #E62058 |
| flow.svg | web3icons raw-svgs/tokens/mono/FLOW.svg (MIT) | mono, recoloured near-black; tile #00EF8B |
| fraxtal.svg | web3icons raw-svgs/networks/mono/fraxtal.svg (MIT) | mono, white as published; tile #000000 |
| fuse.svg | web3icons raw-svgs/networks/mono/fuse.svg (MIT) | mono, recoloured near-black; tile #B4F9B9 |
| gensyn.png | ethereum-lists/chains _data/icons/gensyn.json (MIT) | raster, resized; tile #FFD4CF |
| gnosis.svg | web3icons raw-svgs/networks/mono/gnosis.svg (MIT) | mono, white as published; tile #3E6957 |
| goat.png | ethereum-lists/chains _data/icons/goat.json (MIT) | raster, cropped to a rounded square; tile #D39820 |
| gravity.svg | web3icons raw-svgs/networks/mono/gravity.svg (MIT) | mono, white as published; tile #FFAC43 |
| gunz.svg | web3icons raw-svgs/networks/mono/gunz.svg (MIT) | mono, recoloured near-black; tile linear-gradient(180deg, #C2FCCD, #D3F1FB) |
| hashkey.svg | web3icons raw-svgs/networks/mono/hashkey.svg (MIT) | mono, white as published; tile #0072E5 |
| hedera.svg | web3icons raw-svgs/networks/mono/hedera-hashgraph.svg (MIT) | mono, white as published; tile #000000 |
| hemi.svg | hyperlane-registry chains/hemi/logo.svg (MIT) | every colour set to white; tile #FF6C15 |
| henesys.png | ethereum-lists/chains _data/icons/nexpace.json (MIT) | raster, resized; tile #14122B |
| horizen.png | ethereum-lists/chains _data/icons/horizen.json (MIT) | raster, cropped to a rounded square; tile #FFCB17 |
| humanity.png | the network's own site, framerusercontent.com | raster, cropped to a rounded square; tile #EDFCEC |
| hydration.svg | ethereum-lists/chains _data/icons/hydration.json (MIT) | every colour set to white; tile #E53E76 |
| injectiveevm.svg | web3icons raw-svgs/networks/mono/injective.svg (MIT) | mono, white as published; tile #4D3DFF |
| iota.svg | web3icons raw-svgs/networks/mono/iota-evm.svg (MIT) | mono, white as published; tile #000000 |
| irys.png | ethereum-lists/chains _data/icons/irys.json (MIT) | raster, cropped to a rounded square; tile #51FFD6 |
| islander.svg | web3icons raw-svgs/networks/mono/vana.svg (MIT) | mono, recoloured near-black; tile #F0F0E9 |
| jovay.png | ethereum-lists/chains _data/icons/jovay.json (MIT) | raster, cropped to a rounded square; tile #326CFF |
| katana.svg | web3icons raw-svgs/networks/branded/katana.svg (MIT) | as published; tile #0541B2 |
| kava.svg | web3icons raw-svgs/networks/mono/kava.svg (MIT) | mono, white as published; tile #FF433E |
| kite.svg | the network's own site, gokite.ai | as published; tile #1D1A16 |
| klaytn.svg | web3icons raw-svgs/networks/mono/kaia.svg (MIT) | mono, recoloured near-black; tile #BFF009 |
| lens.svg | web3icons raw-svgs/networks/mono/lens.svg (MIT) | mono, white as published; tile #000000 |
| lisk.svg | web3icons raw-svgs/networks/mono/lisk.svg (MIT) | mono, white as published; tile #0C152E |
| lyra.svg | web3icons raw-svgs/networks/mono/lyra.svg (MIT) | mono, recoloured near-black; tile #25FAAF |
| manta.svg | web3icons raw-svgs/networks/mono/manta-pacific.svg (MIT) | mono, white as published; tile linear-gradient(180deg, #29CCB9, #0091FF, #FF66B7) |
| mantle.svg | web3icons raw-svgs/networks/mono/mantle.svg (MIT) | mono, white as published; tile #06110D |
| megaeth.svg | web3icons raw-svgs/networks/mono/mega-eth.svg (MIT) | mono, white as published; tile #19191A |
| memecore.svg | ethereum-lists/chains _data/icons/memecore.json (MIT) | as published; tile #CBBBFB |
| merlin.svg | hyperlane-registry chains/merlin/logo.svg (MIT) | as published; tile #6335FF |
| metal.svg | hyperlane-registry chains/metal/logo.svg (MIT) | as published; tile #0E0E10 |
| metis.svg | web3icons raw-svgs/networks/mono/metis-andromeda.svg (MIT) | mono, recoloured near-black; tile #00D8C1 |
| mezo.svg | the network's own site, mezo.org | every colour set to white; tile #FF004D |
| moca.svg | hyperlane-registry chains/mocachain/logo.svg (MIT) | every colour set to white; tile #EF61B4 |
| mode.svg | web3icons raw-svgs/networks/mono/mode.svg (MIT) | mono, recoloured near-black; tile #DFFE00 |
| moonbeam.svg | web3icons raw-svgs/networks/mono/moonbeam.svg (MIT) | mono, white as published; tile #CB1F7A |
| morph.svg | hyperlane-registry chains/morph/logo.svg (MIT) | every colour set to white; tile #14A800 |
| neox.svg | web3icons raw-svgs/networks/mono/neo-x.svg (MIT) | mono, recoloured near-black; tile #00E599 |
| nibiru.svg | web3icons raw-svgs/networks/mono/nibiru.svg (MIT) | mono, recoloured near-black; tile linear-gradient(180deg, #F29AC4, #CDC6D7) |
| og.svg | hyperlane-registry chains/zerogravity/logo.svg (MIT) | as published; tile #9200E1 |
| onemoney.svg | ethereum-lists/chains _data/icons/1moneynetwork.json (MIT) | as published; tile #073387 |
| opbnb.svg | the bsc mark above | as published; tile #F0B90B |
| orderly.svg | web3icons raw-svgs/networks/mono/orderly.svg (MIT) | mono, white as published; tile #5D00BA |
| peaq.svg | web3icons raw-svgs/networks/mono/peaq.svg (MIT) | mono, white as published; tile #6666FE |
| pharos.png | ethereum-lists/chains _data/icons/pharos.json (MIT) | raster turned into a white silhouette; tile #0007B9 |
| plumephoenix.svg | web3icons raw-svgs/networks/mono/plume.svg (MIT) | mono, white as published; tile #FF3D00 |
| rayls.svg | ethereum-lists/chains _data/icons/rayls.json (MIT) | as published; tile #000000 |
| redbelly.svg | ethereum-lists/chains _data/icons/redbelly.json (MIT) | every colour set to white; tile #FF4848 |
| reya.svg | web3icons raw-svgs/networks/mono/reya.svg (MIT) | mono, recoloured near-black; tile #08F06A |
| rise.png | the network's own site, risechain.com | raster, cropped to a rounded square; tile #04DF83 |
| ronin.svg | web3icons raw-svgs/networks/mono/ronin.svg (MIT) | mono, white as published; tile #004DE5 |
| rootstock.svg | web3icons raw-svgs/networks/mono/rootstock.svg (MIT) | mono, white as published; tile #FF9103 |
| sei.svg | web3icons raw-svgs/networks/mono/sei-network.svg (MIT) | mono, white as published; tile #9E1F19 |
| shibarium.svg | hyperlane-registry chains/shibarium/logo.svg (MIT) | as published; tile #F00500 |
| somnia.svg | hyperlane-registry chains/somnia/logo.svg (MIT) | as published; tile #0B0B14 |
| soneium.svg | web3icons raw-svgs/networks/mono/soneium.svg (MIT) | mono, white as published; tile #000000 |
| sonic.svg | web3icons raw-svgs/networks/mono/sonic.svg (MIT) | mono, white as published; tile #141416 |
| stable.svg | web3icons raw-svgs/networks/mono/stable.svg (MIT) | mono, white as published; tile #011F1E |
| story.svg | hyperlane-registry chains/story/logo.svg (MIT) | as published; tile #000000 |
| subtensorevm.svg | hyperlane-registry chains/subtensor/logo.svg (MIT) | every colour set to white; tile #000000 |
| tac.svg | hyperlane-registry chains/tac/logo.svg (MIT) | every colour set to white; tile #91029B |
| taiko.svg | web3icons raw-svgs/networks/mono/taiko.svg (MIT) | mono, white as published; tile #E81899 |
| telos.svg | web3icons raw-svgs/networks/mono/telos.svg (MIT) | mono, white as published; tile linear-gradient(180deg, #00F2FE, #4FACFE, #C471F5) |
| tempo.svg | web3icons raw-svgs/networks/mono/tempo.svg (MIT) | mono, white as published; tile #000000 |
| unichain.svg | web3icons raw-svgs/networks/mono/unichain.svg (MIT) | mono, white as published; tile #F50DB4 |
| wemix30.svg | web3icons raw-svgs/networks/mono/wemix.svg (MIT) | mono, recoloured near-black; tile #27EA84 |
| worldchain.svg | web3icons raw-svgs/networks/mono/world.svg (MIT) | mono, white as published; tile #000000 |
| xdc.svg | web3icons raw-svgs/networks/mono/xdc.svg (MIT) | mono, recoloured near-black; tile #9FF3FF |
| xlayer.svg | web3icons raw-svgs/networks/mono/x-layer.svg (MIT) | mono, white as published; tile #000000 |
| zircuit.svg | web3icons raw-svgs/networks/branded/zircuit.svg (MIT) | as published; tile #092306 |
| zksync.svg | web3icons raw-svgs/networks/mono/zksync.svg (MIT) | mono, white as published; tile #000000 |
| zora.svg | web3icons raw-svgs/networks/branded/zora.svg (MIT) | as published; tile #F2CEFE |

## No mark (initials on the tile)


