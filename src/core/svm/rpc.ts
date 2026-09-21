/**
 * Minimal Solana JSON-RPC client over fetch: only the read/simulate methods this app needs.
 * URLs are tried in order (user's RPC first); nothing here can sign or submit a transaction.
 */
export type SvmAccount = {
  /** base58 program id that owns the account. */
  owner: string
  data: Uint8Array
  lamports: bigint
  executable: boolean
}

export class SvmRpcError extends Error {
  constructor(
    message: string,
    public readonly url?: string,
  ) {
    super(message)
    this.name = 'SvmRpcError'
  }
}

type RpcResult<T> = { result?: T; error?: { code: number; message: string } }

const MAX_KEYS_PER_CALL = 10

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

type RawAccount = { owner: string; data: [string, string]; lamports: number; executable: boolean } | null

function toAccount(v: RawAccount): SvmAccount | null {
  if (!v) return null
  return { owner: v.owner, data: fromBase64(v.data[0] ?? ''), lamports: BigInt(v.lamports), executable: v.executable }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class SvmRpc {
  private readonly fetchImpl: FetchLike

  constructor(
    public readonly urls: readonly string[],
    fetchImpl?: FetchLike,
    private readonly timeoutMs = 15_000,
  ) {
    if (urls.length === 0) throw new SvmRpcError('no RPC urls')
    // Browsers require `fetch` to be called with `this === window`; a method reference loses that
    // ("Illegal invocation"). Wrap it instead of storing the bare function.
    this.fetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  }

  /** A client bound to exactly ONE of this client's URLs (same fetch, same timeout): for quorum reads. */
  single(url: string): SvmRpc {
    return new SvmRpc([url], this.fetchImpl, this.timeoutMs)
  }

  /** Calls `method` on each URL in turn; the first successful JSON-RPC answer wins. */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown
    for (const url of this.urls) {
      try {
        const r = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!r.ok) throw new SvmRpcError(`HTTP ${r.status}`, url)
        const j = (await r.json()) as RpcResult<T>
        if (j.error) throw new SvmRpcError(`${method}: ${j.error.message}`, url)
        return j.result as T
      } catch (e) {
        last = e
      }
    }
    throw last instanceof Error ? last : new SvmRpcError(String(last))
  }

  async getAccountInfo(pubkeyBase58: string): Promise<SvmAccount | null> {
    const r = await this.call<{ value: RawAccount }>('getAccountInfo', [pubkeyBase58, { encoding: 'base64', commitment: 'confirmed' }])
    return toAccount(r.value)
  }

  /** Chunked: some public providers refuse more than 10 keys per call. */
  async getMultipleAccounts(pubkeys: string[]): Promise<(SvmAccount | null)[]> {
    const out: (SvmAccount | null)[] = []
    for (let i = 0; i < pubkeys.length; i += MAX_KEYS_PER_CALL) {
      const chunk = pubkeys.slice(i, i + MAX_KEYS_PER_CALL)
      const r = await this.call<{ value: RawAccount[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }])
      out.push(...r.value.map(toAccount))
    }
    return out
  }

  async getVersion(): Promise<string> {
    const r = await this.call<{ 'solana-core': string }>('getVersion', [])
    return r['solana-core']
  }

  async getBalance(pubkeyBase58: string): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [pubkeyBase58, { commitment: 'confirmed' }])
    return BigInt(r.value)
  }

  /** Dry-run of a fully built transaction (base64), signatures not required. */
  async simulateTransaction(base64Tx: string): Promise<SvmSimulation> {
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
      base64Tx,
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
    ])
    return { err: r.value.err ?? null, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed ?? 0 }
  }

  /** Recent priority fees (micro-lamports per CU) paid by transactions touching these accounts. */
  async getRecentPrioritizationFees(pubkeys: string[]): Promise<bigint[]> {
    const r = await this.call<{ prioritizationFee: number }[]>('getRecentPrioritizationFees', [pubkeys])
    return r.map((x) => BigInt(x.prioritizationFee))
  }

  async getSignatureStatus(signature: string): Promise<SvmSignatureStatus | null> {
    const r = await this.call<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
    const v = r.value[0]
    if (!v) return null
    return { confirmationStatus: v.confirmationStatus ?? 'processed', err: v.err ?? null }
  }
}

export type SvmSimulation = { err: unknown; logs: string[]; unitsConsumed: number }
export type SvmSignatureStatus = { confirmationStatus: string; err: unknown }
