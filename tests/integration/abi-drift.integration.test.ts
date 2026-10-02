// ABI drift: every Move call the builders make must still exist on the recorded testnet package,
// with the same visibility, type-parameter count and parameter count (a trailing TxContext is
// injected by the runtime and not counted). The recorded publishedAt must be the latest version.
//
//   GRPC_TESTNET=1 npm run test:integration
import { describe, it, expect } from 'vitest'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { normalizeStructTag } from '@mysten/sui/utils'
import { accessGateDeployment } from '../../src/deployments.js'
import { allMoveCalls, PKG } from '../abi-table.js'

const RUN = !!process.env.GRPC_TESTNET
const BASE_URL = process.env.GRPC_TESTNET_URL || 'https://fullnode.testnet.sui.io:443'
const { originalId, publishedAt } = accessGateDeployment('testnet')

const TX_CONTEXT = normalizeStructTag('0x2::tx_context::TxContext')
const isTxContext = (p: { body: { $kind: string; datatype?: { typeName: string } } }) =>
  p.body.$kind === 'datatype' && !!p.body.datatype && normalizeStructTag(p.body.datatype.typeName) === TX_CONTEXT

describe.skipIf(!RUN)('ABI drift (real testnet package)', () => {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: BASE_URL })

  it('recorded publishedAt is the latest package version', async () => {
    const versions: { packageId: string; version: bigint }[] = []
    let pageToken: Uint8Array | undefined
    do {
      const { response } = await client.movePackageService.listPackageVersions({ packageId: originalId, pageToken })
      versions.push(...response.versions.map((v) => ({ packageId: v.packageId ?? '', version: BigInt(v.version ?? 0) })))
      pageToken = response.nextPageToken
    } while (pageToken && pageToken.length > 0)
    expect(versions.length).toBeGreaterThan(0)
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a))
    expect(latest.packageId).toBe(publishedAt)
  })

  for (const call of allMoveCalls()) {
    it(`${call.module}::${call.function} matches the on-chain signature`, async () => {
      const { function: fn } = await client.core.getMoveFunction({
        packageId: call.package === PKG ? publishedAt : call.package,
        moduleName: call.module,
        name: call.function,
      })
      expect(fn.visibility === 'public' || fn.isEntry).toBe(true)
      expect(fn.typeParameters.length).toBe(call.typeArguments)
      const params = fn.parameters.filter((p, i) => !(i === fn.parameters.length - 1 && isTxContext(p)))
      expect(params.length).toBe(call.arguments)
    })
  }
})
