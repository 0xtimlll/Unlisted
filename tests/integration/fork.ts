/**
 * anvil fork helpers for integration tests. Requires Foundry (`brew install foundry`).
 * Nothing here touches src/; tests fund a throwaway address on a local fork only.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex, type Address, type Hex } from 'viem'
import { erc20Abi } from '@/core/abi'
import type { ChainDef } from '@/core/chains'
import { toViemChain, type ReadClient } from '@/core/client'

export const USER: Address = '0x1111111111111111111111111111111111111111'

/** erc7201:openzeppelin.storage.ERC20 — balances live at this namespaced slot in OZ v5 upgradeable tokens. */
const OZ_ERC20_NS: Hex = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeb7c4cc4b4a2eb'

export type Fork = {
  url: string
  chain: ChainDef
  client: ReadClient
  rpc: (method: string, params: unknown[]) => Promise<unknown>
  stop: () => void
}

let nextPort = 8600 + Math.floor(Math.random() * 200)

export async function startFork(chain: ChainDef): Promise<Fork> {
  const port = nextPort++
  const url = `http://127.0.0.1:${port}`
  const proc: ChildProcess = spawn('anvil', ['--fork-url', chain.rpcUrls[0]!, '--port', String(port), '--silent'], { stdio: 'ignore' })
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const j = (await r.json()) as { result?: unknown; error?: { message: string } }
    if (j.error) throw new Error(j.error.message)
    return j.result
  }
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      await rpc('eth_chainId', [])
      break
    } catch {
      if (Date.now() > deadline) {
        proc.kill()
        throw new Error('anvil did not start')
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const client = createPublicClient({ chain: toViemChain(chain), transport: http(url) })
  return { url, chain, client, rpc, stop: () => proc.kill() }
}

export async function setNativeBalance(f: Fork, who: Address, wei: bigint): Promise<void> {
  await f.rpc('anvil_setBalance', [who, toHex(wei)])
}

/**
 * Gives `who` an ERC-20 balance by locating the balances mapping slot (plain slots 0..63,
 * then the OZ v5 namespaced slot) and writing it directly. Throws if no layout matches.
 */
export async function setTokenBalance(f: Fork, token: Address, who: Address, amount: bigint): Promise<void> {
  const probeValue = 0x1234567n
  const candidates: Hex[] = [...Array(64).keys()].map((i) => toHex(i, { size: 32 })).concat([OZ_ERC20_NS])
  for (const slot of candidates) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [who, slot]))
    await f.rpc('anvil_setStorageAt', [token, key, pad(toHex(probeValue), { size: 32 })])
    const b = await f.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
    if (b === probeValue) {
      await f.rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })])
      return
    }
    await f.rpc('anvil_setStorageAt', [token, key, pad('0x0', { size: 32 })])
  }
  throw new Error(`could not find balances slot for ${token}`)
}

const transferAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)'])

/**
 * Fallback for tokens with exotic storage (proxies with custom balance logic):
 * impersonate a known holder on the fork and move tokens the normal way.
 */
export async function fundFromHolder(f: Fork, token: Address, holder: Address, who: Address, amount: bigint): Promise<void> {
  await setNativeBalance(f, holder, 10n ** 18n)
  const wallet = await impersonate(f, holder)
  const hash = await wallet.writeContract({ address: token, abi: transferAbi, functionName: 'transfer', args: [who, amount] })
  const r = await f.client.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error('holder transfer failed')
}

/** A wallet client for `who` on the fork (anvil impersonation, no keys anywhere). */
export async function impersonate(f: Fork, who: Address) {
  await f.rpc('anvil_impersonateAccount', [who])
  return createWalletClient({ account: who, chain: toViemChain(f.chain), transport: http(f.url) })
}
