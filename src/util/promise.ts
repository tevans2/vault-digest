/**
 * Run a side effect when a promise resolves, discarding whatever the callback returns.
 *
 * Why this exists: from Obsidian 1.13 a `Setting` has its own `then(callback)` builder method.
 * If a promise callback *returns* a Setting (e.g. `p.then(v => setting.setDesc(v))`), JavaScript
 * treats it as a thenable, calls `setting.then(resolve)`, which calls `resolve(setting)`, which
 * sees another thenable... an endless microtask loop that freezes the whole window.
 * Never return a Setting (or anything with a `then`) from a promise callback or async function.
 */
export function whenReady<T>(promise: Promise<T>, effect: (value: T) => unknown): void {
  promise.then(
    (value) => {
      try {
        effect(value);
      } catch (e) {
        console.error("[vault-digest] whenReady effect failed", e);
      }
      // No return: nothing leaks back into the promise chain.
    },
    (e) => {
      console.error("[vault-digest] whenReady promise rejected", e);
    }
  );
}
