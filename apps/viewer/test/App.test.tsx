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
    canSendFiles: false,
    sendFile: vi.fn(),
    sendClipboardImage: vi.fn(),
    sendKey: vi.fn(),
    sendPointerButton: vi.fn(),
    sendPointerMove: vi.fn(),
    sendPointerWheel: vi.fn(),
    sendText: vi.fn(),
    setRemoteClipboard: vi.fn(),
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
  mocks.session.canSendFiles = false
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

  it('offers a high video profile option and requests it on selection', () => {
    render(<App />)

    const select = screen.getByTestId('video-profile-select') as HTMLSelectElement
    const options = Array.from(select.options).map((option) => option.value)
    expect(options).toContain('high')

    fireEvent.change(select, { target: { value: 'high' } })

    expect(mocks.session.setVideoProfile).toHaveBeenCalledWith('high')
  })

  it('sends the Hangul/English IME toggle key when control is active', () => {
    mocks.session.isControlActive = true

    render(<App />)
    fireEvent.click(screen.getByTestId('hangul-toggle-button'))

    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(1, 'Lang1', 'down')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(2, 'Lang1', 'up')
    expect(mocks.session.sendKey).toHaveBeenCalledTimes(2)
  })

  it('sends the Win+Shift+S capture chord in down/reverse-up order when control is active', () => {
    mocks.session.isControlActive = true

    render(<App />)
    fireEvent.click(screen.getByTestId('capture-button'))

    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(1, 'MetaLeft', 'down')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(2, 'ShiftLeft', 'down')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(3, 'KeyS', 'down')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(4, 'KeyS', 'up')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(5, 'ShiftLeft', 'up')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(6, 'MetaLeft', 'up')
    expect(mocks.session.sendKey).toHaveBeenCalledTimes(6)
  })

  it('disables the Hangul toggle and capture buttons until control is active', () => {
    mocks.session.isControlActive = false

    render(<App />)

    expect((screen.getByTestId('hangul-toggle-button') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByTestId('capture-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('writes the remote clipboard and sends a Ctrl+V chord from the clipboard panel', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.isControlActive = true

    render(<App />)
    expect(screen.queryByTestId('remote-clipboard-input')).toBeNull()

    fireEvent.click(screen.getByTestId('clipboard-button'))
    fireEvent.change(screen.getByTestId('remote-clipboard-input'), {
      target: { value: '회사에서 복사한 텍스트' },
    })
    fireEvent.click(screen.getByTestId('remote-clipboard-paste'))

    expect(mocks.session.setRemoteClipboard).toHaveBeenCalledWith('회사에서 복사한 텍스트')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(1, 'ControlLeft', 'down')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(2, 'KeyV', 'down')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(3, 'KeyV', 'up')
    expect(mocks.session.sendKey).toHaveBeenNthCalledWith(4, 'ControlLeft', 'up')
    expect(mocks.session.sendKey).toHaveBeenCalledTimes(4)
  })

  it('sends a pasted image to the home PC clipboard from the panel', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.isControlActive = true

    render(<App />)
    fireEvent.click(screen.getByTestId('clipboard-button'))

    const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('remote-clipboard-input'), {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] },
    })

    expect(mocks.session.sendClipboardImage).toHaveBeenCalledTimes(1)
    expect(mocks.session.setRemoteClipboard).not.toHaveBeenCalled()
  })

  it('does not treat a plain-text paste as an image', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.isControlActive = true

    render(<App />)
    fireEvent.click(screen.getByTestId('clipboard-button'))

    fireEvent.paste(screen.getByTestId('remote-clipboard-input'), {
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] },
    })

    expect(mocks.session.sendClipboardImage).not.toHaveBeenCalled()
  })

  it('keeps the clipboard paste action disabled until text is entered', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.isControlActive = true

    render(<App />)
    fireEvent.click(screen.getByTestId('clipboard-button'))

    expect((screen.getByTestId('remote-clipboard-paste') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('disables the clipboard button until control is active', () => {
    mocks.session.isControlActive = false

    render(<App />)

    expect((screen.getByTestId('clipboard-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('highlights the stage while a file is dragged over it', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.canSendFiles = true

    render(<App />)
    const stage = screen.getByTestId('viewer-stage')
    fireEvent.dragOver(stage, { dataTransfer: { types: ['Files'], dropEffect: '' } })

    expect(stage.dataset.dragOver).toBe('true')
    expect(screen.getByTestId('file-drop-overlay')).toBeTruthy()
  })

  it('sends a file dropped onto the viewer stage', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.canSendFiles = true

    render(<App />)
    const stage = screen.getByTestId('viewer-stage')
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const files = {
      length: 1,
      item: (index: number) => (index === 0 ? file : null),
    } as unknown as FileList
    fireEvent.drop(stage, { dataTransfer: { files, types: ['Files'] } })

    expect(mocks.session.sendFile).toHaveBeenCalledTimes(1)
    expect(mocks.session.sendFile).toHaveBeenCalledWith(file)
  })

  it('ignores a drop when the file channel is not ready', () => {
    mocks.session.mediaStream = {} as MediaStream
    mocks.session.canSendFiles = false

    render(<App />)
    const stage = screen.getByTestId('viewer-stage')
    const file = new File(['x'], 'x.txt')
    const files = { length: 1, item: () => file } as unknown as FileList
    fireEvent.drop(stage, { dataTransfer: { files, types: ['Files'] } })

    expect(mocks.session.sendFile).not.toHaveBeenCalled()
  })
})
