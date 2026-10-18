// GitHub Pages serves 404.html for client routes. Visit the real app document,
// then restore the complete URL before its module (and BrowserRouter) starts.
(() => {
  const appPath = '/dicompare/';
  const marker = '#__neurodesk_dicompare_route=';
  const isSchemaPath = path => /^\/dicompare\/schema(?:\/[^/]+)?\/?$/.test(path);

  if (isSchemaPath(location.pathname)) {
    const route = location.pathname + location.search + location.hash;
    location.replace(appPath + marker + encodeURIComponent(route));
  } else if (location.pathname === appPath && location.hash.startsWith(marker)) {
    try {
      const route = decodeURIComponent(location.hash.slice(marker.length));
      const target = new URL(route, location.origin);
      // Never restore an external URL or an unrelated route from a crafted link.
      if (target.origin === location.origin && isSchemaPath(target.pathname)) {
        history.replaceState(history.state, '', target.pathname + target.search + target.hash);
      }
    } catch {
      // A malformed marker is an ordinary app URL, not a redirect destination.
    }
  }
})();
