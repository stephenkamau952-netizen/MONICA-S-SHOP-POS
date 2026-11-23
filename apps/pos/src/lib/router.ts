import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('popstate', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('popstate', cb);
  };
}

export function navigate(path: string, replace = false) {
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}
