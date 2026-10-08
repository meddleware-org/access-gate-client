// Struct-shape drift: every access_gate struct the parsers decode or read must still have exactly the
// recorded fields (name, order, Move type) on the testnet package, and one real event of each kind that
// exists on chain must decode strictly (no trailing bytes, no layout difference).
//
//   GRPC_TESTNET=1 npm run test:integration
import { describe, it, expect } from 'vitest'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { accessGateDeployment } from '../../src/deployments.js'
import { ACCESS_GATE_EVENT_KINDS, accessGateEventType, parseAccessGateEvent } from '../../src/events.js'
import { fieldType } from '../chain-shape.js'
import { STRUCT_SCHEMAS } from '../schema.js'

const RUN = !!process.env.GRPC_TESTNET
const BASE_URL = process.env.GRPC_TESTNET_URL || 'https://fullnode.testnet.sui.io:443'
const { originalId } = accessGateDeployment('testnet')

describe.skipIf(!RUN)('struct shapes (real testnet package)', () => {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: BASE_URL })

  for (const [name, fields] of Object.entries(STRUCT_SCHEMAS)) {
    it(`${name} has the recorded fields`, async () => {
      const { response } = await client.movePackageService.getDatatype({ packageId: originalId, moduleName: 'access_gate', name })
      const live = (response.datatype?.fields ?? []).map((f) => [f.name ?? '', fieldType(f.type as never, originalId)])
      expect(live).toEqual(fields)
    })
  }

  for (const kind of ACCESS_GATE_EVENT_KINDS) {
    it(`a real ${kind} event decodes strictly (skipped when none exists on chain yet)`, async () => {
      const res = await client.core.listEvents({ filter: { eventType: accessGateEventType(originalId, kind) }, limit: 5, order: 'descending' })
      for (const entry of res.events) expect(parseAccessGateEvent(entry as never, originalId)?.kind).toBe(kind)
    })
  }
})
