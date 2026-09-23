#!/usr/bin/env node
/**
 * §11 / §7.1: the app may submit ONLY three things:
 *   EVM    — `approve` and `send` via wagmi's writeContract (a literal functionName next to each call)
 *   Solana — the OFT program's `send` instruction, built by the LayerZero SDK (`oft.send`) and
 *            submitted through the umi transaction builder, from ONE file: src/core/svm/send.ts
 *
 * This script greps src/ for every state-changing / signing primitive and fails on anything else.
 * It is intentionally dumb (regex, no AST) so it is easy to audit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const WHITELIST = new Set(['approve', 'send'])

/**
 * Writes allowed only in named places, one protocol each:
 *   transfer  NttManager (evm/src/interfaces/INttManager.sol). It shares its name with ERC-20's
 *             `transfer`, so it is confined to the NTT module plus the one screen that submits it,
 *             AND src/core/abi.ts is checked below for never declaring a `transfer` of its own —
 *             together, no code path here can move tokens with a plain ERC-20 transfer.
 *   ccipSend  Router (contracts/src/v0.8/ccip/interfaces/IRouterClient.sol).
 */
const SCOPED_WRITES = {
  transfer: /^src\/(protocols\/wormhole-ntt\/|ui\/NttApp\.tsx$)/,
  ccipSend: /^src\/(protocols\/ccip\/|ui\/CcipApp\.tsx$)/,
}

const writeAllowed = (name, rel) => WHITELIST.has(name) || (SCOPED_WRITES[name]?.test(rel) ?? false)
const writeName = (name) => (SCOPED_WRITES[name] ? `${name} (only in ${SCOPED_WRITES[name].source})` : name)

// Any of these anywhere in src/ is a bug.
const FORBIDDEN = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /dangerouslySetInnerHTML/,
  /\bsignMessage\b/,
  /\bsignTypedData\b/,
  /\bsignAllTransactions\b/, // Solana: never batch-sign; one transaction, shown on screen, per click
  /\bsignIn\b/, // Solana "sign in with" — a message signature
  /\beth_sign\b/,
  /\bpersonal_sign\b/,
  /\bpermit\s*\(/i,
  /\bsendTransaction\b/, // raw tx = arbitrary calldata; we only use writeContract
  /\bsendRawTransaction\b/, // Solana raw submit (web3.js Connection) — only the builder path below may submit
  /\bsendAndConfirm\b/, // umi: confirms over WebSocket; the app confirms by polling instead (see core/svm/send.ts)
  /new\s+TransactionInstruction\s*\(/, // Solana: instructions come from the SDK, never assembled from config/network data
  /\btransactionBuilder\s*\(\s*\[/, // umi: a builder seeded with hand-made instructions
  /\bcreateApproveInstruction\b|\bapproveChecked\b|\bcreateApproveCheckedInstruction\b/, // SPL delegate approvals
  /\bsetAuthority\b|\bcreateSetAuthorityInstruction\b/,
  /\bcloseAccount\b|\bcreateCloseAccountInstruction\b/,
  /\bcreateTransferInstruction\b|\bcreateTransferCheckedInstruction\b|\btransferChecked\b/, // direct SPL transfers
  /\bfromSecretKey\b|\bfromSeed\b|\bgenerateSigner\b|\bcreateSignerFromKeypair\b|\bKeypair\b/, // no key material, ever
  /import\s*\(\s*['"]https?:/,
  /<script[^>]+src=['"]https?:/i,
]

// Write/simulate CALL sites: every occurrence must sit next to a whitelisted functionName.
// (The hook `useWriteContract()` itself carries no functionName; the `.writeContract({...})` call does.)
// `simulateCalls` (eth_simulateV1) is read-only, but it takes a LIST of calls, so it is held to the
// same rule: the batch it builds may contain nothing but approve and send.
const WRITE_CALL = /\b(writeContract|writeContractAsync|simulateContract|estimateContractGas|sendCalls|simulateCalls)\s*\(/g
const FUNCTION_NAME = /functionName\s*:\s*['"]([A-Za-z0-9_]+)['"]/g

// Solana: the SDK entry points and the single submit call are confined to one file.
const SVM_FILE = 'src/core/svm/send.ts'
// `oft` here is the SDK namespace (a standalone identifier), not a property like `info.oft`.
const SVM_SDK_CALL = /(?<![.\w])oft\.(send|quote|quoteOft)\s*\(/g
const SVM_SDK_OTHER = /(?<![.\w])oft\.(?!send\b|quote\b|quoteOft\b|accounts\b)[A-Za-z]+\s*\(/g // initOft, setPeerConfig, withdrawFee, …
const SVM_SUBMIT = /\.send\s*\(\s*umi\s*[,)]/g // builder.send(umi, …) — not oft.send(umi.rpc, …)
const SVM_SDK_IMPORT = /@layerzerolabs\/oft-v2-solana-sdk|@metaplex-foundation\/umi(?!\/serializers)|@solana\/web3\.js/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** Blank out comment-only lines (keeps line numbers). Code inside comments is not code. */
function stripCommentLines(text) {
  return text
    .split('\n')
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l))
    .join('\n')
}

const errors = []
let svmSubmits = 0
let svmSendCalls = 0
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  const text = stripCommentLines(readFileSync(file, 'utf8'))
  const lines = text.split('\n')

  lines.forEach((line, idx) => {
    for (const re of FORBIDDEN) {
      if (re.test(line)) errors.push(`${rel}:${idx + 1}: forbidden pattern ${re}`)
    }
  })

  // Every write call must be followed (within 12 lines) by a whitelisted functionName.
  let m
  WRITE_CALL.lastIndex = 0
  while ((m = WRITE_CALL.exec(text)) !== null) {
    const lineNo = text.slice(0, m.index).split('\n').length
    const window = lines.slice(lineNo - 1, lineNo + 12).join('\n')
    const names = [...window.matchAll(FUNCTION_NAME)].map((x) => x[1])
    if (names.length === 0) {
      errors.push(`${rel}:${lineNo}: ${m[1]} without a literal functionName nearby`)
    }
    for (const n of names) {
      if (!writeAllowed(n, rel)) errors.push(`${rel}:${lineNo}: ${m[1]} with non-whitelisted functionName "${writeName(n)}"`)
    }
  }

  // Also flag any functionName literal in src/ that is neither a read nor whitelisted write.
  // Reads are allowed; we only care that no *other* write sneaks in via a different helper.
  FUNCTION_NAME.lastIndex = 0
  while ((m = FUNCTION_NAME.exec(text)) !== null) {
    const n = m[1]
    const lineNo = text.slice(0, m.index).split('\n').length
    const KNOWN_READS = new Set([
      'quoteSend', 'quoteOFT', 'token', 'approvalRequired', 'sharedDecimals', 'decimalConversionRate',
      'oftVersion', 'peers', 'endpoint', 'owner', 'enforcedOptions',
      'decimals', 'symbol', 'name', 'balanceOf', 'allowance',
      // Analysis (stage: tasks 1-4). All view-only.
      'oAppVersion',     // IOAppCore: "is this a LayerZero app at all?"
      'getSendLibrary',  // IMessageLibManager: which send library serves (oapp, dstEid)
      'getUlnConfig',    // UlnBase: how many DVNs that route requires (informational)
      // Wormhole NTT (task 5). All view/pure — see src/protocols/wormhole-ntt/abi.ts for sources.
      'chainId', 'getMode', 'getThreshold', 'getPeer', 'tokenDecimals',
      'getCurrentOutboundCapacity', 'getCurrentInboundCapacity', 'getTransceivers', 'quoteDeliveryPrice',
      'getTransceiverType', 'getNttManagerToken', 'wormhole', 'getWormholePeer',
      'isWormholeRelayingEnabled', 'isSpecialRelayingEnabled', 'encodeWormholeTransceiverInstruction',
      // The token-side anchor that lets an NttManager become an approve spender at all.
      'minter', 'MINTER_ROLE', 'hasRole',
      // Chainlink CCIP (task 6). All view — see src/protocols/ccip/abi.ts for sources.
      'getFee', 'isChainSupported', 'getPool', 'getTokenConfig',
      'getToken', 'getTokenDecimals', 'getRouter', 'isSupportedChain', 'getSupportedChains',
      'getRemoteToken', 'getRemotePools',
      'getCurrentOutboundRateLimiterState', 'getCurrentInboundRateLimiterState',
    ])
    if (!writeAllowed(n, rel) && !KNOWN_READS.has(n)) {
      errors.push(`${rel}:${lineNo}: unknown functionName "${n}" (not in ABI §3)`)
    }
  }

  // Solana: SDK usage and the submit call only in SVM_FILE; no other SDK instruction anywhere.
  const isSvmFile = rel === SVM_FILE
  for (const [re, what] of [
    [SVM_SDK_CALL, 'LayerZero SDK call'],
    [SVM_SUBMIT, 'Solana submit'],
  ]) {
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length
      if (!isSvmFile) errors.push(`${rel}:${lineNo}: ${what} outside ${SVM_FILE}`)
      else if (re === SVM_SUBMIT) svmSubmits++
      else if (m[1] === 'send') svmSendCalls++
    }
  }
  SVM_SDK_OTHER.lastIndex = 0
  while ((m = SVM_SDK_OTHER.exec(text)) !== null) {
    const lineNo = text.slice(0, m.index).split('\n').length
    errors.push(`${rel}:${lineNo}: LayerZero SDK instruction other than send/quote: ${m[0].trim()}`)
  }
  if (!isSvmFile && !rel.startsWith('src/ui/svm/') && SVM_SDK_IMPORT.test(text) && !/^import type|\bimport type\b/.test(text.split('\n').find((l) => SVM_SDK_IMPORT.test(l)) ?? '')) {
    errors.push(`${rel}: imports the Solana SDK/umi/web3.js at runtime outside ${SVM_FILE} (type imports are fine)`)
  }
}

// `transfer` is only safe as a scoped write because the shared ERC-20 ABI has no such entry:
// if one were ever added, an approve-style call site could quietly move tokens instead.
{
  const abi = readFileSync(join(SRC, 'core/abi.ts'), 'utf8')
  if (/function\s+transfer\s*\(/.test(abi)) {
    errors.push('src/core/abi.ts: declares a `transfer` function — the shared ERC-20 ABI must never have one')
  }
}

if (svmSubmits !== 1) errors.push(`${SVM_FILE}: expected exactly one Solana submit call (builder.send(umi)), found ${svmSubmits}`)
if (svmSendCalls !== 1) errors.push(`${SVM_FILE}: expected exactly one oft.send( call, found ${svmSendCalls}`)

if (errors.length) {
  console.error('check-whitelist: FAILED')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log(
  'check-whitelist: ok (EVM: only approve/send may be written, plus NttManager.transfer and ' +
    `Router.ccipSend inside their own protocol modules; Solana: one oft.send + one submit in ${SVM_FILE})`,
)
