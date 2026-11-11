import { Sun, Moon } from 'lucide-react'
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = '28games_session_guide_theme'
const darkQuery = '(prefers-color-scheme: dark)'

// The theme lives on <html data-theme>, set before paint by the init script in __root.tsx;
// without it, the OS preference applies.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] })
  const media = window.matchMedia(darkQuery)
  media.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', onChange)
  }
}

function isDark() {
  const theme = document.documentElement.getAttribute('data-theme')
  return theme ? theme === 'dark' : window.matchMedia(darkQuery).matches
}

export function ThemeToggle({ className }: { className?: string }) {
  const dark = useSyncExternalStore(subscribe, isDark, () => true)

  function toggle() {
    const theme = dark ? 'light' : 'dark'
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
