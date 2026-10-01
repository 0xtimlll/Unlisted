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

// CHECK_WHITELIST_ROOT points the gate at a fixture tree (tests/core/checkWhitelist.test.ts); unset, it is this repo.
const ROOT = process.env.CHECK_WHITELIST_ROOT ? process.env.CHECK_WHITELIST_ROOT.replace(/\/?$/, '/') : new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const WHITELIST = new Set(['approve', 'send'])

/**
 * Writes allowed only in named places, one protocol each:
 *   transfer  NttManager (evm/src/interfaces/INttManager.sol). It shares its name with ERC-20's
 *             `transfer`, so it is confined to the NTT module plus the one screen that submits it,
 *             AND src/core/abi.ts is checked below for never declaring a `transfer` of its own —
 *             together, no code path here can move tokens with a plain ERC-20 transfer.
 *   ccipSend  Router (contracts/src/v0.8/ccip/interfaces/IRouterClient.sol).
 *   retryPayload, retryMessage, commitVerification, lzReceive
 *             §5's rescue actions: Endpoint V1 (contracts/Endpoint.sol), NonblockingLzApp,
 *             ReceiveUln302 and EndpointV2 respectively. Confined to the rescue module alone, which
 *             is separately asserted below never to carry value. None of them moves a token: each
 *             asks a contract to finish delivering a message it already holds the hash of.
 *   sendFrom  LayerZero v1 OFT (LayerZero-Labs/solidity-examples, IOFTCore / IOFTV2 /
 *             IOFTWithFee). Confined to the v1 protocol module ALONE — not to a screen as well —
 *             because src/protocols/lz-v1/send.ts takes wagmi's writeContractAsync as an
 *             argument, so the tab that submits never names the function it is submitting.
 */
const SCOPED_WRITES = {
  transfer: /^src\/(protocols\/wormhole-ntt\/|ui\/NttApp\.tsx$)/,
  ccipSend: /^src\/(protocols\/ccip\/|ui\/CcipApp\.tsx$)/,
  sendFrom: /^src\/protocols\/lz-v1\//,
  retryPayload: /^src\/protocols\/lz-rescue\//,
  retryMessage: /^src\/protocols\/lz-rescue\//,
  commitVerification: /^src\/protocols\/lz-rescue\//,
  lzReceive: /^src\/protocols\/lz-rescue\//,
}

/**
 * §4 names two functions that DO change state — `nonblockingLzReceive` (v1) and `lzReceive` (v2) —
 * and builds calldata for them so it can `eth_call` the credit on the destination before anything is
 * signed. They are the most valuable check in the risk indicator and they must never be submitted.
 *
 * So they are allowed to appear as a `functionName` literal only inside the risk module, and that
 * module is separately asserted to contain no write primitive at all (see RISK_DIR below). Folding
 * them into SCOPED_WRITES would have allowed a `writeContract` next to them; this does not.
 */
const RISK_DIR = /^src\/protocols\/lz-risk\//
const SIMULATED_ONLY = new Set(['nonblockingLzReceive', 'lzReceive'])

const writeAllowed = (name, rel) => WHITELIST.has(name) || (SCOPED_WRITES[name]?.test(rel) ?? false)
const simulatedOnly = (name, rel) => SIMULATED_ONLY.has(name) && RISK_DIR.test(rel)
const writeName = (name) => (SCOPED_WRITES[name] ? `${name} (only in ${SCOPED_WRITES[name].source})` : name)

// Any of these anywhere in src/ is a bug.
const FORBIDDEN = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /dangerouslySetInnerHTML/,
  /\bsignMessage\b/,
  /\bsignTypedData\w*/, // signTypedData, signTypedDataAsync, signTypedData_v4, useSignTypedData
  /\beth_sign\w*/, // eth_sign, eth_signTypedData*, eth_signTransaction
  /\beth_send\w*/, // eth_sendTransaction, eth_sendRawTransaction
  /\bwallet_sendCalls\b|\bwallet_sign\w*/, // EIP-5792 batches and any wallet_* signature method
  /\.request\s*\(/, // a raw provider request: every chain read here goes through viem's typed client
  /\bsignAllTransactions\b/, // Solana: never batch-sign; one transaction, shown on screen, per click
  /\bsignIn\b/, // Solana "sign in with" — a message signature
  /\beth_sign\b/,
  /\bpersonal_sign\b/,
  /\bpermit\s*\(/i,
  /sendTransaction\w*/i, // sendTransaction, sendTransactionAsync, useSendTransaction, sendTransactionSync: raw calldata
  /\bsendRawTransaction\b/, // Solana raw submit (web3.js Connection) — only the builder path below may submit
  /\bsendEncodedTransaction\b/, // Solana: the same, base64
  /\bwriteContracts\b|\buseWriteContracts\b/, // EIP-5792 batch of calls: a list is not one literal functionName
  /\bprepareTransactionRequest\b|\bsignAndSendTransaction\b/,
  /\bsendAndConfirm\b/, // umi: confirms over WebSocket; the app confirms by polling instead (see core/svm/send.ts)
  /new\s+TransactionInstruction\s*\(/, // Solana: instructions come from the SDK, never assembled from config/network data
  /\btransactionBuilder\s*\(\s*\[/, // umi: a builder seeded with hand-made instructions
  /\bcreateApproveInstruction\b|\bapproveChecked\b|\bcreateApproveCheckedInstruction\b/, // SPL delegate approvals
  /\bsetAuthority\b|\bcreateSetAuthorityInstruction\b/,
  /\bcloseAccount\b|\bcreateCloseAccountInstruction\b/,
  /\bcreateTransferInstruction\b|\bcreateTransferCheckedInstruction\b|\btransferChecked\b/, // direct SPL transfers
  /\bfromSecretKey\b|\bfromSeed\b|\bgenerateSigner\b|\bcreateSignerFromKeypair\b|\bKeypair\b/, // no key material, ever
  /(?<![.\w])functionName\s*:(?!\s*['"])/, // a functionName that is not a string literal is a name chosen at runtime
  /(?<![.\w])functionName\s*[,}]/, // the shorthand `{ functionName }`: same thing (`x.functionName` is a read of a decoded call)
  /import\s*\(\s*['"]https?:/,
  /<script[^>]+src=['"]https?:/i,
]

/**
 * Forbidden everywhere but in the named files. `signTransaction` is the wallet-adapter method umi's
 * identity plugin calls when builder.send() signs: the type that names it (core/svm/send.ts) and the
 * screen that hands the wallet over (ui/svm/SolanaStack.tsx) are the only places it may be spelled.
 * Anywhere else it would be the app signing a transaction it then broadcasts by some other path.
 */
const SCOPED_FORBIDDEN = [
  { re: /\bsignTransaction\w*/, allow: /^src\/(core\/svm\/send\.ts|ui\/svm\/SolanaStack\.tsx)$/ },
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
// builder.send(<identifier>, …): any variable name, so renaming `umi` cannot hide a second submit.
// oft.send(umi.rpc, …) has a dot after the identifier and is counted separately as the SDK call.
const SVM_SUBMIT = /\.send\s*\(\s*[A-Za-z_$][\w$]*\s*[,)]/g
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

/**
 * Blank out comments (keeps line numbers). Code inside comments is not code — but code AFTER a
 * comment on the same line is, so only whole-line `//` comments go, and a block comment is
 * removed from an opening `/*` at the start of a line up to its own `*\/`, never the rest of the
 * line after it. The earlier rule blanked any line that merely BEGAN with `/*` or `*`, so
 * `/* note *\/ writeContract(...)` was invisible to every check below.
 */
function stripCommentLines(text) {
  const blanks = (s) => s.replace(/[^\n]/g, '')
  return text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blanks)
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
}

/**
 * The text of one call: from its opening paren to the matching close. Quotes and template strings
 * are skipped so a paren inside a string does not end the call early; an unbalanced call runs to
 * the end of the file, which can only make the check stricter.
 */
function callBody(text, openParenIdx) {
  let depth = 0
  let quote = null
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openParenIdx, i + 1)
    }
  }
  return text.slice(openParenIdx)
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
    for (const { re, allow } of SCOPED_FORBIDDEN) {
      if (re.test(line) && !allow.test(rel)) errors.push(`${rel}:${idx + 1}: forbidden outside ${allow.source}: ${re}`)
    }
  })

  // Every write call must carry a whitelisted functionName INSIDE its own parentheses. A window
  // of lines after the call would also have seen a read's functionName a few lines down.
  let m
  WRITE_CALL.lastIndex = 0
  while ((m = WRITE_CALL.exec(text)) !== null) {
    const lineNo = text.slice(0, m.index).split('\n').length
    const window = callBody(text, m.index + m[0].length - 1)
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
      // §Adapter totalSupply: the denominator of the locked-share signal in lz-risk/adapters.ts.
      // A plain ERC-20 view, read from the real token, never from the contract under examination.
      'totalSupply',
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
      // LayerZero v1 (§3). All view — see src/protocols/lz-v1/abi.ts for the source of each.
      'lzEndpoint', 'trustedRemoteLookup', 'getTrustedRemoteAddress', 'minDstGasLookup',
      'payloadSizeLimitLookup', 'useCustomAdapterParams', 'estimateSendFee', 'quoteOFTFee',
      'circulatingSupply',
      // Endpoint V1 (LayerZero-Labs/LayerZero, ILayerZeroEndpoint.sol).
      'getChainId', 'hasStoredPayload', 'estimateFees', 'getInboundNonce', 'getOutboundNonce',
      'getSendVersion', 'getReceiveVersion',
      // §4 route risk. All view — see src/protocols/lz-risk/ for the source of each.
      'localChainId', 'paused',
      'getAppConfig', 'defaultAppConfig',
      'inboundNonce', 'outboundNonce', 'getReceiveLibrary',
      // ILayerZeroEndpointV2.quote: the endpoint's own price for a packet, against the OFT's quoteSend.
      'quote',
      // §5 rescue, read-only side. See src/protocols/lz-rescue/abi.ts for the source of each.
      'storedPayload', 'failedMessages', 'lazyInboundNonce', 'inboundPayloadHash', 'verifiable',
      'initializable', 'hashLookup',
    ])
    if (!writeAllowed(n, rel) && !KNOWN_READS.has(n) && !simulatedOnly(n, rel)) {
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

// §4: the risk module simulates a destination credit, so it names two state-changing functions.
// That is only safe while it cannot submit anything, which is asserted here rather than assumed.
{
  const riskFiles = walk(SRC).map((f) => relative(ROOT, f)).filter((rel) => RISK_DIR.test(rel))
  if (riskFiles.length === 0) errors.push('scripts/check-whitelist.mjs: RISK_DIR matches no files — the assertion below is vacuous')
  for (const rel of riskFiles) {
    const text = stripCommentLines(readFileSync(join(ROOT, rel), 'utf8'))
    WRITE_CALL.lastIndex = 0
    const m = WRITE_CALL.exec(text)
    if (m) {
      const lineNo = text.slice(0, m.index).split('\n').length
      errors.push(`${rel}:${lineNo}: the risk module may simulate but never submit — found ${m[1]}`)
    }
    if (/\buseWriteContract\b|\bwalletClient\b/.test(text)) {
      errors.push(`${rel}: the risk module must not reach a wallet`)
    }
  }
}

/**
 * §5: a rescue asks a contract to finish delivering a message it already holds the hash of. It never
 * pays for anything, and the two non-payable functions must carry no `value` field at all.
 *
 * The type system is the real guard here — `RescueCall.value` is the literal type `0n`, so a plan
 * cannot be built with anything else, and submitRescue throws if it somehow were. What this check
 * adds is the case types cannot catch: somebody writing an amount into that module by hand. So it
 * looks for a `value:` given a number, a bigint literal other than 0n, or one of the ether helpers —
 * and deliberately not for every `value:`, because `value` is an ordinary field name and flagging
 * `{ ok: true, value: address }` would make this check noise rather than a rule.
 */
{
  const RESCUE_DIR = /^src\/protocols\/lz-rescue\//
  const AMOUNT = /\bvalue\s*:\s*(?!0n\b)(\d[\d_]*n?|BigInt\(|parseEther\(|parseUnits\(|msg\b)/
  const files = walk(SRC).map((f) => relative(ROOT, f)).filter((rel) => RESCUE_DIR.test(rel))
  if (files.length === 0) errors.push('scripts/check-whitelist.mjs: RESCUE_DIR matches no files — the assertion below is vacuous')
  for (const rel of files) {
    const lines = stripCommentLines(readFileSync(join(ROOT, rel), 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const m = AMOUNT.exec(line)
      if (m) errors.push(`${rel}:${i + 1}: a rescue may only ever carry value 0n, found ${m[1]}`)
    })
  }
  // And the one field that decides it is typed as the literal, not merely commented as one.
  const actions = readFileSync(join(SRC, 'protocols/lz-rescue/actions.ts'), 'utf8')
  if (!/value:\s*0n\s*$/m.test(actions) || !/\bvalue:\s*0n\b/.test(actions)) {
    errors.push('src/protocols/lz-rescue/actions.ts: RescueCall must type `value` as the literal 0n')
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

/**
 * public/theme.js runs before anything else on every page and is the one script the CSP allows by
 * origin rather than by hash. It reads one localStorage key and toggles a class; it must never
 * grow a network call, a dynamic import or a DOM write that could carry text.
 */
{
  const theme = readFileSync(join(ROOT, 'public', 'theme.js'), 'utf8')
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bimport\s*\(/, /\bimportScripts\b/, /document\.write/, /innerHTML|outerHTML|insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bWebSocket\b|\bnavigator\.sendBeacon\b/, /createElement\s*\(\s*['"]script/i, /location\s*(\.href|\.assign|\.replace|=)/]) {
    if (re.test(theme)) errors.push(`public/theme.js: forbidden pattern ${re}`)
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
  'check-whitelist: ok (EVM: only approve/send may be written, plus NttManager.transfer, ' +
    'Router.ccipSend and the LayerZero v1 OFT.sendFrom inside their own protocol modules; ' +
    'lzReceive/nonblockingLzReceive are simulated-only in the risk module, which cannot submit; ' +
    'the four rescue actions live only in the rescue module, which may never carry value; ' +
    `Solana: one oft.send + one submit in ${SVM_FILE})`,
)
