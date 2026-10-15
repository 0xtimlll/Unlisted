/**
 * Draws the networks the curated file does not: the tile colour and the mark, from the table in
 * scripts/networks-brand.json. Used by scripts/update-networks.ts, on a full run and with
 * `--brand-only` (which redraws the brands of the committed registry without touching anything else).
 *
 * Every mark is written into public/chains and served from the site's own origin (CSP img-src
 * 'self'); nothing is loaded from a third party at runtime. An SVG that carries anything but
 * shapes — a script, an event handler, a foreignObject, an external reference — is refused rather
 * than cleaned: a logo has no business containing one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type MarkMode = 'mono' | 'white' | 'asis' | 'raster-white' | 'raster'
export type BrandSpec = { bg: string; dark?: boolean; mark?: { src: string; mode: MarkMode; round?: boolean } }
export type DrawnBrand = { bg: string; dark: boolean; mark: string | null }

const W3 = 'https://raw.githubusercontent.com/0xa3k5/web3icons/main/raw-svgs/'
const HL = 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/chains/'
const EL = 'https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/icons/'
/** Public IPFS gateways, tried in turn: each one rate-limits or times out on its own schedule. A file's CID is its hash, so which gateway served it does not matter. */
const IPFS_GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/', 'https://4everland.io/ipfs/']
export const DARK_INK = '#0B0E11'
const SIZE = 160
/**
 * web3icons draws every mark on a 24-unit grid with a margin of about three units; marks from the
 * other sources fill their whole box. They get the same margin here, so every tile's mark is the
 * same optical size.
 */
const MARGIN = 0.14

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' }

async function fetchBytes(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: UA, redirect: 'follow' })
  if (!r.ok) throw new Error(`${url} answered ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

/** Where a mark comes from, in words for ATTRIBUTION.md. */
function describe(src: string): string {
  const [kind, rest] = [src.slice(0, src.indexOf(':')), src.slice(src.indexOf(':') + 1)]
  if (kind === 'w3') return `web3icons raw-svgs/${rest}.svg (MIT)`
  if (kind === 'hl') return `hyperlane-registry chains/${rest}/logo.svg (MIT)`
  if (kind === 'el') return `ethereum-lists/chains _data/icons/${rest}.json (MIT)`
  if (kind === 'site') return `the network's own site, ${new URL(rest).host}`
  if (kind === 'copy') return `the ${rest} mark above`
  return src
}

async function fetchSource(src: string, iconsDir: string): Promise<Buffer> {
  const i = src.indexOf(':')
  const kind = src.slice(0, i)
  const rest = src.slice(i + 1)
  if (kind === 'w3') return fetchBytes(`${W3}${rest}.svg`)
  if (kind === 'hl') return fetchBytes(`${HL}${rest}/logo.svg`)
  if (kind === 'site') return fetchBytes(rest)
  if (kind === 'copy') return readFileSync(join(iconsDir, `${rest}.svg`))
  if (kind === 'el') {
    const meta = JSON.parse((await fetchBytes(`${EL}${rest}.json`)).toString('utf8')) as { url: string; format?: string }[]
    const best = meta.find((m) => m.format === 'svg') ?? meta[0]
    if (!best) throw new Error(`${rest}.json lists no icon`)
    const cid = best.url.replace('ipfs://', '')
    let last: unknown
    for (let round = 0; round < 2; round++) {
      for (const gw of IPFS_GATEWAYS) {
        try {
          return await fetchBytes(gw + cid)
        } catch (e) {
          last = e
        }
      }
      await new Promise((r) => setTimeout(r, 5_000))
    }
    throw last instanceof Error ? last : new Error(String(last))
  }
  throw new Error(`unknown mark source ${src}`)
}

const isSvg = (b: Buffer) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString('utf8'))

/** A logo is shapes. Anything that can run, load or embed is refused. */
export function unsafeSvg(svg: string): string | undefined {
  if (/<script/i.test(svg)) return 'script element'
  if (/\son[a-z]+\s*=/i.test(svg)) return 'event handler attribute'
  if (/<foreignObject/i.test(svg)) return 'foreignObject'
  if (/javascript:/i.test(svg)) return 'javascript: URL'
  if (/(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);base64,)/i.test(svg)) return 'external reference'
  if (/<!ENTITY|<!DOCTYPE/i.test(svg)) return 'DTD or entity'
  if (/@import|url\(\s*["']?(?!#)/i.test(svg)) return 'external CSS'
  return undefined
}

/** web3icons mono marks are white; on a light tile they are turned near-black. */
function recolourMono(svg: string, dark: boolean): string {
  if (!dark) return svg
  return svg
    .replace(/(fill|stroke|stop-color)=["'](white|#fff|#ffffff)["']/gi, `$1="${DARK_INK}"`)
    .replace(/(fill|stroke|stop-color):\s*(white|#fff|#ffffff)/gi, `$1:${DARK_INK}`)
}

/** Every colour in the mark becomes one colour: a silhouette of the official mark. */
function silhouette(svg: string, colour: string): string {
  let out = svg
    .replace(/(fill|stroke|stop-color)=["'](?!none|transparent|url\()[^"']*["']/gi, `$1="${colour}"`)
    .replace(/(fill|stroke|stop-color):\s*(?!none|transparent|url\()[^;"'}]+/gi, `$1:${colour}`)
  // Shapes with no fill of their own inherit the root's, which defaults to black.
  out = out.replace(/<svg\b([^>]*)>/i, (m, attrs: string) => (/\sfill=/i.test(attrs) ? m : `<svg${attrs} fill="${colour}">`))
  // A gradient referenced by url() keeps its stops, which were recoloured above.
  return out
}

/** A square viewBox around the mark with MARGIN on every side; width and height go, the tile sizes it. */
export function padSvg(svg: string): string {
  const open = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!open) return svg
  const vb = open.match(/viewBox=["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i)
  const num = (re: RegExp) => Number(open.match(re)?.[1] ?? NaN)
  let [x, y, w, h] = vb ? [Number(vb[1]), Number(vb[2]), Number(vb[3]), Number(vb[4])] : [0, 0, num(/\swidth=["']([\d.]+)/i), num(/\sheight=["']([\d.]+)/i)]
  if (!(w > 0 && h > 0)) return svg
  const side = Math.max(w, h) * (1 + 2 * MARGIN)
  x -= (side - w) / 2
  y -= (side - h) / 2
  w = h = side
  const r = (v: number) => Math.round(v * 1000) / 1000
  const rebuilt = open
    .replace(/\sviewBox=["'][^"']*["']/i, '')
    .replace(/\swidth=["'][^"']*["']/i, '')
    .replace(/\sheight=["'][^"']*["']/i, '')
    .replace(/<svg\b/i, `<svg viewBox="${r(x)} ${r(y)} ${r(w)} ${r(h)}"`)
  return svg.replace(open, rebuilt)
}

/** The bytes of the first PNG inside a buffer (an .ico wraps one). */
function pngInside(b: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const at = b.indexOf(sig)
  return at > 0 ? b.subarray(at) : b
}

async function rasterise(bytes: Buffer, mode: 'raster' | 'raster-white', round: boolean, dark: boolean): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const input = pngInside(bytes)
  if (mode === 'raster-white') {
    const inner = Math.round(SIZE / (1 + 2 * MARGIN))
    const pad = Math.floor((SIZE - inner) / 2)
    const { data, info } = await sharp(input)
      .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: pad, bottom: SIZE - inner - pad, left: pad, right: SIZE - inner - pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const [r, g, b] = dark ? [0x0b, 0x0e, 0x11] : [255, 255, 255]
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()
  }
  if (round) {
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.24}" ry="${SIZE * 0.24}"/></svg>`)
    return sharp(input).resize(SIZE, SIZE, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png({ compressionLevel: 9 }).toBuffer()
  }
  const inner = Math.round(SIZE / (1 + 2 * MARGIN))
  const pad = Math.floor((SIZE - inner) / 2)
  return sharp(input)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: pad, bottom: SIZE - inner - pad, left: pad, right: SIZE - inner - pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * Draws one network: fetches its mark, turns it into the file the tile shows, writes it (unless
 * `check`), and says where it came from. A mark that cannot be had leaves the tile with its colour
 * and the network's initials — never a borrowed or invented picture.
 */
export async function drawBrand(key: string, spec: BrandSpec, opts: { iconsDir: string; check: boolean }): Promise<{ brand: DrawnBrand; attribution?: string; note?: string }> {
  const dark = spec.dark ?? false
  if (!spec.mark) return { brand: { bg: spec.bg, dark, mark: null } }
  const { src, mode, round = false } = spec.mark
  try {
    const bytes = await fetchSource(src, opts.iconsDir)
    let file: string
    let out: Buffer
    if (mode === 'raster' || mode === 'raster-white') {
      out = await rasterise(bytes, mode, round, dark)
      file = `${key}.png`
    } else {
      if (!isSvg(bytes)) throw new Error('not an SVG')
      const svg = bytes.toString('utf8')
      const bad = unsafeSvg(svg)
      if (bad) throw new Error(`refused: the SVG carries a ${bad}`)
      const coloured = mode === 'mono' ? recolourMono(svg, dark) : mode === 'white' ? silhouette(svg, dark ? DARK_INK : '#FFFFFF') : svg
      // web3icons marks (and a copy of one) already sit on their padded 24-unit grid.
      const drawn = src.startsWith('w3:') || src.startsWith('copy:') ? coloured : padSvg(coloured)
      out = Buffer.from(drawn)
      file = `${key}.svg`
    }
    const path = join(opts.iconsDir, file)
    if (!opts.check) writeFileSync(path, out)
    else if (!existsSync(path)) return { brand: { bg: spec.bg, dark, mark: file }, note: `public/chains/${file} is missing` }
    const how = mode === 'mono' ? (dark ? 'mono, recoloured near-black' : 'mono, white as published') : mode === 'white' ? `every colour set to ${dark ? 'near-black' : 'white'}` : mode === 'asis' ? 'as published' : mode === 'raster-white' ? `raster turned into a ${dark ? 'near-black' : 'white'} silhouette` : round ? 'raster, cropped to a rounded square' : 'raster, resized'
    return { brand: { bg: spec.bg, dark, mark: file }, attribution: `| ${file} | ${describe(src)} | ${how}; tile ${spec.bg} |` }
  } catch (e) {
    return { brand: { bg: spec.bg, dark, mark: null }, note: `mark ${src} could not be drawn (${String((e as Error).message).slice(0, 120)}) — the tile shows initials` }
  }
}

/** A colour for a network the brand table does not know yet: the web3icons `background` field, else neutral. */
export async function guessBrand(w3Id: string | undefined): Promise<BrandSpec> {
  if (!w3Id) return { bg: '#3A3A3A' }
  try {
    const svg = (await fetchBytes(`${W3}networks/background/${w3Id}.svg`)).toString('utf8')
    const bg = svg.match(/<path d="M24 0H0V24H24V0Z" fill="(#[0-9A-Fa-f]{6})"/)?.[1]
    const L = bg ? luminance(bg) : 0
    return { bg: bg ?? '#000000', dark: L > 0.5, mark: { src: `w3:networks/mono/${w3Id}`, mode: 'mono' } }
  } catch {
    return { bg: '#3A3A3A' }
  }
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}
