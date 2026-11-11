import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentSetupDialog, MCP_URL } from '@/components/AgentSetupDialog'

function renderDialog() {
  const onOpenChange = vi.fn()
  render(<AgentSetupDialog open onOpenChange={onOpenChange} />)
  return { onOpenChange }
}

describe('AgentSetupDialog', () => {
  it('shows the connector link and Claude steps first', () => {
    renderDialog()

    expect(screen.getByRole('dialog', { name: 'Ask Claude or ChatGPT' })).toBeTruthy()
    expect(screen.getByText(MCP_URL)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Claude', selected: true })).toBeTruthy()
    expect(screen.getByText('Add custom connector')).toBeTruthy()
  })

  it('switches to the ChatGPT steps', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('tab', { name: 'ChatGPT' }))

    expect(screen.getByRole('tab', { name: 'ChatGPT', selected: true })).toBeTruthy()
    expect(screen.getByText('Add custom MCP server')).toBeTruthy()
  })

  it('copies the connector link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderDialog()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })

    expect(writeText).toHaveBeenCalledWith(MCP_URL)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('closes from the close button', () => {
    const { onOpenChange } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })
})
