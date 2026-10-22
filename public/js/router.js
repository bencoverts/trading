/** Path based router for the single-page shell. */

const routes = new Map();
let notFound = null;

export function route(path, handler) {
  routes.set(path, handler);
}

export function setNotFound(handler) {
  notFound = handler;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

export function currentPath() {
  return location.pathname;
}

export async function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const handler = routes.get(path) ?? notFound;
  if (!handler) return;
  const outlet = document.getElementById('view');
  if (!outlet) return;
  outlet.replaceChildren();
  document.body.dataset.route = path;
  try {
    await handler({ outlet, path, query: new URLSearchParams(location.search) });
  } catch (err) {
    console.error(err);
    outlet.replaceChildren();
    const box = document.createElement('div');
    box.className = 'panel error-panel';
    box.textContent = err?.message ? `Error: ${err.message}` : 'Unexpected error';
    outlet.append(box);
  }
}

export function startRouter() {
  window.addEventListener('popstate', () => void render());
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[data-link]');
    if (!link) return;
    if (link.target === '_blank' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });
  void render();
}
