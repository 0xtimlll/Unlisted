/**
 * Minimal Solana JSON-RPC client over fetch: only the read methods this app needs.
 * URLs are tried in order (user's RPC first); nothing here can sign or send.
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

  async getMultipleAccounts(pubkeys: string[]): Promise<(SvmAccount | null)[]> {
    if (pubkeys.length === 0) return []
    const r = await this.call<{ value: RawAccount[] }>('getMultipleAccounts', [pubkeys, { encoding: 'base64', commitment: 'confirmed' }])
    return r.value.map(toAccount)
  }

  async getVersion(): Promise<string> {
    const r = await this.call<{ 'solana-core': string }>('getVersion', [])
    return r['solana-core']
  }
}
