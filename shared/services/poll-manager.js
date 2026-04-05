/**
 * Poll Manager - Reusable polling with visibility-based pause
 * and circuit breaker for Supabase outage resilience.
 *
 * Used by all mobile tab modules and resident pages to refresh data on an
 * interval, pausing when the app/tab is not visible or when the backend is down.
 */

import { supabaseHealth } from '../supabase-health.js';

const BACKOFF_THRESHOLD = 3;  // consecutive failures before doubling interval
const PAUSE_THRESHOLD = 6;    // consecutive failures before pausing entirely

export class PollManager {
  /**
   * @param {Function} callback - Async function to call on each poll
   * @param {number} intervalMs - Polling interval in milliseconds (default 30000)
   */
  constructor(callback, intervalMs = 30000) {
    this._callback = callback;
    this._intervalMs = intervalMs;
    this._currentIntervalMs = intervalMs;
    this._timer = null;
    this._failures = 0;
    this._paused = false;
    this._started = false;
    this._onVisChange = this._handleVisibility.bind(this);
    this._unsubHealth = null;
  }

  start() {
    this.stop();
    this._started = true;
    this._failures = 0;
    this._paused = false;
    this._currentIntervalMs = this._intervalMs;
    this._poll(); // immediate first poll
    this._scheduleNext();
    document.addEventListener('visibilitychange', this._onVisChange);

    // Subscribe to health recovery so we can resume after outage
    this._unsubHealth = supabaseHealth.onStatusChange((newStatus) => {
      if (newStatus === 'healthy' && this._paused) {
        console.log('[poll-manager] Health recovered — resuming polling');
        this._failures = 0;
        this._paused = false;
        this._currentIntervalMs = this._intervalMs;
        this._scheduleNext();
      }
    });
  }

  stop() {
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._unsubHealth) {
      this._unsubHealth();
      this._unsubHealth = null;
    }
    document.removeEventListener('visibilitychange', this._onVisChange);
  }

  /** Force an immediate poll (resets the interval). */
  refresh() {
    if (!this._started) return;
    this._failures = 0;
    this._paused = false;
    this._currentIntervalMs = this._intervalMs;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._poll();
    this._scheduleNext();
  }

  async _poll() {
    try {
      await this._callback();
      // Success — reset circuit breaker
      if (this._failures > 0) {
        this._failures = 0;
        this._currentIntervalMs = this._intervalMs;
      }
    } catch (err) {
      this._failures++;
      if (this._failures >= PAUSE_THRESHOLD && !this._paused) {
        this._paused = true;
        console.warn(`[poll-manager] ${this._failures} consecutive failures — pausing polls until recovery`);
        if (this._timer) {
          clearInterval(this._timer);
          this._timer = null;
        }
      } else if (this._failures >= BACKOFF_THRESHOLD && !this._paused) {
        const newInterval = this._intervalMs * 2;
        if (this._currentIntervalMs !== newInterval) {
          this._currentIntervalMs = newInterval;
          console.warn(`[poll-manager] ${this._failures} failures — backing off to ${newInterval}ms`);
          this._scheduleNext(); // reschedule with new interval
        }
      }
    }
  }

  _scheduleNext() {
    if (this._timer) {
      clearInterval(this._timer);
    }
    if (this._paused || !this._started) return;
    this._timer = setInterval(() => this._poll(), this._currentIntervalMs);
  }

  _handleVisibility() {
    if (document.hidden) {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    } else if (this._started && !this._paused) {
      this._poll();
      this._scheduleNext();
    }
  }
}
