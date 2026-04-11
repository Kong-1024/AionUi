/**
 * A timer that supports pause, resume, reset, and cancel operations.
 *
 * Designed for ACP prompt timeout management:
 * - **pause/resume**: during permission requests, the timeout budget should freeze
 * - **reset**: on streaming session updates, restart the full timeout budget
 * - **expired**: a Promise that resolves when the timer fires without interruption
 *
 * Usage with SDK's ClientSideConnection:
 * ```ts
 * const timer = new ResettableTimer(promptTimeoutMs);
 * const result = await Promise.race([
 *   connection.prompt({ sessionId, prompt }),
 *   timer.expired.then(() => { throw new TimeoutError('prompt timeout'); }),
 * ]);
 * timer.cancel();
 * ```
 */
export class ResettableTimer {
  private readonly durationMs: number;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private _isPaused = false;
  private _isExpired = false;
  private _isCancelled = false;
  private resolveExpired!: () => void;

  /** Resolves when the timer fires. Never rejects. Never settles if cancelled. */
  readonly expired: Promise<void>;

  constructor(durationMs: number) {
    this.durationMs = durationMs;
    this.expired = new Promise<void>((resolve) => {
      this.resolveExpired = resolve;
    });
    this.scheduleTimeout();
  }

  /** Freeze the timer. Call `resume()` to restart with full budget. */
  pause(): void {
    if (this._isExpired || this._isCancelled || this._isPaused) return;
    this.clearTimeout();
    this._isPaused = true;
  }

  /** Restart a paused timer with the full timeout budget. */
  resume(): void {
    if (this._isExpired || this._isCancelled || !this._isPaused) return;
    this._isPaused = false;
    this.scheduleTimeout();
  }

  /**
   * Restart the timer with the full timeout budget.
   * Works on both active and paused timers.
   * Typical use: call on every streaming session update to keep the timer alive.
   */
  reset(): void {
    if (this._isExpired || this._isCancelled) return;
    this._isPaused = false;
    this.scheduleTimeout();
  }

  /** Permanently stop the timer. The `expired` promise will never settle. */
  cancel(): void {
    if (this._isExpired || this._isCancelled) return;
    this.clearTimeout();
    this._isCancelled = true;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  get isExpired(): boolean {
    return this._isExpired;
  }

  get isCancelled(): boolean {
    return this._isCancelled;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleTimeout(): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(
      () => {
        this._isExpired = true;
        this.resolveExpired();
      },
      Math.max(0, this.durationMs)
    );
  }

  private clearTimeout(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }
}
