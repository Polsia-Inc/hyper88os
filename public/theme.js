// Polsia ES Theme System
(function() {
  const DARK = {
    '--bg-primary': '#0a0a0f',
    '--bg-secondary': '#111118',
    '--bg-card': '#16161f',
    '--border': '#1e1e2a',
    '--text-primary': '#e8e8ed',
    '--text-secondary': '#8888a0',
    '--text-dim': '#55556a',
    '--accent': '#00e599',
    '--accent-dim': '#00e59920',
    '--amber': '#ffb800',
    '--red': '#ff4466',
    '--blue': '#4488ff'
  };
  const LIGHT = {
    '--bg-primary': '#f8f9fc',
    '--bg-secondary': '#ffffff',
    '--bg-card': '#f0f1f5',
    '--border': '#e2e4ea',
    '--text-primary': '#1a1a2e',
    '--text-secondary': '#5a5a7a',
    '--text-dim': '#9a9ab0',
    '--accent': '#00b876',
    '--accent-dim': '#00b87618',
    '--amber': '#e6a700',
    '--red': '#e63950',
    '--blue': '#3366dd'
  };

  function getTheme() {
    const stored = localStorage.getItem('polsia-theme');
    if (stored) return stored;
    // Check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  function applyTheme(theme) {
    const vars = theme === 'light' ? LIGHT : DARK;
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('polsia-theme', theme);

    // Update toggle buttons if they exist
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
      btn.title = theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
    });
  }

  function toggleTheme() {
    const current = getTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);

    // Save to server if logged in
    fetch('/api/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    }).catch(() => {});
  }

  // Apply immediately on load
  applyTheme(getTheme());

  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('polsia-theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  // Export
  window.PolsiaTheme = { getTheme, applyTheme, toggleTheme };

  // Auto-bind toggle buttons when DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.addEventListener('click', toggleTheme);
    });
  });
})();
