import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: {
    canConnect: true,
    canRetry: false,
    clipboardEntries: [] as { id: number; receivedAt: number; text: string }[],
    dismissClipboardEntry: vi.fn(),
    downloadableFiles: [] as { name: string; size: number }[],
    requestFileList: vi.fn(),
    downloadFile: vi.fn(),
    fileDownload: null as { fileName: string; status: string } | null,
    clearFileDownload: vi.fn(),
    connect: vi.fn(),
    connectionState: 'offline' as const,
    controlGranted: false,
    controlLocked: false,
    controlPolicyEnabled: false,
    deviceId: 'device_test',
    disconnect: vi.fn(),
    errorAction: null as string | null,
    errorMessage: null as string | null,
    isControlActive: false,
    mediaStream: null as MediaStream | null,
    releaseRemoteInput: vi.fn(),
    roundTripTimeMs: null,
    sendFile: vi.fn(),
    sendKey: vi.fn(),
    sendPointerButton: vi.fn(),
    sendPointerMove: vi.fn(),
    sendPointerWheel: vi.fn(),
    sendText: vi.fn(),
    setVideoProfile: vi.fn(),
    videoProfile: 'balanced' as const,
    videoProfileError: null as string | null,
    videoProfilePending: false,
  },
}))

vi.mock('../src/useRemoteSession', () => ({
  useRemoteSession: () => mocks.session,
}))

import { App } from '../src/App'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.session.errorAction = null
  mocks.session.errorMessage = null
  mocks.session.canRetry = false
  mocks.session.isControlActive = false
  mocks.session.mediaStream = null
  mocks.session.videoProfilePending = false
  mocks.session.videoProfileError = null
})

describe('App viewer controls', () => {
  it('shows actionable retry UX for a retryable failure', () => {
    mocks.session.errorMessage = '연결 서버에 도달할 수 없습니다.'
    mocks.session.errorAction = '네트워크를 확인하세요.'
    mocks.session.canRetry = true

    render(<App />)

    expect(screen.getByRole('alert').textContent).toContain('네트워크를 확인하세요.')
    fireEvent.click(screen.getByTestId('connect-button'))
    expect(screen.getByTestId('connect-button').textContent).toContain('다시 연결')
    expect(mocks.session.connect).toHaveBeenCalledOnce()
  })

  it('disables retry when the server marks the issue non-retryable', () => {
    mocks.session.errorMessage = '연결 권한이 만료되었습니다.'
    mocks.session.errorAction = '페이지를 새로 여세요.'
    mocks.session.canRetry = false

    render(<App />)

    expect((screen.getByTestId('connect-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('requests a live quality change from the toolbar', () => {
    render(<App />)

    fireEvent.change(screen.getByTestId('video-profile-select'), {
      target: { value: 'low' },
    })

    expect(mocks.session.setVideoProfile).toHaveBeenCalledWith('low')
  })

  it('shows a non-fatal quality timeout beside the selector', () => {
    mocks.session.videoProfileError = '화질 변경 확인이 지연되고 있습니다.'

    render(<App />)

    expect(screen.getByRole('alert').textContent).toContain('화질 변경 확인')
    expect((screen.getByTestId('video-profile-select') as HTMLSelectElement).disabled).toBe(false)
  })

  it('marks the viewer surface for a high-contrast control pointer', () => {
    mocks.session.isControlActive = true

    render(<App />)

    expect(screen.getByTestId('viewer-stage').dataset.controlActive).toBe('true')
  })

  it('opens the Korean/text keyboard bar from the toolbar when control is active', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.isControlActive = true

    render(<App />)
    expect(screen.queryByTestId('mobile-keyboard-input')).toBeNull()

    fireEvent.click(screen.getByTestId('keyboard-button'))

    expect(screen.getByTestId('mobile-keyboard-input')).toBeTruthy()
  })

  it('disables the keyboard button until control is active', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.isControlActive = false

    render(<App />)

    expect((screen.getByTestId('keyboard-button') as HTMLButtonElement).disabled).toBe(true)
  })
})
