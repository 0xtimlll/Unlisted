/**
 * The whitelist gate itself (scripts/check-whitelist.mjs), run against a fixture tree. A gate that
 * is "intentionally dumb" is only worth having if the dumb patterns actually fire, so the ones that
 * have been missed before are pinned here: code after a comment on the same line, a functionName
 * chosen at runtime, a read's functionName a few lines below a write, the raw-transaction family
 * under its other names, and a second Solana submit under a different variable name.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'check-whitelist.mjs')

/** The smallest tree the gate accepts: one file per directory it asserts non-vacuous, a clean svm/send.ts, an inert theme. */
function cleanTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'whitelist-'))
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put('src/core/abi.ts', "export const erc20Abi = ['function approve(address spender, uint256 value) returns (bool)']\n")
  put('src/protocols/lz-risk/probe.ts', "export const x = 1\n")
  put('src/protocols/lz-rescue/abi.ts', "export const y = 1\n")
  put('src/protocols/lz-rescue/actions.ts', "export type RescueCall = {\n  to: string\n  value: 0n\n}\n")
  put('src/core/svm/send.ts', "const ix = await oft.send(umi.rpc, {}, {}, {})\nconst sig = await builder.send(umi, { skipPreflight: false })\n")
  put('public/theme.js', "(function(){ try { var raw = localStorage.getItem('k') } catch {} })()\n")
  return root
}

function run(root: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, CHECK_WHITELIST_ROOT: root }, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

function withFile(rel: string, text: string): { status: number | null; out: string } {
  const root = cleanTree()
  try {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('check-whitelist', () => {
  it('passes the minimal clean tree', () => {
    const root = cleanTree()
    try {
      const r = run(root)
      expect(r.out).toContain('check-whitelist: ok')
      expect(r.status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sees code after a block comment on the same line', () => {
    const r = withFile('src/ui/X.ts', "/* a note */ writeContract({ abi, functionName: 'transfer', args: [] })\n")
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/writeContract with non-whitelisted functionName "transfer/)
  })

  it('still blanks a real block comment and a whole-line // comment', () => {
    const r = withFile('src/ui/X.ts', "/*\n * writeContract({ functionName: 'transfer' })\n */\n// eval('x')\nexport const ok = 1\n")
    expect(r.status).toBe(0)
  })

  it('refuses a functionName that is not a string literal, in both spellings', () => {
    for (const line of ["writeContract({ abi, functionName: name, args: [] })\n", "writeContract({ abi, functionName, args: [] })\n"]) {
      const r = withFile('src/ui/X.ts', `const name = 'send'\nconst functionName = 'send'\n${line}`)
      expect(r.status, line).toBe(1)
      expect(r.out, line).toMatch(/forbidden pattern .*functionName/)
    }
  })

  it('does not count a read’s functionName below the call as the write’s own', () => {
    const src = "writeContract({ abi, args: [] })\nreadContract({ abi, functionName: 'approve' })\n"
    const r = withFile('src/ui/X.ts', src)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/writeContract without a literal functionName/)
  })

  it('refuses the raw-transaction family under every name', () => {
    for (const bad of ['useSendTransaction()', 'sendTransactionAsync(req)', "provider.request({ method: 'eth_sendTransaction' })", 'signTypedDataAsync(x)', 'writeContracts({ contracts })', 'sendEncodedTransaction(tx)']) {
      const r = withFile('src/ui/X.ts', `${bad}\n`)
      expect(r.status, bad).toBe(1)
      expect(r.out, bad).toMatch(/forbidden pattern/)
    }
  })

  it('counts a second Solana submit even under another variable name', () => {
    const root = cleanTree()
    try {
      writeFileSync(join(root, 'src/core/svm/send.ts'), "const ix = await oft.send(umi.rpc, {}, {}, {})\nawait builder.send(umi, {})\nawait other.send(u2)\n")
      const r = run(root)
      expect(r.status).toBe(1)
      expect(r.out).toMatch(/expected exactly one Solana submit call/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the wallet-adapter signTransaction to the two files that hand the wallet to umi', () => {
    const r = withFile('src/ui/X.ts', "const s = wallet.signTransaction\n")
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/forbidden outside/)
  })

  it('holds public/theme.js to doing nothing but read a key', () => {
    const root = cleanTree()
    try {
      writeFileSync(join(root, 'public/theme.js'), "fetch('https://x.example')\n")
      const r = run(root)
      expect(r.status).toBe(1)
      expect(r.out).toMatch(/public\/theme\.js: forbidden pattern/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
