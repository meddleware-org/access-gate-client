import { describe, it, expect } from 'vitest'
import { ACCESS_GATE_ABORTS, abortMessage } from '../src/aborts.js'

const PKG = '0x1a81ca177db039585e575beeeee4759466e55910e936a6733e38dbb65025eea4'

describe('ACCESS_GATE_ABORTS', () => {
  it('covers codes 1–14 with their Move constant names', () => {
    expect(Object.keys(ACCESS_GATE_ABORTS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(ACCESS_GATE_ABORTS[5].name).toBe('E_WRONG_GATE')
    expect(ACCESS_GATE_ABORTS[12].name).toBe('E_FREE_FEE_UNPAID')
    expect(ACCESS_GATE_ABORTS[13].name).toBe('E_WRONG_VERSION')
    expect(ACCESS_GATE_ABORTS[14].name).toBe('E_NOT_UPGRADE')
  })
})

describe('abortMessage', () => {
  it('reads an SDK ExecutionError', () => {
    const err = { $kind: 'MoveAbort', message: '…', MoveAbort: { abortCode: '1', location: { package: PKG, module: 'access_gate' } } }
    expect(abortMessage(err, PKG)).toBe(ACCESS_GATE_ABORTS[1].message)
  })

  it('reads a SimulationError and a failed transaction status', () => {
    const sim = Object.assign(new Error('sim failed'), {
      executionError: { MoveAbort: { abortCode: '11', location: { package: PKG, module: 'access_gate' } } },
    })
    expect(abortMessage(sim)).toBe(ACCESS_GATE_ABORTS[11].message)
    const status = { success: false, error: { MoveAbort: { abortCode: '4', location: { package: PKG, module: 'access_gate' } } } }
    expect(abortMessage(status)).toBe(ACCESS_GATE_ABORTS[4].message)
  })

  it('reads the SDK message format', () => {
    const msg = `MoveAbort in 2nd command, abort code: 5, in '${PKG}::access_gate::consume' (instruction 12)`
    expect(abortMessage(new Error(msg), PKG)).toBe(ACCESS_GATE_ABORTS[5].message)
  })

  it('reads the node/wallet message format', () => {
    const msg = `MoveAbort(MoveLocation { module: ModuleId { address: ${PKG.slice(2)}, name: Identifier("access_gate") }, function: 5, instruction: 21, function_name: Some("purchase") }, 2) in command 1`
    expect(abortMessage(msg, PKG)).toBe(ACCESS_GATE_ABORTS[2].message)
  })

  it('ignores aborts from other modules or packages, and errors without an abort', () => {
    expect(abortMessage({ MoveAbort: { abortCode: '1', location: { package: PKG, module: 'seal_policies' } } })).toBeNull()
    expect(abortMessage({ MoveAbort: { abortCode: '1', location: { package: '0x2', module: 'access_gate' } } }, PKG)).toBeNull()
    expect(abortMessage({ MoveAbort: { abortCode: '1' } })).toBeNull()
    expect(abortMessage(new Error('network down'))).toBeNull()
    expect(abortMessage(undefined)).toBeNull()
  })

  it('returns null for an unknown code', () => {
    expect(abortMessage({ MoveAbort: { abortCode: '99', location: { package: PKG, module: 'access_gate' } } })).toBeNull()
  })
})
