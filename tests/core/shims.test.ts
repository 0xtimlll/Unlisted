/**
 * shims/README.md: the stand-ins for LayerZero helper packages must behave exactly like the
 * originals for the functions the Solana SDK imports, the SDK must not start importing more, and
 * the replaced packages must stay empty in node_modules.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as shimUtils from '../../shims/lz-utilities/index.js'
import * as shimFoundation from '../../shims/lz-foundation/index.js'
import * as shimSdkRoot from '../../shims/lz-solana-sdk-v2/index.js'
import vectors from './shim-vectors.json'

const require = createRequire(import.meta.url)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/**
 * Reference outputs recorded from the real @layerzerolabs/lz-utilities and lz-foundation 3.0.168
 * (tests/core/shim-vectors.json, generated with the packages installed). The real packages are no
 * longer installed at all (package.json `overrides` → an empty package), so the vectors are the contract.
 */
type Vectors = { arrayify: Record<string, string>; arrayify32: Record<string, string>; hexlify: Record<string, string>; isHex: Record<string, boolean>; padify: Record<string, string>; keccak: Record<string, string>; sha2: Record<string, string> }
const V = vectors as Vectors
const key = (v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? `u8:${hex(v)}` : JSON.stringify(v))
const inputs: unknown[] = ['0x', '0x00', '0xff', '0x0abc', 'abc', '0xDEADbeef', 0, 1, 255, 256, 65535, 1n, 0xdeadbeefn, new Uint8Array([1, 2, 3]), new Uint8Array(0)]

describe('shims match the recorded behaviour of the real packages', () => {
  it('arrayify', () => {
    for (const v of inputs) expect(hex(shimUtils.arrayify(v as never))).toBe(V.arrayify[key(v)])
    for (const v of ['0x0abc', 'ff', new Uint8Array([1, 2, 3])]) expect(hex(shimUtils.arrayify(v, 32))).toBe(V.arrayify32[key(v)])
    for (const bad of ['0xzz', 'hello', -1, {}]) expect(() => shimUtils.arrayify(bad as never)).toThrow()
    expect(Object.keys(V.arrayify)).toHaveLength(inputs.length)
  })

  it("hexlify (including the original's quirk: empty bytes throw)", () => {
    for (const v of inputs) {
      const want = V.hexlify[key(v)]!
      if (want.startsWith('THROW:')) expect(() => shimUtils.hexlify(v as never)).toThrow(want.slice(6))
      else expect(shimUtils.hexlify(v as never)).toBe(want)
    }
  })

  it('isHex', () => {
    for (const [v, want] of Object.entries(V.isHex)) expect(shimUtils.isHex(v)).toBe(want)
  })

  it('padify', () => {
    const opts = { def: {}, s4: { size: 4 }, r4: { dir: 'right' as const, size: 4 }, nul: { size: null } }
    for (const v of ['0xff', 'ff', new Uint8Array([1, 2, 3])]) {
      for (const [n, o] of Object.entries(opts)) {
        const a = shimUtils.padify(v as never, o as never)
        expect(typeof a === 'string' ? a : `u8:${hex(a)}`).toBe(V.padify[`${key(v)}|${n}`])
      }
    }
    expect(() => shimUtils.padify(new Uint8Array(5), { size: 4 })).toThrow(/exceeds padding size/)
  })

  it('keccak_256 / sha2_256', () => {
    for (const v of [new Uint8Array(0), new Uint8Array([1, 2, 3]), 'global:send', 'event:Foo']) {
      expect(hex(shimFoundation.keccak_256(v))).toBe(V.keccak[key(v)])
      expect(hex(shimFoundation.sha2_256(v))).toBe(V.sha2[key(v)])
    }
    // The Anchor discriminator the SDK derives with sha2_256 is the one our own codec uses.
    expect(hex(shimFoundation.sha2_256('global:send')).slice(0, 16)).toBe('66fb14bb414b0c45')
  })

  it('LZ_RECEIVE_TYPES_SEED', () => {
    expect(shimSdkRoot.LZ_RECEIVE_TYPES_SEED).toBe('LzReceiveTypes')
  })

  it('the replaced packages really are empty on disk', () => {
    for (const p of ['@layerzerolabs/lz-utilities', '@layerzerolabs/lz-foundation', '@layerzerolabs/lz-serdes', '@layerzerolabs/lz-corekit-solana']) {
      const pkg = JSON.parse(readFileSync(require.resolve(`${p}/package.json`), 'utf8')) as { name: string; dependencies?: unknown }
      expect(pkg.name).toBe('empty-npm-package')
      expect(pkg.dependencies).toBeUndefined()
    }
  })
})

/** `exports` maps hide dist files; go through the package directory instead. */
function resolveDist(spec: string): string {
  const [scope, name, ...rest] = spec.split('/')
  const pkgDir = require.resolve(`${scope}/${name}/package.json`).replace(/package\.json$/, '')
  return pkgDir + rest.join('/')
}

describe('the SDK still imports only what the shims provide', () => {
  const imported = (file: string, pkg: string): string[] => {
    const src = readFileSync(resolveDist(file), 'utf8')
    const names = new Set<string>()
    for (const m of src.matchAll(new RegExp(`import \\{([^}]*)\\} from '${pkg.replace('/', '\\/')}'`, 'g'))) {
      for (const n of m[1]!.split(',')) names.add(n.trim().split(' as ')[0]!.trim())
    }
    return [...names].filter(Boolean).sort()
  }
  const oftSdk = '@layerzerolabs/oft-v2-solana-sdk/dist/index.mjs'
  const solanaSdkUmi = '@layerzerolabs/lz-solana-sdk-v2/dist/umi.mjs'

  it('lz-utilities: arrayify only (plus what lz-foundation needed, now shimmed too)', () => {
    expect(imported(solanaSdkUmi, '@layerzerolabs/lz-utilities')).toEqual(['arrayify'])
    expect(imported(oftSdk, '@layerzerolabs/lz-utilities')).toEqual([])
  })
  it('lz-foundation: keccak_256 and sha2_256 only', () => {
    expect(imported(solanaSdkUmi, '@layerzerolabs/lz-foundation')).toEqual(['keccak_256', 'sha2_256'])
    expect(imported(oftSdk, '@layerzerolabs/lz-foundation')).toEqual([])
  })
  it('lz-solana-sdk-v2 root entry: LZ_RECEIVE_TYPES_SEED only', () => {
    expect(imported(oftSdk, '@layerzerolabs/lz-solana-sdk-v2')).toEqual(['LZ_RECEIVE_TYPES_SEED'])
    expect(imported(solanaSdkUmi, '@layerzerolabs/lz-solana-sdk-v2')).toEqual([])
  })
  it('the never-imported packages stay never-imported', () => {
    for (const f of [oftSdk, solanaSdkUmi]) {
      const src = readFileSync(resolveDist(f), 'utf8')
      expect(src).not.toMatch(/from '@layerzerolabs\/(lz-serdes|lz-corekit-solana|tron-utilities)/)
    }
  })
})
