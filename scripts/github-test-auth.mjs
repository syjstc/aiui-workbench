// CI runners share an anonymous GitHub API quota. This optional test-only
// transport header keeps all requests and responses on the real GitHub service.
export function githubTestFetcher(repository, token, fetcher = fetch) {
  return (input, options = {}) => {
    const url = new URL(input);
    if (!token || url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/repos/' + repository + '/releases/')) return fetcher(input, options);
    const headers = new Headers(options.headers); headers.set('Authorization', 'Bearer ' + token);
    return fetcher(input, { ...options, headers });
  };
}

// Serialized by Playwright and installed before the desktop's startup check.
// It adds authentication only; it never replaces fetch or supplies responses.
export function installDesktopGithubTestAuth(_electron, { repository, token }) {
  const stats = { authenticatedRequests: 0 };
  process.getBuiltinModule('diagnostics_channel').channel('undici:request:create').subscribe(({ request }) => {
    const url = new URL(request.origin);
    if (url.origin === 'https://api.github.com' && request.path.startsWith('/repos/' + repository + '/releases/')) {
      request.addHeader('Authorization', 'Bearer ' + token); stats.authenticatedRequests++;
    }
  });
  globalThis.__aiuiQaGithubAuth = stats;
}
