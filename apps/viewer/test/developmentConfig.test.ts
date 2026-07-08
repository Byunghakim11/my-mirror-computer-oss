import { afterEach, describe, expect, it } from 'vitest'

import {
  preserveDevelopmentConfig,
  readDevelopmentConfig,
} from '../src/developmentConfig'

const config = {
  deviceId: 'device_test_1234567890',
  sessionId: 'session_test_1234567890',
  ticket: 'test-only-not-a-real-ticket',
  webSocketUrl: 'ws://127.0.0.1:8787/ws',
}

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('development connection bootstrap', () => {
  it('removes credentials from the URL and restores them after reload', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('deviceId', config.deviceId)
    url.searchParams.set('sessionId', config.sessionId)
    url.searchParams.set('ticket', config.ticket)
    url.searchParams.set('ws', config.webSocketUrl)
    window.history.replaceState({}, '', url)

    const initial = readDevelopmentConfig()
    expect(initial).toEqual(config)

    preserveDevelopmentConfig(initial!)
    expect(window.location.search).toBe('')
    expect(readDevelopmentConfig()).toEqual(config)
  })

  it('rejects a non-local signaling address from history state', () => {
    window.history.replaceState(
      {
        mirrorDevelopmentConnection: {
          ...config,
          webSocketUrl: 'wss://example.invalid/ws',
        },
      },
      '',
      '/',
    )

    expect(readDevelopmentConfig()).toBeNull()
  })
})
