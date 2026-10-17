/**
 * Status tab, Hyperlane side.
 *
 * The rules under test: a Dispatch counts only from the registry Mailbox; the id is recomputed from
 * the message bytes and compared with the DispatchId the Mailbox announced; the destination Mailbox
 * from our table answers `delivered`; and the far router is asked whether it can take the message
 * at all (its mailbox, its peer for the origin).
 */
import { describe, expect, it } from 'vitest'
import { getAddress, pad, type Abi, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { mailboxEventsAbi, warpRouteEventsAbi } from '@/protocols/hyperlane/abi'
import { diagnoseHyperlane, findHyperlaneDispatches, lookupHyperlaneStatus } from '@/protocols/hyperlane/status'
import { readHyperlaneDelivery } from '@/protocols/hyperlane/track'
import { HL, hyperlaneMessageBytes } from './hyperlaneFixtures'
import { makeLog } from './logs'

const message = (over: Partial<Parameters<typeof hyperlaneMessageBytes>[0]> = {}) =>
  hyperlaneMessageBytes({ nonce: 9, origin: 1, sender: HL.ROUTER, destination: 8453, recipient: HL.DST_ROUTER, body: { recipient: HL.WALLET, amount: 77n }, ...over })

const dispatch = (raw = message(), mailbox: Address = HL.MAILBOX_ETH) =>
  makeLog(mailbox, mailboxEventsAbi as Abi, 'Dispatch', { sender: HL.ROUTER, destination: 8453, recipient: pad(HL.DST_ROUTER, { size: 32 }), message: raw })
const dispatchId = (id: `0x${string}`, mailbox: Address = HL.MAILBOX_ETH) => makeLog(mailbox, mailboxEventsAbi as Abi, 'DispatchId', { messageId: id })
const sentTransfer = (amount = 77n) => makeLog(HL.ROUTER, warpRouteEventsAbi as Abi, 'SentTransferRemote', { destination: 8453, recipient: pad(HL.WALLET, { size: 32 }), amount })

type Handler = (address: Address, fn: string, args: readonly unknown[] | undefined) => unknown
function fakeClient(handle: Handler): ReadClient {
  return {
    readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const v = handle(getAddress(p.address), p.functionName, p.args)
      if (v === undefined) throw new Error(`no answer for ${p.functionName} at ${p.address}`)
      if (v instanceof Error) throw v
      return v
    },
  } as unknown as ReadClient
}

/** The Base side: the registry Mailbox and a far router that names it and points back. */
function baseSide(p: { delivered?: boolean; processedAt?: number; farMailbox?: Address; farPeer?: Address } = {}): ReadClient {
  return fakeClient((address, fn) => {
    if (address === HL.MAILBOX_BASE && fn === 'delivered') return p.delivered ?? false
    if (address === HL.MAILBOX_BASE && fn === 'processedAt') return p.processedAt ?? 0
    if (address === HL.DST_ROUTER && fn === 'mailbox') return p.farMailbox ?? HL.MAILBOX_BASE
    if (address === HL.DST_ROUTER && fn === 'routers') return pad(p.farPeer ?? HL.ROUTER, { size: 32 })
    return undefined
  })
}

describe('finding Hyperlane messages in a transaction', () => {
  it('reads the message off the Mailbox log, recomputes its id, and confirms it against DispatchId', () => {
    const raw = message()
    const [found] = findHyperlaneDispatches([sentTransfer(), dispatch(raw), dispatchId(findHyperlaneDispatches([dispatch(raw)], 'ethereum')[0]!.messageId)], 'ethereum')
    expect(found).toMatchObject({ srcChain: 'ethereum', mailbox: HL.MAILBOX_ETH, sender: HL.ROUTER, dstChain: 'base', recipientRouter: HL.DST_ROUTER, idConfirmed: true, sentAmount: 77n })
    expect(found!.message.nonce).toBe(9)
    expect(found!.transfer).toEqual({ recipient: HL.WALLET, amount: 77n })
  })

  it('says when the announced id is not the one computed — and when none was announced', () => {
    const [wrong] = findHyperlaneDispatches([dispatch(), dispatchId(`0x${'ab'.repeat(32)}`)], 'ethereum')
    expect(wrong!.idConfirmed).toBe(false)
    const [none] = findHyperlaneDispatches([dispatch()], 'ethereum')
    expect(none!.idConfirmed).toBeUndefined()
  })

  it('ignores a Dispatch from anything but the registry Mailbox, and the Ethereum Mailbox on another chain', () => {
    expect(findHyperlaneDispatches([dispatch(message(), HL.OTHER)], 'ethereum')).toHaveLength(0)
    expect(findHyperlaneDispatches([dispatch()], 'base')).toHaveLength(0)
    expect(findHyperlaneDispatches([dispatch()], 'solana')).toHaveLength(0)
  })

  it('a destination this app does not serve is kept, with no chain', () => {
    const [found] = findHyperlaneDispatches([dispatch(message({ destination: 424242 }))], 'ethereum')
    expect(found).toMatchObject({ dstChain: undefined })
    expect(found!.message.destination).toBe(424242)
  })

  it('a body that is not a token message leaves the transfer undefined', () => {
    const [found] = findHyperlaneDispatches([dispatch(message({ body: '0x1234' }))], 'ethereum')
    expect(found!.transfer).toBeUndefined()
  })
})

describe('what the destination says', () => {
  const found = () => findHyperlaneDispatches([dispatch()], 'ethereum')[0]!

  it('delivered, with the block the Mailbox processed it in', async () => {
    const d = await diagnoseHyperlane(found(), baseSide({ delivered: true, processedAt: 12345 }))
    expect(d.state).toEqual({ kind: 'delivered', processedAtBlock: 12345n })
    expect(d.farRouter).toEqual({ mailboxOk: true, pointsBack: true })
  })

  it('in flight while the Mailbox has not processed it', async () => {
    const d = await diagnoseHyperlane(found(), baseSide({ delivered: false }))
    expect(d.state).toEqual({ kind: 'in_flight' })
  })

  it('the far router is asked for itself: another mailbox, or a peer that is not the sender', async () => {
    expect((await diagnoseHyperlane(found(), baseSide({ farMailbox: HL.OTHER }))).farRouter).toEqual({ mailboxOk: false, pointsBack: true })
    expect((await diagnoseHyperlane(found(), baseSide({ farPeer: HL.OTHER }))).farRouter).toEqual({ mailboxOk: true, pointsBack: false })
  })

  it('a read the provider did not answer is unknown with its reason — never a state', async () => {
    const d = await diagnoseHyperlane(found(), fakeClient((address, fn) => (address === HL.MAILBOX_BASE && fn === 'delivered' ? new Error('rpc timeout') : undefined)))
    expect(d.state.kind).toBe('unknown')
    expect((d.state as { reason: string }).reason).toContain('rpc timeout')
  })

  it('a message of another Mailbox version is not read', async () => {
    const [v2] = findHyperlaneDispatches([dispatch(message({ version: 2 }))], 'ethereum')
    const d = await diagnoseHyperlane(v2!, baseSide({ delivered: true }))
    expect(d.state.kind).toBe('unknown')
  })

  it('lookupHyperlaneStatus separates served from unserved destinations', async () => {
    const r = await lookupHyperlaneStatus([dispatch(), dispatch(message({ destination: 424242 }))], 'ethereum', (c) => (c === 'base' ? baseSide({ delivered: true }) : undefined))
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]?.state.kind).toBe('delivered')
    expect(r.unserved).toHaveLength(1)
  })

  it('the tracker reads the same answer: pending, delivered, or no data when the provider is down', async () => {
    const id = found().messageId
    expect(await readHyperlaneDelivery(baseSide({ delivered: false }), 'base', id)).toEqual({ phase: 'pending' })
    expect(await readHyperlaneDelivery(baseSide({ delivered: true, processedAt: 5 }), 'base', id)).toEqual({ phase: 'delivered', processedAtBlock: 5n })
    expect(await readHyperlaneDelivery(fakeClient(() => new Error('down')), 'base', id)).toEqual({ phase: 'no_data', unreachable: true }) // said as "could not reach", not "waiting"
    expect(await readHyperlaneDelivery(baseSide(), 'solana', id)).toEqual({ phase: 'no_data' })
  })
})
