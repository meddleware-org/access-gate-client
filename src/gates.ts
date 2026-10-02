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
  if (!obj?.objectId || !isAccessGateType(obj.type, originalId, 'AdminCap')) return null
  const f = structFields(obj.json)
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
  if (Object.values(gate).some((v) => v === null)) return null
  const policy = parsePolicy(f.policy)
  const lockedCommission = parseOptionTerms(f.locked_commission)
  if (!policy || lockedCommission === undefined) return null
  return { ...(gate as { [K in keyof typeof gate]: NonNullable<(typeof gate)[K]> }), policy, lockedCommission }
}

/** Parse an on-chain `GatePolicy`; `null` if it is missing or a flag is not a bool. */
function parsePolicy(v: unknown): GatePolicy | null {
  const p = structFields(v)
  const policy = {
    freezeRequiresUnpaused: boolField(p?.freeze_requires_unpaused),
    lockCommissionOnFreeze: boolField(p?.lock_commission_on_freeze),
    pauseBlocksDecryption: boolField(p?.pause_blocks_decryption),
    pauseBlocksAccess: boolField(p?.pause_blocks_access),
  }
  return Object.values(policy).some((b) => b === null) ? null : (policy as GatePolicy)
}

/**
 * Parse a Move `Option<CommissionTerms>` as rendered by gRPC (struct | null) or JSON-RPC
 * (`{ vec: [] | [struct] }`): the terms, `null` for none, or `undefined` if malformed.
 */
function parseOptionTerms(v: unknown): CommissionTerms | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') return undefined
  const vec = (v as { vec?: unknown }).vec
  if (Array.isArray(vec) && vec.length === 0) return null
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
  const treasury = idField(f?.treasury)
  const commissionBps = u64Field(f?.commission_bps)
  const minCommissionMist = u64Field(f?.min_commission_mist)
  const freeGateFeeMist = u64Field(f?.free_gate_fee_mist)
  const version = u64Field(f?.version)
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
  const objects = await listAllOwnedObjects(client, owner, accessGateType(originalId, 'AdminCap'))
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
  if (!config) throw new Error(`${platformConfigId} is not an access_gate PlatformConfig of ${originalId}`)
  return config
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
  const caps = await fetchAdminCaps(client, owner, originalId)
  const gates = await Promise.all(
    caps.map(async ({ adminCapId, gateId }) => {
      const gate = await fetchGate(client, gateId, originalId)
      return gate ? { ...gate, adminCapId } : null
    }),
  )
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
  const isCap = (o: unknown) => isAccessGateType(coreObject(o)?.type, originalId, 'PlatformAdminCap')
  const objects = await listAllOwnedObjects(client, owner, accessGateType(originalId, 'PlatformAdminCap'), isCap)
  return objects.some(isCap)
}
