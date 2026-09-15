import { describe, expect, it } from 'vitest'
import { inject } from '../src/client.js'

describe('client plugin dependencies', () => {
  it('waits for the slot registry it registers into', () => {
    expect(inject).toContain('slots')
  })

  it('declares no host-only service, which would stall activation', () => {
    // The poller reads the interval mixin opportunistically, so naming the
    // host's timer service here would only risk never activating at all.
    expect(inject).not.toContain('timer')
  })
})
