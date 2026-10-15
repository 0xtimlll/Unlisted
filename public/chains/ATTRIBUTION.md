# Network logos

Vector marks from [web3icons](https://github.com/0xa3k5/web3icons) (`raw-svgs/networks/`, MIT
licence), vendored here so the app never loads images from third-party hosts (CSP `img-src 'self'`).
Each mark is a trademark of the respective network and is used solely to identify that network.
Unlisted is not affiliated with or endorsed by any of them.

The "mono" variants were recoloured (white or near-black) to sit on the network's brand colour, which
is applied by the tile around them (`src/core/networks.ts`, `brand`); the "branded" variants are
used as published. The first table is hand-placed; the second is written by
`scripts/update-networks.ts`, which takes the tile colour from the most-used colour of the branded
mark. A network with no mark in web3icons shows its initials on a neutral tile instead; those are
listed at the end.

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
| abstract.svg | networks/mono/abstract.svg | mono, white (as published); tile #054729 from networks/branded/abstract.svg |
| ape.svg | networks/mono/apechain.svg | mono, white (as published); tile #0054FA from networks/branded/apechain.svg |
| astar.svg | networks/mono/astar.svg | mono, #0B0E11 (recoloured); tile #0AE2FF from networks/branded/astar.svg |
| beam.svg | networks/mono/beam.svg | mono, white (as published); tile #0B76FF from networks/branded/beam.svg |
| bera.svg | networks/mono/berachain.svg | mono, white (as published); tile #FB9942 from networks/branded/berachain.svg |
| blast.svg | networks/mono/blast.svg | mono, white (as published); tile #3a3a3a from networks/branded/blast.svg |
| bob.svg | networks/mono/bob.svg | mono, white (as published); tile #F25D00 from networks/branded/bob.svg |
| celo.svg | networks/mono/celo.svg | mono, white (as published); tile #3a3a3a from networks/branded/celo.svg |
| chiliz.svg | networks/mono/chiliz.svg | mono, white (as published); tile #F60250 from networks/branded/chiliz.svg |
| citrea.svg | networks/mono/citrea.svg | mono, white (as published); tile #3a3a3a from networks/branded/citrea.svg |
| codex.svg | networks/mono/codex.svg | mono, #0B0E11 (recoloured); tile #F8E6B6 from networks/branded/codex.svg |
| conflux.svg | networks/mono/conflux.svg | mono, white (as published); tile #37A1DB from networks/branded/conflux.svg |
| cronosevm.svg | networks/mono/cronos.svg | mono, white (as published); tile #3a3a3a from networks/branded/cronos.svg |
| cronoszkevm.svg | networks/mono/cronos-zkevm.svg | mono, white (as published); tile #3a3a3a from networks/branded/cronos-zkevm.svg |
| etherlink.svg | networks/mono/etherlink.svg | mono, #0B0E11 (recoloured); tile #38FF9C from networks/branded/etherlink.svg |
| fantom.svg | networks/mono/fantom.svg | mono, white (as published); tile #26B6EA from networks/branded/fantom.svg |
| flare.svg | networks/mono/flare.svg | mono, white (as published); tile #E62058 from networks/branded/flare.svg |
| fraxtal.svg | networks/mono/fraxtal.svg | mono, white (as published); tile #3a3a3a from networks/branded/fraxtal.svg |
| fuse.svg | networks/mono/fuse.svg | mono, #0B0E11 (recoloured); tile #B4F9B9 from networks/branded/fuse.svg |
| gnosis.svg | networks/mono/gnosis.svg | mono, white (as published); tile #3E6957 from networks/branded/gnosis.svg |
| gravity.svg | networks/mono/gravity.svg | mono, #0B0E11 (recoloured); tile #FFAC43 from networks/branded/gravity.svg |
| gunz.svg | networks/mono/gunz.svg | mono, #0B0E11 (recoloured); tile #C2FCCD from networks/branded/gunz.svg |
| hashkey.svg | networks/mono/hashkey.svg | mono, white (as published); tile #0080FF from networks/branded/hashkey.svg |
| hedera.svg | networks/mono/hedera-hashgraph.svg | mono, white (as published); tile #3a3a3a from networks/branded/hedera-hashgraph.svg |
| iota.svg | networks/mono/iota-evm.svg | mono, white (as published); tile #3a3a3a from networks/branded/iota-evm.svg |
| islander.svg | networks/mono/vana.svg | mono, white (as published); tile #3a3a3a from networks/branded/vana.svg |
| katana.svg | networks/mono/katana.svg | mono, white (as published); tile #3a3a3a from networks/branded/katana.svg |
| kava.svg | networks/mono/kava.svg | mono, white (as published); tile #FF564F from networks/branded/kava.svg |
| klaytn.svg | networks/mono/kaia.svg | mono, #0B0E11 (recoloured); tile #BFF009 from networks/branded/kaia.svg |
| lisk.svg | networks/mono/lisk.svg | mono, white (as published); tile #3a3a3a from networks/branded/lisk.svg |
| lyra.svg | networks/mono/lyra.svg | mono, #0B0E11 (recoloured); tile #25FAAF from networks/branded/lyra.svg |
| manta.svg | networks/mono/manta-pacific.svg | mono, white (as published); tile #29CCB9 from networks/branded/manta-pacific.svg |
| mantle.svg | networks/mono/mantle.svg | mono, white (as published); tile #3a3a3a from networks/branded/mantle.svg |
| megaeth.svg | networks/mono/mega-eth.svg | mono, white (as published); tile #3a3a3a from networks/branded/mega-eth.svg |
| metis.svg | networks/mono/metis-andromeda.svg | mono, #0B0E11 (recoloured); tile #00D8C1 from networks/branded/metis-andromeda.svg |
| mode.svg | networks/mono/mode.svg | mono, #0B0E11 (recoloured); tile #DFFE00 from networks/branded/mode.svg |
| moonbeam.svg | networks/mono/moonbeam.svg | mono, white (as published); tile #53CBC9 from networks/branded/moonbeam.svg |
| neox.svg | networks/mono/neo-x.svg | mono, #0B0E11 (recoloured); tile #00E599 from networks/branded/neo-x.svg |
| nibiru.svg | networks/mono/nibiru.svg | mono, white (as published); tile #F29AC4 from networks/branded/nibiru.svg |
| orderly.svg | networks/mono/orderly.svg | mono, white (as published); tile #5D00BA from networks/branded/orderly.svg |
| peaq.svg | networks/mono/peaq.svg | mono, white (as published); tile #6666FE from networks/branded/peaq.svg |
| plumephoenix.svg | networks/mono/plume.svg | mono, white (as published); tile #FF3D00 from networks/branded/plume.svg |
| reya.svg | networks/mono/reya.svg | mono, #0B0E11 (recoloured); tile #08F06A from networks/branded/reya.svg |
| ronin.svg | networks/mono/ronin.svg | mono, white (as published); tile #004DE5 from networks/branded/ronin.svg |
| rootstock.svg | networks/mono/rootstock.svg | mono, white (as published); tile #FF9103 from networks/branded/rootstock.svg |
| sei.svg | networks/mono/sei-network.svg | mono, white (as published); tile #90305C from networks/branded/sei-network.svg |
| soneium.svg | networks/mono/soneium.svg | mono, white (as published); tile #3a3a3a from networks/branded/soneium.svg |
| sonic.svg | networks/mono/sonic.svg | mono, white (as published); tile #3a3a3a from networks/branded/sonic.svg |
| stable.svg | networks/mono/stable.svg | mono, white (as published); tile #3a3a3a from networks/branded/stable.svg |
| taiko.svg | networks/mono/taiko.svg | mono, white (as published); tile #E81899 from networks/branded/taiko.svg |
| telos.svg | networks/mono/telos.svg | mono, white (as published); tile #42A0B9 from networks/branded/telos.svg |
| tempo.svg | networks/mono/tempo.svg | mono, white (as published); tile #3a3a3a from networks/branded/tempo.svg |
| unichain.svg | networks/mono/unichain.svg | mono, white (as published); tile #F50DB4 from networks/branded/unichain.svg |
| wemix30.svg | networks/mono/wemix.svg | mono, #0B0E11 (recoloured); tile #27EA84 from networks/branded/wemix.svg |
| worldchain.svg | networks/mono/world.svg | mono, white (as published); tile #3a3a3a from networks/branded/world.svg |
| xdc.svg | networks/mono/xdc.svg | mono, #0B0E11 (recoloured); tile #9FF3FF from networks/branded/xdc.svg |
| xlayer.svg | networks/mono/x-layer.svg | mono, white (as published); tile #3a3a3a from networks/branded/x-layer.svg |
| zircuit.svg | networks/mono/zircuit.svg | mono, white (as published); tile #169E00 from networks/branded/zircuit.svg |
| zksync.svg | networks/mono/zksync.svg | mono, white (as published); tile #3a3a3a from networks/branded/zksync.svg |

## No mark (initials on a neutral tile)

abcore, adichain, apexfusionnexus, arc, b2, bitlayer, coredao, creditcoin, dexalot, doma, edge, flow, gensyn, goat, hemi, henesys, horizen, humanity, hydration, injectiveevm, irys, jovay, kite, lens, memecore, merlin, metal, mezo, moca, morph, og, onemoney, opbnb, pharos, rayls, redbelly, rise, shibarium, somnia, story, subtensorevm, tac, zora
