/**
 * AcpAgent — thin orchestration layer.
 *
 * Coordinates the modular components (connection, session, model, mode,
 * permissions, file handler, adapter, @ file resolver) without owning
 * any protocol or business logic itself.
 *
 * This file is the Phase 2 replacement for the original index.ts god class.
 * It is intentionally a SKELETON — method bodies reference the extracted
 * modules rather than re-implementing the logic.
 */

import type { AcpBackend, AcpResult } from '@/common/types/acpTypes';
import { AcpErrorType, createAcpError } from '@/common/types/acpTypes';
import { uuid } from '@/common/utils';

import { AcpConnection, type AcpConnectionHandlers } from './connection';
import { FileHandler } from './handlers/FileHandler';
import { PermissionHandler } from './handlers/PermissionHandler';
import { SessionManager } from './session/SessionManager';
import { ModelManager } from './session/ModelManager';
import { ModeManager } from './session/ModeManager';
import { AcpAdapter } from './AcpAdapter';
import { AtFileResolver } from './adapters/AtFileResolver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcpAgentExtra = {
  backend: AcpBackend;
  workspace: string;
  cliPath?: string;
  customArgs?: string[];
  customEnv?: Record<string, string>;
  yoloMode?: boolean;
  sessionMode?: string;
  acpSessionId?: string;
  acpSessionConversationId?: string;
  teamMcpStdioConfig?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
  currentModelId?: string;
};

export type AcpAgentCallbacks = {
  onStreamEvent: (event: unknown) => void;
  onSignalEvent?: (event: unknown) => void;
  onSessionIdUpdate?: (sessionId: string) => void;
  onAvailableCommandsUpdate?: (commands: unknown[]) => void;
};

// ---------------------------------------------------------------------------
// AcpAgent
// ---------------------------------------------------------------------------

export class AcpAgentNew {
  readonly id: string;
  private readonly extra: AcpAgentExtra;

  // -- Modules --
  private readonly connection: AcpConnection;
  private readonly permissions: PermissionHandler;
  private readonly fileHandler: FileHandler;
  private readonly sessionManager: SessionManager;
  private readonly modelManager: ModelManager;
  private readonly modeManager: ModeManager;
  private readonly adapter: AcpAdapter;
  private readonly atFileResolver: AtFileResolver;

  // -- Callbacks --
  private readonly callbacks: AcpAgentCallbacks;

  // -- Turn tracking --
  private turnHasThought = false;
  private turnHasContent = false;

  constructor(id: string, extra: AcpAgentExtra, callbacks: AcpAgentCallbacks) {
    this.id = id;
    this.extra = extra;
    this.callbacks = callbacks;

    // File handler
    this.fileHandler = new FileHandler(extra.workspace);

    // Permission handler
    this.permissions = new PermissionHandler({
      onEmit: (data) => this.emitPermissionRequest(data),
      isTeamMode: !!extra.teamMcpStdioConfig,
    });

    // Connection (SDK-based)
    this.connection = new AcpConnection(
      {
        onSessionUpdate: (params) => this.handleSessionUpdate(params),
        onPermissionRequest: async (params) => {
          const result = await this.permissions.handle(params as any);
          return { outcome: { outcome: 'selected' as const, optionId: result.optionId } };
        },
        onReadTextFile: (params) => this.fileHandler.readTextFile(params),
        onWriteTextFile: (params) => this.fileHandler.writeTextFile(params as any) as any,
        onDisconnect: () => this.handleDisconnect(),
      },
      {
        backend: extra.backend,
        workingDir: extra.workspace,
      }
    );

    // Session manager
    this.sessionManager = new SessionManager({
      conversationId: id,
      backend: extra.backend,
      workspace: extra.workspace,
      resumeSessionId: extra.acpSessionId,
      resumeConversationId: extra.acpSessionConversationId,
      onSessionIdUpdate: callbacks.onSessionIdUpdate,
      teamMcpStdioConfig: extra.teamMcpStdioConfig,
    });

    // Model & mode managers
    this.modelManager = new ModelManager();
    this.modeManager = new ModeManager({
      backend: extra.backend,
      initialYoloMode: extra.yoloMode,
      initialSessionMode: extra.sessionMode,
    });

    // Adapter (unchanged from original)
    this.adapter = new AcpAdapter(id, extra.backend);

    // @ file resolver
    this.atFileResolver = new AtFileResolver(extra.workspace);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Start: spawn → initialize → auth → session → mode → model.
   */
  async start(): Promise<void> {
    // 1. Spawn agent process (via connector system — not shown here)
    //    const child = await connectBackend(this.extra);
    //    this.connection.setup(child);
    // 2. Initialize protocol
    //    await this.connection.initialize();
    // 3. Authenticate if needed
    //    await this.performAuthentication();
    // 4. Create or resume session
    //    await this.sessionManager.createOrResume(this.connection);
    // 5. Apply YOLO mode if enabled
    //    await this.modeManager.applyYoloMode(this.connection);
    // 6. Apply user session mode
    //    await this.modeManager.applyUserSessionMode(this.connection);
    // 7. Apply model
    //    if (this.extra.currentModelId) {
    //      await this.connection.setModel(this.extra.currentModelId);
    //    }
    // 8. Emit model info
    //    this.emitModelInfo();
  }

  /**
   * Send a user message.
   */
  async sendMessage(content: string, files?: string[], msgId?: string): Promise<AcpResult> {
    this.turnHasThought = false;
    this.turnHasContent = false;

    // Auto-reconnect if needed
    if (!this.connection.isConnected || !this.connection.hasActiveSession) {
      await this.start();
    }

    // Resolve @ file references
    let processed = await this.atFileResolver.resolve(content, files);

    // Re-assert model override if needed
    await this.modelManager.reassertModelIfNeeded(this.connection);

    // Inject model switch notice
    const switchNotice = this.modelManager.consumeSwitchNotice();
    if (switchNotice) {
      processed = `<system-reminder>Your model has been changed to: ${switchNotice}</system-reminder>\n${processed}`;
    }

    // Send prompt
    try {
      await this.connection.sendPrompt(processed);
      return { success: true, data: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: createAcpError(AcpErrorType.UNKNOWN, msg) };
    }
  }

  /**
   * Confirm a pending permission request from the UI.
   */
  confirmMessage(data: { confirmKey: string; callId: string }): AcpResult {
    const found = this.permissions.confirm(data.callId, data.confirmKey);
    if (found) {
      return { success: true, data: null };
    }
    return {
      success: false,
      error: createAcpError(AcpErrorType.UNKNOWN, `Permission request not found: ${data.callId}`),
    };
  }

  /**
   * Cancel the current prompt without killing the process.
   */
  cancelPrompt(): void {
    this.connection.cancelPrompt();
    this.permissions.cancelAll('Cancelled');
  }

  /**
   * Kill the agent process and clean up.
   */
  async kill(): Promise<void> {
    this.permissions.cancelAll('Session killed');
    this.permissions.clearApprovals();
    await this.connection.disconnect();
  }

  // =========================================================================
  // Model / Mode / Config delegates
  // =========================================================================

  getModelInfo() {
    return this.modelManager.getModelInfo(this.connection);
  }

  getConfigOptions() {
    return this.modelManager.getConfigOptions(this.connection);
  }

  async setModelByConfigOption(modelId: string) {
    return this.modelManager.setModel(this.connection, modelId);
  }

  async setConfigOption(configId: string, value: string) {
    return this.modelManager.setConfigOption(this.connection, configId, value);
  }

  async setMode(mode: string) {
    return this.modeManager.setMode(this.connection, mode);
  }

  async enableYoloMode() {
    return this.modeManager.enableYoloMode(this.connection);
  }

  // =========================================================================
  // State queries
  // =========================================================================

  get isConnected() {
    return this.connection.isConnected;
  }

  get hasActiveSession() {
    return this.connection.hasActiveSession;
  }

  get currentSessionId() {
    return this.connection.currentSessionId;
  }

  // =========================================================================
  // Internal handlers (wired to connection callbacks)
  // =========================================================================

  private handleSessionUpdate(params: unknown): void {
    // Forward to adapter for TMessage conversion
    // Forward usage updates, config option updates, etc.
    // (Implementation mirrors original but delegates to adapter)
  }

  private handleDisconnect(): void {
    this.permissions.cancelAll('Connection lost');
    this.modelManager.reset();
  }

  private emitPermissionRequest(data: unknown): void {
    // Convert to UI format and emit via callbacks.onSignalEvent
  }

  private emitModelInfo(): void {
    const modelInfo = this.modelManager.getModelInfo(this.connection);
    if (modelInfo) {
      this.callbacks.onStreamEvent({
        type: 'acp_model_info',
        conversation_id: this.id,
        msg_id: uuid(),
        data: modelInfo,
      });
    }
  }
}
