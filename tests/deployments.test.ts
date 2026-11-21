/**
 * Tests for the recorded deployments (`src/deployments.ts`) and the type-name helpers (`src/typeNames.ts`): ids are full length, prototype names are not
 * networks, and type matching is exact (normalised, never by suffix), because a look-alike package's type must never be taken for ours.
 */
import { describe, it, expect } from 'vitest'
import { ACCESS_GATE_DEPLOYMENTS, accessGateDeployment } from '../src/deployments.js'
import { accessGateType, accessNftType, isAccessGateType, normalizeAccessNftType } from '../src/typeNames.js'

describe('deployments', () => {
  it('records testnet with full-length ids', () => {
    const t = accessGateDeployment('testnet')
    for (const id of [t.originalId, t.publishedAt, t.platformConfigId]) expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(ACCESS_GATE_DEPLOYMENTS.testnet).toBe(t)
  })

  // `Object.hasOwn` in the lookup is what makes these throw; a plain `[network]` would return a function.
  it('does not resolve Object prototype members as networks', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => accessGateDeployment(name)).toThrow(/no access_gate deployment recorded/)
    }
  })

  it('throws for a network without a deployment', () => {
    expect(() => accessGateDeployment('mainnet-typo')).toThrow(/no access_gate deployment recorded/)
  })
})

describe('type names', () => {
  const { originalId } = accessGateDeployment('testnet')

  it('builds normalised types at the original id', () => {
    // A short address is padded to 64 digits.
    expect(accessGateType('0x2', 'Gate')).toBe(`0x${'0'.repeat(63)}2::access_gate::Gate`)
    expect(accessNftType(originalId, true)).toBe(`${originalId}::access_gate::SoulboundAccessNFT`)
    expect(accessNftType(originalId, false)).toBe(`${originalId}::access_gate::AccessNFT`)
  })

  it('matches exactly, never by suffix', () => {
    expect(isAccessGateType(`${originalId}::access_gate::Gate`, originalId, 'Gate')).toBe(true)
    // Another package, a longer name, a non-string and garbage are all refused.
    expect(isAccessGateType(`0xdead::access_gate::Gate`, originalId, 'Gate')).toBe(false)
    expect(isAccessGateType(`${originalId}::access_gate::GateX`, originalId, 'Gate')).toBe(false)
    expect(isAccessGateType(undefined, originalId, 'Gate')).toBe(false)
    expect(isAccessGateType('not a type', originalId, 'Gate')).toBe(false)
  })

  it('validates NFT types', () => {
    expect(normalizeAccessNftType('0x2::access_gate::AccessNFT')).toBe(`0x${'0'.repeat(63)}2::access_gate::AccessNFT`)
    // The wrong struct, or the right struct in the wrong module, is not an NFT type.
    expect(() => normalizeAccessNftType('0x2::access_gate::AdminCap')).toThrow()
    expect(() => normalizeAccessNftType('0x2::other::AccessNFT')).toThrow()
  })
})
