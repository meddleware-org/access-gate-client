/**
 * Tests for the ABI table (`tests/abi-table.ts`): the table is complete (every exported builder, every Move function the builders call) and each
 * builder's arguments have the arity and the pure/object kind the contract's parameters need. This is the offline half of the drift check; the live half
 * (`tests/integration/abi-drift.integration.test.ts`) compares the same table with the deployed package.
 */
import { describe, it, expect } from 'vitest'
import { BUILDERS, EXPECTED_PARAMS, allMoveCalls, argumentKinds, exportedBuilders, isPureParam, PKG } from './abi-table.js'

describe('ABI table (feeds the testnet drift check)', () => {
  // A new `build…Tx` export with no entry here would be untested against the ABI: fail until it is added.
  it('covers every exported transaction builder', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(exportedBuilders)
  })

  it('every builder calls access_gate at the given package', () => {
    const calls = allMoveCalls()
    // At least one call per builder (some build two variants, some two calls).
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(BUILDERS).length)
    for (const c of calls) expect([c.package, c.module]).toEqual([PKG, 'access_gate'])
  })

  it('has an expected parameter list for exactly the functions the builders call', () => {
    // Both directions: a function called but not in the table, and a table row nothing calls, are failures.
    const called = new Set(allMoveCalls().map((c) => `${c.module}::${c.function}`))
    expect([...called].sort()).toEqual(Object.keys(EXPECTED_PARAMS).sort())
  })

  it('builds each call with the arity and the pure/object kind the expected parameters need', () => {
    for (const build of Object.values(BUILDERS)) {
      for (const tx of build()) {
        // Per call: same number of arguments as parameters, and each is pure or an object as the parameter type demands.
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
