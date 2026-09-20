// Light/dark theme. Follows the OS by default; the toggle cycles system → light → dark.
// Loaded in <head> so the stored choice applies before the first paint (no flash).
(function () {
  var KEY = 'course-theme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(mode) {
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
  }
  apply(stored());

  var ICON = {
    system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.2 8.2 0 1 0 20 14.2Z"/></svg>'
  };
  var ORDER = ['system', 'light', 'dark'];

  function build() {
    var btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.type = 'button';
    var mode = stored() || 'system';

    function render() {
      btn.innerHTML = ICON[mode] + '<span class="label">' + mode + '</span>';
      btn.setAttribute('aria-label', 'Theme: ' + mode + '. Click to change.');
      btn.title = 'Theme: ' + mode;
    }
    btn.addEventListener('click', function () {
      mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      try {
        if (mode === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, mode);
      } catch (e) { /* private mode: the choice just won't persist */ }
      apply(mode === 'system' ? null : mode);
      render();
    });
    render();
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
