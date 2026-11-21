/**
 * @file Reads of gates, admin capabilities and the platform configuration from the chain.
 *
 * Role: the read side for operators. An operator holds an `AdminCap` per gate; discovery lists the caps, reads each cap's `gate_id` and fetches the shared
 * `Gate`. Every parser checks the object's exact type under the package's original id and returns `null` when any field is missing or mistyped, so a
 * missing price can never read as a free gate.
 *
 * Main exports: `fetchOwnedGates`, `fetchGate`, `fetchPlatformConfig`, `fetchAdminCaps`, `ownsPlatformAdminCap`, and the pure parsers `parseGate`,
 * `parseAdminCap`, `parsePlatformConfig`. Tested in `tests/gates.test.ts`; the field names are pinned against the Move package by `tests/schema.test.ts`.
 */
import type {
  CommissionTerms,
  GatePolicy,
  OwnedGate,
  OwnedObjectsClient,
  PlatformConfigInfo,
  SuiObjectClient,
} from './types.js'
import { accessGateType, isAccessGateType } from './typeNames.js'
import { coreObject, listAllOwnedObjects } from './ownership.js'
import { boolField, idField, stringField, structFields, u64Field } from './json.js'

// An operator holds an `AdminCap` per gate they administer. Discovery: list owned AdminCaps, read
// each cap's `gate_id`, then fetch the shared `Gate`. Every parser checks the object's exact type
// under the package's original id, and returns `null` when a field is missing or mistyped — never a
// default (a missing price must not read as a free gate). IDs and addresses come back normalised.

/** A gate's state as read from its `Gate` object (without the owning `AdminCap`). */
export type GateState = Omit<OwnedGate, 'adminCapId'>

/** Parse an `AdminCap` into `{ adminCapId, gateId }`, or `null` if it is not one. */
export function parseAdminCap(entry: unknown, originalId: string): { adminCapId: string; gateId: string } | null {
  const obj = coreObject(entry)
  // Only an `AdminCap` of this package (exact type match) is one.
  if (!obj?.objectId || !isAccessGateType(obj.type, originalId, 'AdminCap')) return null
  const f = structFields(obj.json)
  // The cap names its gate; the camelCase spelling is accepted for transports that rename fields.
  const gateId = idField(f?.gate_id ?? f?.gateId)
  const adminCapId = idField(obj.objectId)
  return gateId && adminCapId ? { adminCapId, gateId } : null
}

/** Parse a `Gate` shared object, or `null` if it is not one or a field is missing or mistyped. */
export function parseGate(entry: unknown, originalId: string): GateState | null {
  const obj = coreObject(entry)
  if (!obj?.objectId || !isAccessGateType(obj.type, originalId, 'Gate')) return null
  const f = structFields(obj.json)
  if (!f) return null
  // Every scalar field, each read strictly: a missing or mistyped one is `null`.
  const gate = {
    gateId: idField(obj.objectId),
    priceMist: u64Field(f.price_mist),
    paymentRecipient: idField(f.payment_recipient),
    defaultUses: u64Field(f.default_uses),
    soulbound: boolField(f.soulbound),
    autoBurnAtZero: boolField(f.auto_burn_at_zero),
    paused: boolField(f.paused),
    frozen: boolField(f.frozen),
    nftName: stringField(f.nft_name),
    nftImageUrl: stringField(f.nft_image_url),
    nftDescription: stringField(f.nft_description),
    freeFeePaid: boolField(f.free_fee_paid),
  }
  // One null anywhere means the object is not a gate this client understands: return nothing, not a partly-filled gate.
  if (Object.values(gate).some((v) => v === null)) return null
  // The two structured fields. `lockedCommission` is legitimately null (no lock), so `undefined` is the malformed marker.
  const policy = parsePolicy(f.policy)
  const lockedCommission = parseOptionTerms(f.locked_commission)
  if (!policy || lockedCommission === undefined) return null
  // The cast removes `null` from the field types, which the check above has proved absent.
  return { ...(gate as { [K in keyof typeof gate]: NonNullable<(typeof gate)[K]> }), policy, lockedCommission }
}

/** Parse an on-chain `GatePolicy`; `null` if it is missing or a flag is not a bool. */
function parsePolicy(v: unknown): GatePolicy | null {
  const p = structFields(v)
  // The four restriction flags, in the order the Move struct declares them.
  const policy = {
    freezeRequiresUnpaused: boolField(p?.freeze_requires_unpaused),
    lockCommissionOnFreeze: boolField(p?.lock_commission_on_freeze),
    pauseBlocksDecryption: boolField(p?.pause_blocks_decryption),
    pauseBlocksAccess: boolField(p?.pause_blocks_access),
  }
  // A flag that is not a boolean makes the whole policy unreadable (a missing flag must not read as `false`).
  return Object.values(policy).some((b) => b === null) ? null : (policy as GatePolicy)
}

/**
 * Parse a Move `Option<CommissionTerms>` as rendered by gRPC (struct | null) or JSON-RPC
 * (`{ vec: [] | [struct] }`): the terms, `null` for none, or `undefined` if malformed.
 */
function parseOptionTerms(v: unknown): CommissionTerms | null | undefined {
  // `Option::none` renders as `null`; a missing key means the field was dropped or renamed, which is
  // malformed (never "no lock").
  if (v === null) return null
  if (v === undefined || typeof v !== 'object') return undefined
  // The JSON-RPC rendering of an Option is `{ vec: [] }` (none) or `{ vec: [value] }` (some).
  const vec = (v as { vec?: unknown }).vec
  if (Array.isArray(vec) && vec.length === 0) return null
  // Either the wrapped value or, in the gRPC shape, the struct itself.
  const t = structFields(Array.isArray(vec) ? vec[0] : v)
  const bps = u64Field(t?.bps)
  const minMist = u64Field(t?.min_mist)
  return bps === null || minMist === null ? undefined : { bps, minMist }
}

/** Parse a `PlatformConfig`, or `null` if it is not one or a field is missing or mistyped. */
export function parsePlatformConfig(entry: unknown, originalId: string): PlatformConfigInfo | null {
  const obj = coreObject(entry)
  if (!obj || !isAccessGateType(obj.type, originalId, 'PlatformConfig')) return null
  const f = structFields(obj.json)
  // The five fields, each read strictly.
  const treasury = idField(f?.treasury)
  const commissionBps = u64Field(f?.commission_bps)
  const minCommissionMist = u64Field(f?.min_commission_mist)
  const freeGateFeeMist = u64Field(f?.free_gate_fee_mist)
  const version = u64Field(f?.version)
  // All five must be present: a config with a missing field is refused, not defaulted (a zero commission would be silently wrong).
  if (!treasury || commissionBps === null || minCommissionMist === null || freeGateFeeMist === null || version === null) {
    return null
  }
  return { version, treasury, commissionBps, minCommissionMist, freeGateFeeMist }
}

/**
 * Every `{ adminCapId, gateId }` pair owned by `owner` (all pages).
 *
 * @throws {Error} if an RPC call fails.
 */
export async function fetchAdminCaps(
  client: OwnedObjectsClient,
  owner: string,
  originalId: string,
): Promise<{ adminCapId: string; gateId: string }[]> {
  // List by exact type so the node returns only this package's caps.
  const objects = await listAllOwnedObjects(client, owner, accessGateType(originalId, 'AdminCap'))
  // Objects that do not parse as a cap are dropped.
  return objects
    .map((o) => parseAdminCap(o, originalId))
    .filter((c): c is { adminCapId: string; gateId: string } => c !== null)
}

/**
 * Read one `Gate` by id. Returns `null` if the object is not a `Gate` of this package.
 *
 * @throws {Error} if the RPC call fails (including a missing object).
 */
export async function fetchGate(client: SuiObjectClient, gateId: string, originalId: string): Promise<GateState | null> {
  // `include.json` asks for the fields, which the parser reads.
  return parseGate(await client.core.getObject({ objectId: gateId, include: { json: true } }), originalId)
}

/**
 * Read the package's shared `PlatformConfig`: treasury, commission rate and floor, free-gate fee.
 *
 * @throws {Error} if the RPC call fails, or the object is not this package's `PlatformConfig`.
 */
export async function fetchPlatformConfig(
  client: SuiObjectClient,
  platformConfigId: string,
  originalId: string,
): Promise<PlatformConfigInfo> {
  const res = await client.core.getObject({ objectId: platformConfigId, include: { json: true } })
  const config = parsePlatformConfig(res, originalId)
  // Unlike a gate, a config that does not parse is an error: a caller cannot proceed without the platform's terms.
  if (!config) throw new Error(`${platformConfigId} is not an access_gate PlatformConfig of ${originalId}`)
  return config
}

/** How many `Gate` reads `fetchOwnedGates` keeps in flight. */
export const GATE_FETCH_CONCURRENCY = 10

/** `items.map(fn)` with at most `limit` calls in flight; results keep the input order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  // Results land at their input index, so the order is the input's whatever the completion order.
  const out = new Array<R>(items.length)
  // The next index to claim; JavaScript is single-threaded, so `next++` between awaits cannot hand one index to two workers.
  let next = 0
  // One worker: claim an index, run `fn` on it, repeat until none are left.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  // `limit` workers (fewer when there are fewer items) share the queue.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Every gate `owner` administers: their `AdminCap`s, each merged with its `Gate`. Caps whose gate
 * is not a `Gate` of this package are skipped.
 *
 * @throws {Error} if any RPC call fails.
 */
export async function fetchOwnedGates(
  client: OwnedObjectsClient & SuiObjectClient,
  owner: string,
  originalId: string,
): Promise<OwnedGate[]> {
  // First the caps the owner holds...
  const caps = await fetchAdminCaps(client, owner, originalId)
  // ...then, for each, the gate it controls. A bounded number of requests at a time: an operator with thousands of caps must not fire thousands of
  // concurrent reads at a public full node (rate limiting would reject the whole call).
  const gates = await mapBounded(caps, GATE_FETCH_CONCURRENCY, async ({ adminCapId, gateId }) => {
    const gate = await fetchGate(client, gateId, originalId)
    // A cap whose gate does not parse (deleted, another package) is skipped, not fatal.
    return gate ? { ...gate, adminCapId } : null
  })
  return gates.filter((g): g is OwnedGate => g !== null)
}

/**
 * True if `owner` holds this package's `PlatformAdminCap` (the authority over `PlatformConfig`).
 *
 * @throws {Error} if an RPC call fails.
 */
export async function ownsPlatformAdminCap(
  client: OwnedObjectsClient,
  owner: string,
  originalId: string,
): Promise<boolean> {
  // Both the early stop and the final answer use the exact-type test.
  const isCap = (o: unknown) => isAccessGateType(coreObject(o)?.type, originalId, 'PlatformAdminCap')
  const objects = await listAllOwnedObjects(client, owner, accessGateType(originalId, 'PlatformAdminCap'), isCap)
  return objects.some(isCap)
}
