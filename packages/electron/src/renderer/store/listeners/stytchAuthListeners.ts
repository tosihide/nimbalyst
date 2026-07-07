/**
 * Central Stytch Auth State Listener
 *
 * Subscribes to `electronAPI.stytch.onAuthStateChange` ONCE at app startup
 * and writes the latest snapshot to `stytchAuthAtom`. Components read from
 * the atom and MUST NOT subscribe to the IPC event directly (see IPC_LISTENERS.md).
 *
 * Also performs the initial `getAuthState()` fetch so consumers can render
 * synchronously off the atom without each one re-fetching.
 *
 * Call initStytchAuthListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { stytchAuthAtom, type StytchAuthSnapshot } from '../atoms/stytchAuth';

let initialized = false;

export function initStytchAuthListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const stytch = window.electronAPI?.stytch;
  if (!stytch) {
    return () => {
      initialized = false;
    };
  }

  // Initial fetch -- atom stays null until this resolves so the UI can
  // distinguish "still loading" from "loaded and signed out".
  stytch.getAuthState()
    .then((state) => {
      store.set(stytchAuthAtom, {
        isAuthenticated: !!state?.isAuthenticated,
        user: state?.user ?? null,
      } satisfies StytchAuthSnapshot);
    })
    .catch(() => {
      // Treat fetch failure as signed-out rather than leaving the atom null
      // forever -- otherwise the UI never resolves out of its loading state.
      store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    });

  const unsubscribe = stytch.onAuthStateChange?.((state: { isAuthenticated?: boolean; user?: StytchAuthSnapshot['user'] }) => {
    store.set(stytchAuthAtom, {
      isAuthenticated: !!state?.isAuthenticated,
      user: state?.user ?? null,
    });
  });

  return () => {
    initialized = false;
    unsubscribe?.();
  };
}
