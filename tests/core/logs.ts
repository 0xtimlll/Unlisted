/**
 * Builds a log exactly as a node would emit it, from the same ABI the scanner matches against.
 * viem has no encodeEventLog, so topics and data are assembled the way the EVM does: indexed
 * inputs become topics, the rest is ABI-encoded data.
 */
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Address, type Hex } from 'viem'

export type TestLog = { address: Address; topics: Hex[]; data: Hex }

function findEvent(abi: Abi, nameOrSignature: string): AbiEvent {
  const open = nameOrSignature.indexOf('(')
  const name = open === -1 ? nameOrSignature : nameOrSignature.slice(0, open)
  const types = open === -1 ? undefined : nameOrSignature.slice(open + 1, -1)
  const events = abi.filter((a): a is AbiEvent => a.type === 'event' && a.name === name)
  const found = types === undefined ? events[0] : events.find((e) => e.inputs.map((i) => i.type).join(',') === types)
  if (!found) throw new Error(`no event ${nameOrSignature} in abi`)
  return found
}

export function makeLog(address: Address, abi: Abi, nameOrSignature: string, args: Record<string, unknown>): TestLog {
  const event = findEvent(abi, nameOrSignature)
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args,
  } as Parameters<typeof encodeEventTopics>[0]) as Hex[]
  const nonIndexed = event.inputs.filter((i) => !i.indexed)
  const data = nonIndexed.length === 0 ? '0x' : encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name ?? '']))
  return { address, topics, data }
}
