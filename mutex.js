/**
 * mutex.js
 * Asynchronous mutual-exclusion lock to prevent race conditions
 * between the 5-minute independent verification and the 29-minute logout/login cycle.
 */

class AsyncMutex {
  constructor() {
    this._locked = false;
    this._waiting = [];
  }

  /**
   * Acquire the lock.
   * Returns an unlock callback function.
   * Usage:
   *   const unlock = await mutex.acquire();
   *   try { ... } finally { unlock(); }
   */
  async acquire() {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve(this._release.bind(this));
      } else {
        this._waiting.push(resolve);
      }
    });
  }

  _release() {
    if (this._waiting.length > 0) {
      const nextResolve = this._waiting.shift();
      nextResolve(this._release.bind(this));
    } else {
      this._locked = false;
    }
  }

  isLocked() {
    return this._locked;
  }
}

module.exports = AsyncMutex;
