import type { AcpBackend, AcpResponse } from '@/common/types/acpTypes';
import type { IMcpServer } from '@/common/config/storage';
import type { AcpSessionMcpServer } from '../config/mcpSessionConfig';
import {
  buildBuiltinAcpSessionMcpServers,
  buildTeamMcpServer,
  parseAcpMcpCapabilities,
} from '../config/mcpSessionConfig';
import type { TeamMcpPhase } from '@/common/types/teamTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The ACP connection methods that SessionManager needs. */
export interface SessionManagerConnection {
  loadSession(sessionId: string, workspace: string, mcpServers: AcpSessionMcpServer[]): Promise<{ sessionId?: string }>;
  newSession(
    workspace: string,
    options?: {
      resumeSessionId?: string;
      forkSession?: boolean;
      mcpServers?: AcpSessionMcpServer[];
    }
  ): Promise<{ sessionId?: string }>;
  getInitializeResponse(): AcpResponse | null;
}

export type McpStatusCallback = (phase: TeamMcpPhase, extra?: { serverCount?: number; error?: string }) => void;

export type SessionManagerOptions = {
  conversationId: string;
  backend: AcpBackend;
  workspace: string;
  /** Stored session ID to attempt resume. */
  resumeSessionId?: string;
  /** Conversation that owns the stored session (prevents cross-conversation resume). */
  resumeConversationId?: string;
  /** Callback when session ID changes (e.g. after resume creates new session). */
  onSessionIdUpdate?: (sessionId: string) => void;
  /** Callback for team MCP status events. */
  onMcpStatus?: McpStatusCallback;
  /** Team MCP stdio config (if in team mode). */
  teamMcpStdioConfig?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
  /** Aion MCP stdio config getter (for solo agents). */
  getAionMcpStdioConfig?: () => AionMcpStdioConfig | null;
};

// ---------------------------------------------------------------------------
// Lazy imports to avoid circular deps
// ---------------------------------------------------------------------------

type AionMcpStdioConfig = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
type GetAionMcpConfig = () => AionMcpStdioConfig | null;

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Manages session creation, resume, and MCP server injection.
 *
 * Three resume strategies:
 * 1. Codex: `session/load` (calls resume_thread_from_rollout internally)
 * 2. Claude/CodeBuddy: `_meta.resume` in `session/new`
 * 3. Generic: `resumeSessionId` in `session/new`
 *
 * Extracted from AcpAgent.createOrResumeSession / loadBuiltinSessionMcpServers.
 */
export class SessionManager {
  private readonly conversationId: string;
  private readonly backend: AcpBackend;
  private readonly workspace: string;
  private readonly resumeSessionId?: string;
  private readonly resumeConversationId?: string;
  private readonly onSessionIdUpdate?: (sessionId: string) => void;
  private readonly onMcpStatus?: McpStatusCallback;
  private readonly teamMcpStdioConfig?: SessionManagerOptions['teamMcpStdioConfig'];
  private readonly getAionMcpStdioConfig?: GetAionMcpConfig;

  /** Backends allowed to have the Aion team-guide MCP server injected. */
  private static readonly TEAM_GUIDE_BACKENDS: ReadonlySet<string> = new Set([
    'claude',
    'codex',
    'gemini',
    'codebuddy',
  ]);

  constructor(options: SessionManagerOptions) {
    this.conversationId = options.conversationId;
    this.backend = options.backend;
    this.workspace = options.workspace;
    this.resumeSessionId = options.resumeSessionId;
    this.resumeConversationId = options.resumeConversationId;
    this.onSessionIdUpdate = options.onSessionIdUpdate;
    this.onMcpStatus = options.onMcpStatus;
    this.teamMcpStdioConfig = options.teamMcpStdioConfig;
    // getAionMcpStdioConfig will be provided by the caller
  }

  /**
   * Create or resume a session on the given connection.
   * Handles Codex/Claude/generic resume strategies and MCP injection.
   */
  async createOrResume(connection: SessionManagerConnection): Promise<string | undefined> {
    const mcpServers = await this.loadMcpServers(connection);

    const emitMcpStatus = this.onMcpStatus ?? null;
    let resultSessionId: string | undefined;

    // Validate session ownership
    if (this.resumeSessionId && this.resumeConversationId && this.resumeConversationId !== this.conversationId) {
      console.warn(
        `[SessionManager] Session ${this.resumeSessionId} belongs to conversation ${this.resumeConversationId}, ` +
          `but current conversation is ${this.conversationId}. Starting fresh.`
      );
    } else if (this.resumeSessionId) {
      // Attempt resume
      try {
        emitMcpStatus?.('session_injecting', { serverCount: mcpServers.length });

        let response: { sessionId?: string };
        if (this.backend === 'codex') {
          response = await connection.loadSession(this.resumeSessionId, this.workspace, mcpServers);
        } else {
          response = await connection.newSession(this.workspace, {
            resumeSessionId: this.resumeSessionId,
            forkSession: false,
            mcpServers,
          });
        }

        this.emitMcpReady(emitMcpStatus, mcpServers.length);

        if (response.sessionId) {
          resultSessionId = response.sessionId;
          if (response.sessionId !== this.resumeSessionId) {
            this.onSessionIdUpdate?.(response.sessionId);
          }
        }
        return resultSessionId;
      } catch (resumeError) {
        const error = resumeError instanceof Error ? resumeError.message : String(resumeError);
        console.warn(`[SessionManager] Resume failed for ${this.resumeSessionId}, creating fresh:`, error);
        emitMcpStatus?.('session_error', { error });
      }
    }

    // Fresh session
    emitMcpStatus?.('session_injecting', { serverCount: mcpServers.length });
    const response = await connection.newSession(this.workspace, { mcpServers });
    this.emitMcpReady(emitMcpStatus, mcpServers.length);

    if (response.sessionId) {
      resultSessionId = response.sessionId;
      this.onSessionIdUpdate?.(response.sessionId);
    }

    return resultSessionId;
  }

  // ---------------------------------------------------------------------------
  // MCP server loading
  // ---------------------------------------------------------------------------

  private async loadMcpServers(connection: SessionManagerConnection): Promise<AcpSessionMcpServer[]> {
    try {
      // Dynamic import to avoid hard dep on ProcessConfig at module level
      const { ProcessConfig } = await import('@process/utils/initStorage');
      const mcpConfig = await ProcessConfig.get('mcp.config');
      const servers: AcpSessionMcpServer[] = [];

      if (Array.isArray(mcpConfig) && mcpConfig.length > 0) {
        const capabilities = parseAcpMcpCapabilities(connection.getInitializeResponse());
        servers.push(...buildBuiltinAcpSessionMcpServers(mcpConfig as IMcpServer[], capabilities));
      }

      // Team MCP server
      const teamServer = buildTeamMcpServer(this.teamMcpStdioConfig);
      if (teamServer) {
        servers.push(teamServer);
      }

      // Aion team-guide MCP for solo agents
      if (!this.teamMcpStdioConfig && SessionManager.TEAM_GUIDE_BACKENDS.has(this.backend)) {
        const aionConfig = this.getAionMcpStdioConfig?.();
        if (aionConfig) {
          const configWithBackend = {
            ...aionConfig,
            env: [...aionConfig.env, { name: 'AION_MCP_BACKEND', value: this.backend }],
          };
          const server = buildTeamMcpServer(configWithBackend);
          if (server) servers.push(server);
        }
      }

      return servers;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[SessionManager] Failed to load MCP config:`, msg);
      this.onMcpStatus?.('load_failed', { error: msg });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private emitMcpReady(emit: McpStatusCallback | null, serverCount: number): void {
    if (!emit) return;
    emit(serverCount === 0 ? 'degraded' : 'session_ready', { serverCount });
  }
}
