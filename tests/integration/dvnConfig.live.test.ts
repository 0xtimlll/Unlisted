/**
 * BEM, BNB Chain → X Layer (2026-10-17): a route whose two configs differ in shape and are fully
 * compatible. Send: required {Nethermind, LayerZero Labs} + 1 of {Horizen, Canary}; receive:
 * required {LayerZero Labs} + 2 of {Canary, Nethermind, Horizen}; 20 confirmations each. LayerZero
 * Scan lists every recent message on it as DELIVERED (nonce 1496 on the day). The old comparison
 * demanded equal counts and painted it red; the config check must pass and the verdict must not be
 * BLOCKED. CT Ethereum → BNB Chain is the control: unchanged.
 */
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { buildSendPlan } from '@/core/plan'
import { clientPair, probeOftQuorum } from '@/core/quorum'
import { evmRecipient } from '@/core/recipient'
import { assessRoute, dstOftOf } from '@/protocols/lz-risk'

const SOMEONE = '0x000000000000000000000000000000000000dEaD' as Address

async function verdict(src: string, dst: string, oft: Address, amount: string) {
  const s = evmByKey(src as never)
  const d = evmByKey(dst as never)
  const probe = await probeOftQuorum(clientPair(s), oft)
  const plan = await buildSendPlan(clientPair(s).primary, { info: probe.info, src: s, dstEid: d.eid, amountInput: amount, sender: SOMEONE, recipient: evmRecipient(SOMEONE) })
  return assessRoute({ protocol: 'lz-oft', info: probe.info, plan, srcChain: s.key, dstChain: d.key, srcClient: makeReadClient(s), dstClient: makeReadClient(d), dstOft: dstOftOf(probe.info, d.eid)!, linkCrossChecked: probe.crossChecked })
}

describe('LayerZero config compatibility on live routes', () => {
  it('BEM BNB Chain → X Layer: differently shaped, compatible configs are not a mismatch', async () => {
    const r = await verdict('bsc', 'xlayer', '0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72', '1')
    expect(r.risk.checks.config.status).toBe('pass')
    expect(r.risk.tier).not.toBe('BLOCKED')
  }, 120_000)

  it('CT Ethereum → BNB Chain: still a passing config', async () => {
    const r = await verdict('ethereum', 'bsc', '0x121873Fe37BE77372b69D7a8A642618b8305E71a', '25')
    expect(r.risk.checks.config.status).toBe('pass')
    expect(r.risk.tier).not.toBe('BLOCKED')
  }, 120_000)
})
