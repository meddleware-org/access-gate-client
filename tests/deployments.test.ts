import { describe, it, expect } from 'vitest'
import { ACCESS_GATE_DEPLOYMENTS, accessGateDeployment } from '../src/deployments.js'
import { accessGateType, accessNftType, isAccessGateType, normalizeAccessNftType } from '../src/typeNames.js'

describe('deployments', () => {
  it('records testnet with full-length ids', () => {
    const t = accessGateDeployment('testnet')
    for (const id of [t.originalId, t.publishedAt, t.platformConfigId]) expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(ACCESS_GATE_DEPLOYMENTS.testnet).toBe(t)
  })

  it('throws for a network without a deployment', () => {
    expect(() => accessGateDeployment('mainnet-typo')).toThrow(/no access_gate deployment recorded/)
  })
})

describe('type names', () => {
  const { originalId } = accessGateDeployment('testnet')

  it('builds normalised types at the original id', () => {
    expect(accessGateType('0x2', 'Gate')).toBe(`0x${'0'.repeat(63)}2::access_gate::Gate`)
    expect(accessNftType(originalId, true)).toBe(`${originalId}::access_gate::SoulboundAccessNFT`)
    expect(accessNftType(originalId, false)).toBe(`${originalId}::access_gate::AccessNFT`)
  })

  it('matches exactly, never by suffix', () => {
    expect(isAccessGateType(`${originalId}::access_gate::Gate`, originalId, 'Gate')).toBe(true)
    expect(isAccessGateType(`0xdead::access_gate::Gate`, originalId, 'Gate')).toBe(false)
    expect(isAccessGateType(`${originalId}::access_gate::GateX`, originalId, 'Gate')).toBe(false)
    expect(isAccessGateType(undefined, originalId, 'Gate')).toBe(false)
    expect(isAccessGateType('not a type', originalId, 'Gate')).toBe(false)
  })

  it('validates NFT types', () => {
    expect(normalizeAccessNftType('0x2::access_gate::AccessNFT')).toBe(`0x${'0'.repeat(63)}2::access_gate::AccessNFT`)
    expect(() => normalizeAccessNftType('0x2::access_gate::AdminCap')).toThrow()
    expect(() => normalizeAccessNftType('0x2::other::AccessNFT')).toThrow()
  })
})
