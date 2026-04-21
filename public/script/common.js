// Shared utilities
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function toggleHelp() {
  const el = document.getElementById('searchHelp');
  if (el) el.classList.toggle('open');
}

function collapseHelp() {
  const el = document.getElementById('searchHelp');
  if (el) el.classList.remove('open');
}

window.addEventListener('DOMContentLoaded', async () => {
  // Load fragments
  const fragments = document.querySelectorAll('.fragment');
  for await (const fragment of fragments) {
    try {
      const path = fragment.getAttribute('data-path');
      const result = await fetch('/static/fragment/' + path);
      const element = document.createElement('div');
      element.innerHTML = await result.text();
      fragment.replaceWith(element);
    } catch(e) {
      console.error(e);
    }
  }

  // Set active nav link based on current path
  const path = window.location.pathname;
  document.querySelectorAll('.nav-menu a').forEach(a => {
    a.classList.remove('active');
    const href = a.getAttribute('href');
    if (href === '/' ? path === '/' : path.startsWith(href)) {
      a.classList.add('active');
    }
  });
});
