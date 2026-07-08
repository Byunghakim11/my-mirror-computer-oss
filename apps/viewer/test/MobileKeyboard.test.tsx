import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileKeyboard } from '../src/MobileKeyboard'

afterEach(cleanup)

function setup() {
  const sendKey = vi.fn()
  const sendText = vi.fn()
  const utils = render(<MobileKeyboard sendKey={sendKey} sendText={sendText} />)
  return { sendKey, sendText, ...utils }
}

function openBar(utils: ReturnType<typeof setup>) {
  // The bar opens on mount now, so the input is already present.
  return utils.getByTestId('mobile-keyboard-input') as HTMLInputElement
}

describe('MobileKeyboard', () => {
  it('opens a visible input bar and focuses it', () => {
    const utils = setup()
    const input = openBar(utils)
    expect(utils.getByTestId('mobile-keyboard-bar')).toBeTruthy()
    expect(document.activeElement).toBe(input)
  })

  it('closes the bar with the close button', () => {
    const utils = setup()
    openBar(utils)
    fireEvent.click(utils.getByTestId('mobile-keyboard-close'))
    expect(utils.queryByTestId('mobile-keyboard-bar')).toBeNull()
  })

  it('sends composed IME text on compositionend and clears the field', () => {
    const utils = setup()
    const input = openBar(utils)
    input.value = '안녕'
    input.dispatchEvent(new CompositionEvent('compositionstart'))
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '안녕' }))
    expect(utils.sendText).toHaveBeenCalledWith('안녕')
    expect(input.value).toBe('')
  })

  it('sends plain insertText outside composition', () => {
    const utils = setup()
    const input = openBar(utils)
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        cancelable: true,
        data: 'a',
        inputType: 'insertText',
      }),
    )
    expect(utils.sendText).toHaveBeenCalledWith('a')
  })

  it('does not send partial text while composing', () => {
    const utils = setup()
    const input = openBar(utils)
    input.dispatchEvent(new CompositionEvent('compositionstart'))
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        cancelable: true,
        data: 'ㅇ',
        inputType: 'insertCompositionText',
      }),
    )
    expect(utils.sendText).not.toHaveBeenCalled()
  })

  it('forwards Backspace to the remote only when the field is empty', () => {
    const utils = setup()
    const input = openBar(utils)
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        cancelable: true,
        inputType: 'deleteContentBackward',
      }),
    )
    expect(utils.sendKey).toHaveBeenNthCalledWith(1, 'Backspace', 'down')
    expect(utils.sendKey).toHaveBeenNthCalledWith(2, 'Backspace', 'up')

    // With local text present, deletion edits the field instead.
    utils.sendKey.mockClear()
    input.value = '안'
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        cancelable: true,
        inputType: 'deleteContentBackward',
      }),
    )
    expect(utils.sendKey).not.toHaveBeenCalled()
  })

  it('maps Enter keydown to a remote Enter press', () => {
    const utils = setup()
    const input = openBar(utils)
    input.dispatchEvent(
      new KeyboardEvent('keydown', { cancelable: true, key: 'Enter' }),
    )
    expect(utils.sendKey).toHaveBeenNthCalledWith(1, 'Enter', 'down')
    expect(utils.sendKey).toHaveBeenNthCalledWith(2, 'Enter', 'up')
  })
})
