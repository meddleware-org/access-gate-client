import { describe, it, expect } from 'vitest'
import { BUILDERS, allMoveCalls, exportedBuilders, PKG } from './abi-table.js'

describe('ABI table (feeds the testnet drift check)', () => {
  it('covers every exported transaction builder', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(exportedBuilders)
  })

  it('every builder calls access_gate at the given package', () => {
    const calls = allMoveCalls()
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(BUILDERS).length)
    for (const c of calls) expect([c.package, c.module]).toEqual([PKG, 'access_gate'])
  })
})
