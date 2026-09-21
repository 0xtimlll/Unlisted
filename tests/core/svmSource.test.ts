/** Solana-source discovery (probeSvmOft) over a fake RPC: decoding, routes, quorum. */
import { describe, expect, it } from 'vitest'
import { addressToBytes32 } from '@/core/encoding'
import { anchorDiscriminator } from '@/core/svm/layouts'
import { peerConfigPda } from '@/core/svm/plan'
import { findMetadata, PROGRAM, pubkeyFromBase58, pubkeyToBase58 } from '@/core/svm/pubkey'
import { SvmRpc } from '@/core/svm/rpc'
import { probeSvmOft } from '@/core/svm/source'
import { ESCROW, MINT, PENGU_HYPER, PROGRAM as OFT_PROGRAM, STORE } from './svmFixtures'

const u64 = (n: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn))
const vec = (b: Uint8Array) => new Uint8Array([b.length, 0, 0, 0, ...b])
const str = (s: string, size: number) => {
  const b = new Uint8Array(4 + size)
  new DataView(b.buffer).setUint32(0, size, true)
  b.set(new TextEncoder().encode(s), 4)
  return b
}
const hexBytes = (h: string) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)!.map((x) => parseInt(x, 16)))

function storeBytes(o: { type: number; rate: bigint; paused?: boolean; fee?: number; tvl?: bigint }): Uint8Array {
  return new Uint8Array([
    ...anchorDiscriminator('OFTStore'), o.type, ...u64(o.rate), ...pubkeyFromBase58(MINT), ...pubkeyFromBase58(ESCROW),
    ...pubkeyFromBase58('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6'), 255, ...u64(o.tvl ?? 0n), ...new Uint8Array(32),
    (o.fee ?? 0) & 0xff, ((o.fee ?? 0) >> 8) & 0xff, o.paused ? 1 : 0, 0, 0,
  ])
}
function peerBytes(peer: Uint8Array, enforcedSend: Uint8Array): Uint8Array {
  return new Uint8Array([...anchorDiscriminator('PeerConfig'), ...peer, ...vec(enforcedSend), ...vec(new Uint8Array()), 0, 0, 0, 254])
}
function mintBytes(decimals: number): Uint8Array {
  const b = new Uint8Array(82)
  b[44] = decimals
  b[45] = 1
  return b
}
function tokenAccountBytes(mint: string, owner: string, amount: bigint): Uint8Array {
  const b = new Uint8Array(165)
  b.set(pubkeyFromBase58(mint), 0)
  b.set(pubkeyFromBase58(owner), 32)
  b.set(u64(amount), 64)
  return b
}
function metadataBytes(): Uint8Array {
  return new Uint8Array([4, ...new Uint8Array(32), ...pubkeyFromBase58(MINT), ...str('Pudgy Penguins', 32), ...str('PENGU', 10), ...str('', 200)])
}

type Acc = { owner: string; data: Uint8Array }
const ENFORCED = hexBytes('0x000301001101000000000000000000000000000186a0')

/** A JSON-RPC server over a map of accounts. Same shape as the real answers. */
function fakeRpc(accounts: Record<string, Acc>, log: string[] = []) {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
  const view = (k: string) => {
    const a = accounts[k]
    return a ? { owner: a.owner, data: [b64(a.data), 'base64'], lamports: 1, executable: false } : null
  }
  return async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
    log.push(`${url} ${req.method}`)
    let result: unknown
    if (req.method === 'getAccountInfo') result = { value: view(req.params[0] as string) }
    else if (req.method === 'getMultipleAccounts') result = { value: (req.params[0] as string[]).map(view) }
    else throw new Error(`unexpected ${req.method}`)
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) } as unknown as Response
  }
}

const HYPER_EID = 30367
const ETH_EID = 30101

function penguAccounts(over: Partial<Record<string, Acc>> = {}): Record<string, Acc> {
  const acc: Record<string, Acc> = {
    [STORE]: { owner: OFT_PROGRAM, data: storeBytes({ type: 1, rate: 1n, tvl: 5n }) },
    [MINT]: { owner: PROGRAM.token, data: mintBytes(6) },
    [ESCROW]: { owner: PROGRAM.token, data: tokenAccountBytes(MINT, STORE, 5n) },
    [pubkeyToBase58(findMetadata(pubkeyFromBase58(MINT)))]: { owner: PROGRAM.metadata, data: metadataBytes() },
    [peerConfigPda(STORE, OFT_PROGRAM, HYPER_EID)]: { owner: OFT_PROGRAM, data: peerBytes(hexBytes(addressToBytes32(PENGU_HYPER)), ENFORCED) },
    // A PeerConfig whose peer is zero: configured-but-empty, not a route.
    [peerConfigPda(STORE, OFT_PROGRAM, ETH_EID)]: { owner: OFT_PROGRAM, data: peerBytes(new Uint8Array(32), new Uint8Array()) },
  }
  return { ...acc, ...over } as Record<string, Acc>
}

describe('probeSvmOft', () => {
  it('reads store → program/mint/escrow/metadata and the PeerConfig routes; one URL = not cross-checked', async () => {
    const log: string[] = []
    const rpc = new SvmRpc(['https://one'], fakeRpc(penguAccounts(), log))
    const r = await probeSvmOft(rpc, STORE)
    expect(r.crossChecked).toBe(false)
    expect(r.info).toMatchObject({
      vm: 'svm', oftStore: STORE, programId: OFT_PROGRAM, kind: 'OFTAdapter', tokenMint: MINT, tokenEscrow: ESCROW, tokenProgram: 'token',
      symbol: 'PENGU', name: 'Pudgy Penguins', decimals: 6, sharedDecimals: 6, conversionRate: 1n, approvalRequired: false, paused: false, tvlLd: 5n,
      routes: [{ eid: HYPER_EID, peer: addressToBytes32(PENGU_HYPER) }],
    })
    expect(r.info.enforced[HYPER_EID]).toBe('0x000301001101000000000000000000000000000186a0')
    expect(r.info.enforced[ETH_EID]).toBeUndefined()
    expect(r.info.oftStoreBytes32).toBe(`0x${Buffer.from(pubkeyFromBase58(STORE)).toString('hex')}`)
    // One getAccountInfo + chunked getMultipleAccounts (13 keys → 2 calls of ≤10).
    expect(log).toEqual(['https://one getAccountInfo', 'https://one getMultipleAccounts', 'https://one getMultipleAccounts'])
  })

  it('shared decimals follow ld2sdRate; a non-power-of-ten rate keeps local decimals', async () => {
    const r = await probeSvmOft(new SvmRpc(['https://one'], fakeRpc(penguAccounts({ [STORE]: { owner: OFT_PROGRAM, data: storeBytes({ type: 0, rate: 1000n }) } }))), STORE)
    expect(r.info.kind).toBe('OFT')
    expect(r.info.sharedDecimals).toBe(3)
    const odd = await probeSvmOft(new SvmRpc(['https://one'], fakeRpc(penguAccounts({ [STORE]: { owner: OFT_PROGRAM, data: storeBytes({ type: 0, rate: 7n }) } }))), STORE)
    expect(odd.info.sharedDecimals).toBe(6)
  })

  it('falls back to a short mint when metadata is missing; Token-2022 mints are recognised', async () => {
    const acc = penguAccounts()
    delete acc[pubkeyToBase58(findMetadata(pubkeyFromBase58(MINT)))]
    acc[MINT] = { owner: PROGRAM.token2022, data: mintBytes(9) }
    const r = await probeSvmOft(new SvmRpc(['https://one'], fakeRpc(acc)), STORE)
    expect(r.info.symbol).toBe('2zMM…uauv')
    expect(r.info.tokenProgram).toBe('token2022')
    expect(r.info.decimals).toBe(9)
  })

  it('two agreeing providers → crossChecked; a disagreeing one → rpc_mismatch', async () => {
    const good = penguAccounts()
    const rpc = new SvmRpc(['https://a', 'https://b'], async (url, init) => (url === 'https://a' ? fakeRpc(good) : fakeRpc(good))(url, init))
    expect((await probeSvmOft(rpc, STORE)).crossChecked).toBe(true)

    const lying = penguAccounts({ [peerConfigPda(STORE, OFT_PROGRAM, HYPER_EID)]: { owner: OFT_PROGRAM, data: peerBytes(hexBytes(addressToBytes32('0x' + '22'.repeat(20))), ENFORCED) } })
    const split = new SvmRpc(['https://a', 'https://b'], async (url, init) => (url === 'https://a' ? fakeRpc(good) : fakeRpc(lying))(url, init))
    await expect(probeSvmOft(split, STORE)).rejects.toMatchObject({ code: 'rpc_mismatch' })

    // Second provider says "no such store" → also a disagreement, not an outage.
    const empty: Record<string, Acc> = {}
    const missing = new SvmRpc(['https://a', 'https://b'], async (url, init) => (url === 'https://a' ? fakeRpc(good) : fakeRpc(empty))(url, init))
    await expect(probeSvmOft(missing, STORE)).rejects.toMatchObject({ code: 'rpc_mismatch' })

    // Second provider down (HTTP error) → still works, just not cross-checked.
    const down = new SvmRpc(['https://a', 'https://b'], async (url, init) => (url === 'https://a' ? fakeRpc(good)(url, init) : ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)))
    expect((await probeSvmOft(down, STORE)).crossChecked).toBe(false)
  })

  it('errors: bad key, missing store, foreign account, mint missing, unknown token program, escrow of another mint', async () => {
    await expect(probeSvmOft(new SvmRpc(['https://one'], fakeRpc({})), 'nope')).rejects.toMatchObject({ code: 'bad_peer' })
    await expect(probeSvmOft(new SvmRpc(['https://one'], fakeRpc({})), STORE)).rejects.toMatchObject({ code: 'store_missing' })
    await expect(probeSvmOft(new SvmRpc(['https://one'], fakeRpc(penguAccounts({ [STORE]: { owner: OFT_PROGRAM, data: mintBytes(6) } }))), STORE)).rejects.toMatchObject({ code: 'not_oft_store' })
    const noMint = penguAccounts()
    delete noMint[MINT]
    await expect(probeSvmOft(new SvmRpc(['https://one'], fakeRpc(noMint)), STORE)).rejects.toMatchObject({ code: 'mint_missing' })
    await expect(probeSvmOft(new SvmRpc(['https://one'], fakeRpc(penguAccounts({ [MINT]: { owner: PROGRAM.system, data: mintBytes(6) } }))), STORE)).rejects.toMatchObject({ code: 'unknown_token_program' })
    await expect(probeSvmOft(new SvmRpc(['https://one'], fakeRpc(penguAccounts({ [ESCROW]: { owner: PROGRAM.token, data: tokenAccountBytes(PROGRAM.ata, STORE, 1n) } }))), STORE)).rejects.toMatchObject({ code: 'escrow_mismatch' })
  })

  it('a PeerConfig PDA owned by another program is ignored, not trusted', async () => {
    const acc = penguAccounts({ [peerConfigPda(STORE, OFT_PROGRAM, HYPER_EID)]: { owner: PROGRAM.system, data: peerBytes(hexBytes(addressToBytes32(PENGU_HYPER)), ENFORCED) } })
    const r = await probeSvmOft(new SvmRpc(['https://one'], fakeRpc(acc)), STORE)
    expect(r.info.routes).toEqual([])
  })
})
