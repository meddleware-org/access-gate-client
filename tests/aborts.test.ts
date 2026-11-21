/**
 * Tests for the abort table and the abort finder (`src/aborts.ts`): the table mirrors the Move source's `E_*` constants (so a renumbered or new constant
 * fails here at the version bump), every shape a wallet or node reports an abort in is found, and an abort from any other package or module is never
 * claimed as ours.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ACCESS_GATE_ABORTS, abortMessage } from '../src/aborts.js'

// The package id the fixtures place their aborts in (any 32-byte value would do; this one is a real testnet id).
const PKG = '0x1a81ca177db039585e575beeeee4759466e55910e936a6733e38dbb65025eea4'

describe('ACCESS_GATE_ABORTS', () => {
  it('covers codes 1–16 with their Move constant names', () => {
    expect(Object.keys(ACCESS_GATE_ABORTS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(ACCESS_GATE_ABORTS[5]!.name).toBe('E_WRONG_GATE')
    expect(ACCESS_GATE_ABORTS[12]!.name).toBe('E_FREE_FEE_UNPAID')
    expect(ACCESS_GATE_ABORTS[13]!.name).toBe('E_WRONG_VERSION')
    expect(ACCESS_GATE_ABORTS[14]!.name).toBe('E_NOT_UPGRADE')
    expect(ACCESS_GATE_ABORTS[15]!.name).toBe('E_POLICY_COMBINATION')
    expect(ACCESS_GATE_ABORTS[16]!.name).toBe('E_USES_KIND_IMMUTABLE')
  })

  it('gives every code a non-empty user-facing message', () => {
    for (const [code, abort] of Object.entries(ACCESS_GATE_ABORTS)) {
      expect(abort.message.length, `code ${code}`).toBeGreaterThan(10)
    }
  })

  // Drift: the table must equal the `E_*` constants of the Move source the deployed package was published
  // from. The source ships in the exactly-pinned devDependency `@meddleware/access-gate-sui`, which the
  // deployment ids are generated from, so a new or renumbered constant fails here at the version bump.
  it('mirrors every E_* constant of the published Move source, name and code', () => {
    // Find the pinned Move package the way Node would, then read its source file.
    const pkgJson = createRequire(import.meta.url).resolve('@meddleware/access-gate-sui/package.json')
    const source = readFileSync(join(dirname(pkgJson), 'sources', 'access_gate.move'), 'utf8')
    // `const E_NAME: u64 = N;` lines of the Move source.
    const fromMove = new Map<number, string>()
    for (const m of source.matchAll(/^const (E_[A-Z0-9_]+): u64 = (\d+);/gm)) fromMove.set(Number(m[2]), m[1]!)
    // Guard against a regex that matches nothing (which would make the comparison below vacuous).
    expect(fromMove.size).toBeGreaterThan(0)
    const fromTable = new Map(Object.entries(ACCESS_GATE_ABORTS).map(([code, a]) => [Number(code), a.name]))
    expect(fromTable).toEqual(fromMove)
  })
})

describe('abortMessage', () => {
  // The SDK's structured error: the abort sits under `MoveAbort`.
  it('reads an SDK ExecutionError', () => {
    const err = { $kind: 'MoveAbort', message: '…', MoveAbort: { abortCode: '1', location: { package: PKG, module: 'access_gate' } } }
    expect(abortMessage(err, PKG)).toBe(ACCESS_GATE_ABORTS[1]!.message)
  })

  it('reads a SimulationError and a failed transaction status', () => {
    // A simulation error is an `Error` with the abort under `executionError`.
    const sim = Object.assign(new Error('sim failed'), {
      executionError: { MoveAbort: { abortCode: '11', location: { package: PKG, module: 'access_gate' } } },
    })
    expect(abortMessage(sim, PKG)).toBe(ACCESS_GATE_ABORTS[11]!.message)
    const status = { success: false, error: { MoveAbort: { abortCode: '4', location: { package: PKG, module: 'access_gate' } } } }
    expect(abortMessage(status, PKG)).toBe(ACCESS_GATE_ABORTS[4]!.message)
  })

  // Text shapes: an error with only a message, as a wallet may relay it.
  it('reads the SDK message format', () => {
    const msg = `MoveAbort in 2nd command, abort code: 5, in '${PKG}::access_gate::consume' (instruction 12)`
    expect(abortMessage(new Error(msg), PKG)).toBe(ACCESS_GATE_ABORTS[5]!.message)
  })

  it('reads the node/wallet message format', () => {
    const msg = `MoveAbort(MoveLocation { module: ModuleId { address: ${PKG.slice(2)}, name: Identifier("access_gate") }, function: 5, instruction: 21, function_name: Some("purchase") }, 2) in command 1`
    expect(abortMessage(msg, PKG)).toBe(ACCESS_GATE_ABORTS[2]!.message)
  })

  it('ignores aborts from other modules or packages, and errors without an abort', () => {
    // Another module of this package, another package's `access_gate`, an abort with no location, a plain error and nothing at all.
    expect(abortMessage({ MoveAbort: { abortCode: '1', location: { package: PKG, module: 'sealed_storage' } } }, PKG)).toBeNull()
    expect(abortMessage({ MoveAbort: { abortCode: '1', location: { package: '0x2', module: 'access_gate' } } }, PKG)).toBeNull()
    expect(abortMessage({ MoveAbort: { abortCode: '1' } }, PKG)).toBeNull()
    expect(abortMessage(new Error('network down'), PKG)).toBeNull()
    expect(abortMessage(undefined, PKG)).toBeNull()
  })

  it('gives the new 2026-10-09 package codes their messages', () => {
    const at = (code: string) => ({ MoveAbort: { abortCode: code, location: { package: PKG, module: 'access_gate' } } })
    expect(abortMessage(at('15'), PKG)).toBe(ACCESS_GATE_ABORTS[15]!.message)
    expect(abortMessage(at('16'), PKG)).toBe(ACCESS_GATE_ABORTS[16]!.message)
  })

  it('returns null for an unknown code', () => {
    expect(abortMessage({ MoveAbort: { abortCode: '99', location: { package: PKG, module: 'access_gate' } } }, PKG)).toBeNull()
  })

  it('does not claim a look-alike or superseded package\'s access_gate abort', () => {
    // Code 13 means something else in a superseded package, so claiming it would show the wrong message.
    const other = '0x' + 'bb'.repeat(32)
    expect(abortMessage({ MoveAbort: { abortCode: '13', location: { package: other, module: 'access_gate' } } }, PKG)).toBeNull()
  })

  it('survives a cyclic error chain', () => {
    // Two objects that wrap each other: the depth limit must stop the walk.
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { error: a }
    a.error = b
    expect(abortMessage(a, PKG)).toBeNull()
  })

  it('still finds an abort wrapped a few levels deep', () => {
    const inner = { MoveAbort: { abortCode: '2', location: { package: PKG, module: 'access_gate' } } }
    expect(abortMessage({ error: { error: { error: inner } } }, PKG)).toBe(ACCESS_GATE_ABORTS[2]!.message)
  })
})
