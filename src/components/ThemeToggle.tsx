import { Sun, Moon } from 'lucide-react'
import { useState, useEffect } from 'react'

const STORAGE_KEY = '28games_session_guide_theme'

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light') {
      setDark(false)
    } else if (stored === 'dark') {
      setDark(true)
    } else {
      setDark(window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    const theme = next ? 'dark' : 'light'
    localStorage.setItem(STORAGE_KEY, theme)
    const doc = document.documentElement
    doc.setAttribute('data-theme-switching', '')
    doc.setAttribute('data-theme', theme)
    void doc.offsetHeight
    doc.removeAttribute('data-theme-switching')
  }

  return (
    <button className={className} onClick={toggle} title="Toggle light/dark mode">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
