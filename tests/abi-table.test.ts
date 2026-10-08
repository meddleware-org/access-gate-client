import { describe, it, expect } from 'vitest'
import { BUILDERS, EXPECTED_PARAMS, allMoveCalls, argumentKinds, exportedBuilders, isPureParam, PKG } from './abi-table.js'

describe('ABI table (feeds the testnet drift check)', () => {
  it('covers every exported transaction builder', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(exportedBuilders)
  })

  it('every builder calls access_gate at the given package', () => {
    const calls = allMoveCalls()
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(BUILDERS).length)
    for (const c of calls) expect([c.package, c.module]).toEqual([PKG, 'access_gate'])
  })

  it('has an expected parameter list for exactly the functions the builders call', () => {
    const called = new Set(allMoveCalls().map((c) => `${c.module}::${c.function}`))
    expect([...called].sort()).toEqual(Object.keys(EXPECTED_PARAMS).sort())
  })

  it('builds each call with the arity and the pure/object kind the expected parameters need', () => {
    for (const build of Object.values(BUILDERS)) {
      for (const tx of build()) {
        for (const { call, kinds } of argumentKinds(tx)) {
          const expected = EXPECTED_PARAMS[call]!
          expect(expected, call).toBeDefined()
          expect(kinds.length, `${call} arity`).toBe(expected.length)
          expected.forEach((param, i) => {
            expect(kinds[i], `${call} argument ${i} (${param})`).toBe(isPureParam(param) ? 'pure' : 'object')
          })
        }
      }
    }
  })
})
