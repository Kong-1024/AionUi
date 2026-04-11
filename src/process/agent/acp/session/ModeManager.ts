import type { AcpBackend } from '@/common/types/acpTypes';
import { CLAUDE_YOLO_SESSION_MODE, QWEN_YOLO_SESSION_MODE } from '../config/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The ACP connection methods that ModeManager needs. */
export interface ModeManagerConnection {
  readonly isConnected: boolean;
  readonly hasActiveSession: boolean;
  setSessionMode(mode: string): Promise<void>;
}

export type ModeManagerOptions = {
  backend: AcpBackend;
  initialYoloMode?: boolean;
  initialSessionMode?: string;
};

// ---------------------------------------------------------------------------
// YOLO mode map
// ---------------------------------------------------------------------------

const YOLO_MODE_MAP: Partial<Record<AcpBackend, string>> = {
  claude: CLAUDE_YOLO_SESSION_MODE,
  qwen: QWEN_YOLO_SESSION_MODE,
};

// ---------------------------------------------------------------------------
// ModeManager
// ---------------------------------------------------------------------------

/**
 * Manages session mode and YOLO (auto-approve) mode.
 *
 * Extracted from AcpAgent.applySessionMode / setMode / enableYoloMode.
 */
export class ModeManager {
  private readonly backend: AcpBackend;
  private _yoloMode: boolean;
  private _sessionMode: string | undefined;

  constructor(options: ModeManagerOptions) {
    this.backend = options.backend;
    this._yoloMode = options.initialYoloMode ?? false;
    this._sessionMode = options.initialSessionMode;
  }

  get yoloMode(): boolean {
    return this._yoloMode;
  }

  get sessionMode(): string | undefined {
    return this._sessionMode;
  }

  /**
   * Apply a session mode on the connection.
   * @param fatal If true, throw on failure. If false, log a warning.
   */
  async applySessionMode(
    connection: ModeManagerConnection,
    mode: string,
    fatal: boolean,
    label: string
  ): Promise<void> {
    try {
      await connection.setSessionMode(mode);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (fatal) {
        throw new Error(`[ACP] Failed to enable ${label} (${mode}): ${msg}`, { cause: error });
      }
      console.warn(`[ACP] Failed to set session mode "${mode}": ${msg}`);
    }
  }

  /**
   * Apply YOLO mode if enabled. Call after session creation.
   */
  async applyYoloMode(connection: ModeManagerConnection): Promise<void> {
    if (!this._yoloMode) return;
    const mode = YOLO_MODE_MAP[this.backend];
    if (mode) {
      await this.applySessionMode(connection, mode, true, 'YOLO mode');
    }
  }

  /**
   * Apply the user-selected session mode (if any and not in YOLO mode).
   */
  async applyUserSessionMode(connection: ModeManagerConnection): Promise<void> {
    if (this._yoloMode || !this._sessionMode) return;
    await this.applySessionMode(connection, this._sessionMode, false, 'user session mode');
  }

  /**
   * Enable YOLO mode at runtime on an active session.
   */
  async enableYoloMode(connection: ModeManagerConnection): Promise<void> {
    if (this._yoloMode) return;
    this._yoloMode = true;

    if (connection.isConnected && connection.hasActiveSession) {
      const mode = YOLO_MODE_MAP[this.backend];
      if (mode) {
        await connection.setSessionMode(mode);
      }
    }
  }

  /**
   * Set session mode from the UI (e.g. plan, default, bypassPermissions).
   * If no active session, persists for next session start.
   */
  async setMode(connection: ModeManagerConnection, mode: string): Promise<{ success: boolean; error?: string }> {
    if (!connection.isConnected || !connection.hasActiveSession) {
      this._sessionMode = mode;
      return { success: true };
    }
    try {
      await connection.setSessionMode(mode);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[ModeManager] Failed to set mode:', msg);
      return { success: false, error: msg };
    }
  }
}
