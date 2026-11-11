import { Sun, Moon } from 'lucide-react'

const STORAGE_KEY = '28games_session_guide_theme'

// The theme lives on <html data-theme>, set before paint by the init script in __root.tsx;
// without it, the OS preference applies. Which icon shows is decided in CSS (styles.css).
function isDark() {
  const theme = document.documentElement.getAttribute('data-theme')
  return theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeToggle({ className }: { className?: string }) {
  function toggle() {
    const theme = isDark() ? 'light' : 'dark'
    localStorage.setItem(STORAGE_KEY, theme)
    const doc = document.documentElement
    doc.setAttribute('data-theme-switching', '')
    doc.setAttribute('data-theme', theme)
    void doc.offsetHeight
    doc.removeAttribute('data-theme-switching')
  }

  return (
    <button className={className} onClick={toggle} title="Toggle light/dark mode">
      <Sun size={18} className="theme-icon-sun" />
      <Moon size={18} className="theme-icon-moon" />
    </button>
  )
}
