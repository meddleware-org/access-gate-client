import type {
  CommissionTerms,
  GatePolicy,
  OwnedGate,
  OwnedObjectsClient,
  PlatformConfigInfo,
  SuiObjectClient,
} from './types.js'
import { accessGateType, isAccessGateType } from './typeNames.js'
import { coreObject, listAllOwnedObjects, structFields } from './ownership.js'

// An operator holds an `AdminCap` per gate they administer. Discovery: list owned AdminCaps, read
// each cap's `gate_id`, then fetch the shared `Gate`. Every parser checks the object's exact type
// under the package's original id.

/** A gate's state as read from its `Gate` object (without the owning `AdminCap`). */
export type GateState = Omit<OwnedGate, 'adminCapId'>

/** Parse an `AdminCap` into `{ adminCapId, gateId }`, or `null` if it is not one. */
export function parseAdminCap(entry: unknown, originalId: string): { adminCapId: string; gateId: string } | null {
  const obj = coreObject(entry)
  if (!obj?.objectId || !isAccessGateType(obj.type, originalId, 'AdminCap')) return null
  const f = structFields(obj.json)
  const gateId: string | undefined = f?.gate_id ?? f?.gateId
  return gateId ? { adminCapId: obj.objectId, gateId } : null
}

/** Parse a `Gate` shared object, or `null` if it is not one. */
export function parseGate(entry: unknown, originalId: string): GateState | null {
  const obj = coreObject(entry)
  if (!obj?.objectId || !isAccessGateType(obj.type, originalId, 'Gate')) return null
  const f = structFields(obj.json)
  if (!f) return null
  return {
    gateId: obj.objectId,
    priceMist: BigInt(f.price_mist ?? 0),
    paymentRecipient: String(f.payment_recipient ?? ''),
    defaultUses: BigInt(f.default_uses ?? 0),
    soulbound: Boolean(f.soulbound),
    autoBurnAtZero: Boolean(f.auto_burn_at_zero),
    paused: Boolean(f.paused),
    frozen: Boolean(f.frozen),
    nftName: String(f.nft_name ?? ''),
    nftImageUrl: String(f.nft_image_url ?? ''),
    nftDescription: String(f.nft_description ?? ''),
    policy: parsePolicy(f.policy),
    lockedCommission: parseOptionTerms(f.locked_commission),
    freeFeePaid: Boolean(f.free_fee_paid),
  }
}

/** Parse an on-chain `GatePolicy` (absent on package versions that predate policies → all false). */
function parsePolicy(v: unknown): GatePolicy {
  const p = structFields(v)
  return {
    freezeRequiresUnpaused: Boolean(p?.freeze_requires_unpaused),
    lockCommissionOnFreeze: Boolean(p?.lock_commission_on_freeze),
    pauseBlocksDecryption: Boolean(p?.pause_blocks_decryption),
    pauseBlocksAccess: Boolean(p?.pause_blocks_access),
  }
}

/**
 * Parse a Move `Option<CommissionTerms>` as rendered by gRPC (struct | null) or JSON-RPC
 * (`{ vec: [struct] }`).
 */
function parseOptionTerms(v: unknown): CommissionTerms | null {
  if (v === null || v === undefined || typeof v !== 'object') return null
  const vec = (v as { vec?: unknown[] }).vec
  const inner = Array.isArray(vec) ? vec[0] : v
  const t = structFields(inner)
  if (!t || t.bps === undefined || t.min_mist === undefined) return null
  return { bps: BigInt(t.bps as string), minMist: BigInt(t.min_mist as string) }
}

/** Parse a `PlatformConfig`, or `null` if it is not one or is malformed. */
export function parsePlatformConfig(entry: unknown, originalId: string): PlatformConfigInfo | null {
  const obj = coreObject(entry)
  if (!obj || !isAccessGateType(obj.type, originalId, 'PlatformConfig')) return null
  const f = structFields(obj.json)
  if (
    !f ||
    f.treasury === undefined ||
    f.commission_bps === undefined ||
    f.min_commission_mist === undefined ||
    f.free_gate_fee_mist === undefined
  ) {
    return null
  }
  return {
    version: f.version === undefined ? null : BigInt(f.version as string),
    treasury: String(f.treasury),
    commissionBps: BigInt(f.commission_bps as string),
    minCommissionMist: BigInt(f.min_commission_mist as string),
    freeGateFeeMist: BigInt(f.free_gate_fee_mist as string),
  }
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
