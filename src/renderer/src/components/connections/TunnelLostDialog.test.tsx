// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TunnelLostDialog, type TunnelLostRequest } from './TunnelLostDialog'

const request: TunnelLostRequest = {
  requestId: 'tunnel-lost-1',
  profileName: '🇪🇺 oms prod',
}

describe('TunnelLostDialog', () => {
  afterEach(cleanup)

  it('names the dropped connection and answers reconnect on confirm', () => {
    const onAnswer = vi.fn()
    render(<TunnelLostDialog request={request} onAnswer={onAnswer} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Teleport tunnel lost')
    expect(dialog.textContent).toContain('🇪🇺 oms prod')

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onAnswer).toHaveBeenCalledWith('tunnel-lost-1', true)
  })

  it('answers cancel on Cancel', () => {
    const onAnswer = vi.fn()
    render(<TunnelLostDialog request={request} onAnswer={onAnswer} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onAnswer).toHaveBeenCalledWith('tunnel-lost-1', false)
  })

  it('treats Escape as cancel', () => {
    const onAnswer = vi.fn()
    render(<TunnelLostDialog request={request} onAnswer={onAnswer} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onAnswer).toHaveBeenCalledWith('tunnel-lost-1', false)
  })
})
