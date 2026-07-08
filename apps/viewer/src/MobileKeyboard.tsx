import { useEffect, useRef, useState } from 'react'

interface MobileKeyboardProps {
  readonly sendKey: (code: string, action: 'down' | 'up') => void
  readonly sendText: (text: string) => void
}

/**
 * Mobile typing surface (mobile mode). The "키보드" button opens a visible
 * input bar — Android (incl. Samsung keyboards) reliably raises the soft
 * keyboard only for a visible focused field, so the input is not hidden. Text
 * committed there (including Korean IME composition) is forwarded to the remote
 * as text.input and the field clears itself; Backspace on an empty field and
 * Enter are forwarded as key events.
 */
export function MobileKeyboard({ sendKey, sendText }: MobileKeyboardProps) {
  // Opens immediately: the parent already gates this component behind the
  // "한글 키보드" toggle, so showing the input (and focusing it to raise the
  // mobile soft keyboard) with no extra tap is the intended behavior.
  const [isOpen, setIsOpen] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!isOpen || !input) {
      return
    }
    input.focus()

    const pressKey = (code: 'Backspace' | 'Enter') => {
      sendKey(code, 'down')
      sendKey(code, 'up')
    }

    const handleCompositionStart = () => {
      isComposingRef.current = true
    }

    const handleCompositionEnd = (event: CompositionEvent) => {
      // The IME finished composing (a Hangul syllable/word). This is the
      // primary text channel on mobile keyboards.
      isComposingRef.current = false
      if (event.data) {
        sendText(event.data)
      }
      input.value = ''
    }

    const handleBeforeInput = (event: InputEvent) => {
      if (isComposingRef.current || event.isComposing) {
        // Let the IME edit the field freely; only the composed result is sent.
        return
      }
      if (event.inputType === 'insertText') {
        event.preventDefault()
        if (event.data) {
          sendText(event.data)
        }
        input.value = ''
        return
      }
      if (event.inputType === 'deleteContentBackward' && input.value === '') {
        // Nothing local to delete: forward Backspace to the remote.
        event.preventDefault()
        pressKey('Backspace')
        return
      }
      if (event.inputType === 'insertLineBreak') {
        event.preventDefault()
        pressKey('Enter')
        input.value = ''
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Single-line inputs deliver Enter as a keydown, not beforeinput.
      if (event.key === 'Enter' && !isComposingRef.current) {
        event.preventDefault()
        pressKey('Enter')
        input.value = ''
        return
      }
      // Empty-field Backspace produces no beforeinput on some keyboards.
      if (event.key === 'Backspace' && !isComposingRef.current && input.value === '') {
        event.preventDefault()
        pressKey('Backspace')
      }
    }

    input.addEventListener('compositionstart', handleCompositionStart)
    input.addEventListener('compositionend', handleCompositionEnd)
    input.addEventListener('beforeinput', handleBeforeInput)
    input.addEventListener('keydown', handleKeyDown)
    return () => {
      input.removeEventListener('compositionstart', handleCompositionStart)
      input.removeEventListener('compositionend', handleCompositionEnd)
      input.removeEventListener('beforeinput', handleBeforeInput)
      input.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, sendKey, sendText])

  return (
    <div className="mobile-keyboard">
      {!isOpen && (
        <button
          data-testid="mobile-keyboard-button"
          onClick={() => setIsOpen(true)}
          type="button"
        >
          ⌨ 키보드
        </button>
      )}
      {isOpen && (
        <div className="mobile-keyboard-bar" data-testid="mobile-keyboard-bar">
          <input
            aria-label="원격 입력"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="mobile-keyboard-input"
            data-testid="mobile-keyboard-input"
            placeholder="입력하면 원격으로 전송됩니다"
            ref={inputRef}
            spellCheck={false}
            type="text"
          />
          <button
            aria-label="키보드 닫기"
            data-testid="mobile-keyboard-close"
            onClick={() => setIsOpen(false)}
            type="button"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
