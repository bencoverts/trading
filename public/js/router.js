/**
 * Small history-API router.
 * Routes are declared as strings with `:params`; `/admin/*` is lazy-loaded so
 * the admin bundle is never fetched by normal users.
 */

export function createRouter(routes, { onBefore, onAfter, fallback } = {}) {
  const compiled = routes.map((route) => {
    const keys = [];
    const pattern = new RegExp(
      `^${route.path
        .split('/')
        .map((segment) => {
          if (segment.startsWith(':')) {
            keys.push(segment.slice(1));
            return '([^/]+)';
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/')}$`,
    );
    return { ...route, pattern, keys };
  });

  function match(pathname) {
    for (const route of compiled) {
      const found = route.pattern.exec(pathname);
      if (!found) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(found[index + 1]);
      });
      return { route, params };
    }
    return null;
  }

  async function render(pathname, { push = false, replace = false } = {}) {
    const found = match(pathname);
    const target = found?.route ?? fallback;
    const params = found?.params ?? {};
    if (push) history.pushState({}, '', pathname);
    if (replace) history.replaceState({}, '', pathname);

    const allowed = onBefore?.(target, params);
    if (allowed === false) return;
    for (const link of document.querySelectorAll('[data-link]')) {
      link.removeAttribute('aria-current');
    }
    const navLink = document.querySelector(`[data-link][href="${pathname}"]`);
    if (navLink) navLink.setAttribute('aria-current', 'page');
    await onAfter?.(pathname);
    await target.render({ params, pathname });
  }

  function start() {
    window.addEventListener('popstate', () => void render(location.pathname));
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest('a[data-link]');
      if (!anchor) return;
      if (anchor.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const url = new URL(anchor.href, location.origin); // eslint-disable-line no-undef
      if (url.origin !== location.origin) return;
      event.preventDefault();
      void render(url.pathname + url.search);
    });
    return render(location.pathname, { replace: true });
  }

  return {
    start,
    go(path, options = {}) {
      return render(path, { push: true, ...options });
    },
    current: () => location.pathname,
  };
}
