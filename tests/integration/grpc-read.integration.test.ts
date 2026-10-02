// Live read-path checks against a real Sui gRPC full node (default: public testnet), using the
// recorded testnet deployment. Gated by GRPC_TESTNET so the offline `npm test` skips it:
//
//   GRPC_TESTNET=1 npm run test:integration
//
// Optional env:
//   ACCESS_GATE_TESTNET_GATE_ID — a Gate object id → validates fetchGate
//   ACCESS_GATE_TESTNET_OWNER   — an address holding AdminCaps → validates fetchOwnedGates
import { describe, it, expect } from 'vitest'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { accessGateDeployment } from '../../src/deployments.js'
import { fetchGate, fetchOwnedGates, fetchPlatformConfig, ownsPlatformAdminCap } from '../../src/gates.js'
import { listAccessGateEvents } from '../../src/events.js'
import type { EventsClient, OwnedObjectsClient, SuiObjectClient } from '../../src/types.js'

const RUN = !!process.env.GRPC_TESTNET
const BASE_URL = process.env.GRPC_TESTNET_URL || 'https://fullnode.testnet.sui.io:443'
const { originalId, platformConfigId } = accessGateDeployment('testnet')

describe.skipIf(!RUN)('gRPC read path (real testnet full node)', () => {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: BASE_URL })
  const any = client as unknown as OwnedObjectsClient & SuiObjectClient & EventsClient

  it('fetchPlatformConfig reads the recorded PlatformConfig', async () => {
    const config = await fetchPlatformConfig(any, platformConfigId, originalId)
    expect(config.treasury).toMatch(/^0x[0-9a-f]{64}$/)
    expect(config.commissionBps).toBeLessThanOrEqual(1000n)
    expect(config.minCommissionMist).toBeGreaterThan(0n)
  })

  it('lists and decodes access_gate events across the module filter, newest first', async () => {
    const page = await listAccessGateEvents(any, { originalId, limit: 20 })
    expect(page.source).toBe('rpc')
    expect(page.events.length).toBeGreaterThan(0)
    const checkpoints = page.events.map((e) => BigInt(e.checkpoint ?? '0'))
    for (let i = 1; i < checkpoints.length; i++) expect(checkpoints[i]).toBeLessThanOrEqual(checkpoints[i - 1]!)
    for (const e of page.events) expect(e.txDigest).toBeTruthy()
  })

  it('decodes consume events with a consumer address', async () => {
    const page = await listAccessGateEvents(any, { originalId, kinds: ['AccessConsumed'], limit: 5 })
    for (const e of page.events) {
      if (e.kind !== 'AccessConsumed') throw new Error(`unexpected ${e.kind}`)
      expect(e.consumer).toMatch(/^0x[0-9a-f]{64}$/)
      expect(e.nonce.length).toBeGreaterThanOrEqual(8)
    }
  })

  it('the recorded PlatformConfig is version-gated at version 1', async () => {
    const { version } = await fetchPlatformConfig(any, platformConfigId, originalId)
    expect(version).toBe(1n)
  })

  it('the platform treasury does or does not hold the PlatformAdminCap (well-formed answer)', async () => {
    const { treasury } = await fetchPlatformConfig(any, platformConfigId, originalId)
    expect(typeof (await ownsPlatformAdminCap(any, treasury, originalId))).toBe('boolean')
  })

  it.skipIf(!process.env.ACCESS_GATE_TESTNET_GATE_ID)('fetchGate parses a real Gate', async () => {
    const gate = await fetchGate(any, process.env.ACCESS_GATE_TESTNET_GATE_ID!, originalId)
    expect(gate).not.toBeNull()
    expect(typeof gate!.priceMist).toBe('bigint')
  })

  it.skipIf(!process.env.ACCESS_GATE_TESTNET_OWNER)("fetchOwnedGates lists an operator's gates", async () => {
    const gates = await fetchOwnedGates(any, process.env.ACCESS_GATE_TESTNET_OWNER!, originalId)
    for (const g of gates) expect(g.adminCapId).toMatch(/^0x[0-9a-f]+$/)
  })
})
