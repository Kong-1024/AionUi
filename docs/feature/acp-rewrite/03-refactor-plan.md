# ACP 重构方案

## 重构路线

采用渐进式重构，不做大爆炸式重写。核心思路：

1. **移植 acpx 的业务无关核心** — 将 acpx 中经过验证的协议层工具搬到 AionUi
2. **拆分 AionUi 的 ACP 业务逻辑** — 把 AcpAgent 上帝类分解为独立模块
3. **定义抽象接口** — 用接口把新核心和现有业务逻辑连接起来
4. **逐步切换** — 新实现通过接口替换旧实现，支持灰度和回退

## Phase 1：移植 acpx 协议层核心

将 acpx `src/acp/` 中与业务无关的模块移植到 AionUi，放在 `src/process/agent/acp/core/` 目录下。

### 目标文件

```
src/process/agent/acp/core/
├── process-utils.ts            ← acpx client-process.ts
├── jsonrpc.ts                  ← acpx jsonrpc.ts
├── jsonrpc-error.ts            ← acpx jsonrpc-error.ts
├── error-shapes.ts             ← acpx error-shapes.ts
├── error-normalization.ts      ← acpx error-normalization.ts
├── session-control-errors.ts   ← acpx session-control-errors.ts
└── types.ts                    ← 共享类型定义（OutputErrorCode 等）
```

### 各模块移植说明

#### `process-utils.ts`（来自 `client-process.ts`）

直接复制，无改动。包含：

- `splitCommandLine()` — 替代 `acpConnectors.ts` 中的 `cliPath.split(' ')`
- `waitForSpawn()` — 替代 `AcpConnection.ts` 中的 `setImmediate + spawnError` 模式
- `waitForChildExit()` — 替代 `utils.ts` 中的轮询式 `waitForProcessExit()`
- `isChildProcessRunning()` — 替代 `child.killed` 判断
- `basenameToken()` / `isoNow()`

#### `jsonrpc.ts`（来自 `jsonrpc.ts`）

直接复制。函数名中的 "Acp" 前缀可选择保留或去掉（建议去掉，因为这些是纯 JSON-RPC 2.0 工具）。

依赖 `@agentclientprotocol/sdk` 的类型（`AnyMessage`、`SessionNotification` 等）。SDK 是本次重构的基础依赖（见下方 SDK 策略章节）。

#### `error-shapes.ts`

直接复制。`OutputErrorAcpPayload` 类型定义在 `types.ts` 中（与 SDK 的错误 payload 结构对齐）。

#### `jsonrpc-error.ts`

直接复制。依赖 `OutputErrorCode` / `OutputErrorOrigin` 类型，定义在 `types.ts` 中。

#### `error-normalization.ts`

复制框架，**需要适配 AionUi 的错误类型**。acpx 的 `mapErrorCode()` 引用了 acpx 特有的错误类（`PermissionDeniedError`、`PermissionPromptUnavailableError`）。改动：

- 将 `mapErrorCode()` 改为接受一个可配置的错误类型映射表，或在 AionUi 侧定义等价的错误类
- `isRetryablePromptError()` 和 `exitCodeForOutputErrorCode()` 可直接复制

#### `session-control-errors.ts`

直接复制。仅依赖 `error-shapes.ts` 的 `extractAcpError()`。

#### `types.ts`

新建，集中定义 AionUi 侧需要但 SDK 未导出的补充类型。尽量复用 SDK 导出的类型，仅为 SDK 不覆盖的部分定义本地类型：

```typescript
// 补充类型 — SDK 未导出的
export type OutputErrorCode =
  | 'RUNTIME'
  | 'TIMEOUT'
  | 'NO_SESSION'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_PROMPT_UNAVAILABLE'
  | 'USAGE';

export type OutputErrorOrigin = 'client' | 'agent' | 'transport';

export type OutputErrorAcpPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE: 2,
  TIMEOUT: 3,
  NO_SESSION: 4,
  PERMISSION_DENIED: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
```

### 预期结果

- 约 600 行代码，全部业务无关
- 完整的 JSON-RPC 2.0 消息校验
- 结构化错误提取和分类
- 可重试性判断
- 健壮的进程工具函数

## Phase 2：拆分 AionUi 业务逻辑

在 Phase 1 的 `core/` 基础上，将 AcpAgent 上帝类和 AcpConnection 拆分为职责清晰的模块。

### 目标结构

```
src/process/agent/acp/
├── core/                          ← Phase 1 产出（业务无关）
│
├── connection/                    ← 从 AcpConnection 拆出
│   ├── AcpTransport.ts            ← 纯传输层：stdio ↔ ndjson ↔ JSON-RPC message
│   ├── AcpRequestTracker.ts       ← 请求跟踪：pending map + timeout pause/resume
│   └── AcpConnection.ts           ← 瘦身后的连接管理：spawn + setup + disconnect
│
├── session/                       ← 从 AcpAgent 拆出
│   ├── SessionManager.ts          ← create / resume / load session + MCP 注入
│   ├── ModelManager.ts            ← model switch + configOption + model info
│   └── ModeManager.ts             ← session mode + YOLO mode
│
├── handlers/                      ← 从 AcpAgent + AcpConnection 拆出
│   ├── PermissionHandler.ts       ← 权限请求处理 + ApprovalStore
│   ├── FileHandler.ts             ← readTextFile / writeTextFile
│   └── SessionUpdateHandler.ts    ← session update 分发
│
├── adapters/                      ← 从 AcpAgent 拆出
│   ├── AcpAdapter.ts              ← 不变（session update → TMessage）
│   ├── NavigationInterceptor.ts   ← 导航工具拦截
│   └── AtFileResolver.ts          ← @ 文件引用解析
│
├── connectors/                    ← 基本不变
│   ├── acpConnectors.ts
│   └── AcpDetector.ts
│
├── config/                        ← 从各处收拢
│   ├── constants.ts               ← YOLO mode 常量
│   ├── mcpSessionConfig.ts        ← MCP server 构建
│   └── modelInfo.ts               ← model info 构建
│
├── AcpErrors.ts                   ← 启动错误分类（不变）
├── ApprovalStore.ts               ← 不变
└── AcpAgent.ts                    ← 瘦身后的编排层
```

### `@agentclientprotocol/sdk` 使用策略

acpx 使用 SDK 的 `ClientSideConnection` 作为 JSON-RPC 路由核心。AionUi 也应该用它，而不是继续手搓 JSON-RPC。

**SDK 提供的能力（应该用）**：

- `ClientSideConnection` — JSON-RPC 请求/响应/通知路由，包括 `initialize()`、`newSession()`、`loadSession()`、`prompt()`、`cancel()`、`setSessionMode()`、`unstable_setSessionModel()`、`setSessionConfigOption()` 等完整的 ACP 方法
- `PROTOCOL_VERSION` — 协议版本常量
- 完整的 TypeScript 类型（`AnyMessage`、`SessionNotification`、`InitializeResponse`、`PromptResponse` 等）

**AionUi 特有需求（需要在 SDK 之上扩展）**：

- **权限请求期间暂停 prompt 超时**：SDK 的 Connection 没有 timeout 概念，timeout 是 AionUi 在更上层管理的。方案：在 `AcpConnection` 层包装 SDK 的 `prompt()` 调用，用 `Promise.race` + 外部可控的 timer 实现 timeout，权限回调中 pause/resume timer。
- **流式更新时重置超时**：在 `sessionUpdate` 回调中重置 timer（SDK 通过回调暴露了 session update，可以 hook）。
- **消息观察（tap）**：acpx 的 `createTappedStream()` 模式，在 SDK 拿到的 stream 上包一层观察者。

**原则：做正确的事，不做容易的事。** SDK 覆盖了 90% 的协议层需求，剩余 10% 的特化逻辑应该基于 SDK 改造，而不是为了避免改造而不用 SDK。

### 关键拆分

#### AcpTransport（新建）

基于 acpx 的 `createNdJsonMessageStream()` 模式，将子进程 stdio 转为 SDK 需要的 `ReadableStream<AnyMessage>` / `WritableStream<AnyMessage>`。SDK 的 `ClientSideConnection` 接受这对 stream 作为参数。

```typescript
// 构造 ndjson stream → 传入 SDK ClientSideConnection
const stream = createNdJsonMessageStream(child.stdin, child.stdout);
const connection = new ClientSideConnection(handlers, stream);
```

AionUi 特有的消息观察（perf log、debug trace）通过 acpx 的 tapped stream 模式包装。

#### 超时管理（在 AcpConnection 层，不在 SDK 层）

SDK 的 `ClientSideConnection` 不管超时。超时逻辑在 `AcpConnection` 中实现：

```typescript
class AcpConnection {
  private sdkConnection: ClientSideConnection;
  private promptTimer: ResettableTimer | null = null;

  async prompt(sessionId: string, content: string): Promise<PromptResponse> {
    this.promptTimer = new ResettableTimer(this.promptTimeoutMs);

    return Promise.race([
      this.sdkConnection.prompt({ sessionId, prompt: content }),
      this.promptTimer.expired.then(() => {
        this.sdkConnection.cancel({ sessionId });
        throw new TimeoutError('prompt timeout');
      }),
    ]);
  }

  // session update 回调中重置
  private onSessionUpdate(data: SessionNotification) {
    this.promptTimer?.reset();
    // ...
  }

  // 权限请求回调中暂停/恢复
  private async onPermissionRequest(params) {
    this.promptTimer?.pause();
    try {
      return await this.permissionHandler.handle(params);
    } finally {
      this.promptTimer?.resume();
    }
  }
}
```

这比当前 AcpConnection 的 `pauseRequestTimeout` / `resumeRequestTimeout` / `resetSessionPromptTimeouts` 三套 60 行逻辑清晰得多。

#### PermissionHandler（从 AcpAgent 提取）

```typescript
interface IPermissionHandler {
  handle(request: AcpPermissionRequest): Promise<{ optionId: string }>;
  confirm(callId: string, optionId: string): void;
  cancelAll(): void;
}
```

封装 `pendingPermissions` Map、`ApprovalStore` 缓存、超时逻辑、navigation 拦截。

#### SessionManager（从 AcpAgent 提取）

```typescript
interface ISessionManager {
  createOrResume(options: SessionOptions): Promise<{ sessionId: string }>;
  readonly currentSessionId: string | null;
  readonly hasActiveSession: boolean;
}
```

封装三种 resume 策略（Codex session/load、Claude \_meta.resume、通用 resumeSessionId）和 MCP server 注入。

#### 瘦身后的 AcpAgent

拆分后 AcpAgent 只负责编排：

```typescript
class AcpAgent {
  constructor(
    private connection: AcpConnection,
    private session: SessionManager,
    private permissions: PermissionHandler,
    private adapter: AcpAdapter,
    private model: ModelManager,
    private mode: ModeManager
  ) {}

  async start() {
    /* 编排 connection.connect → session.create → mode.apply → model.set */
  }
  async sendMessage(data) {
    /* 编排 atFile.resolve → model.reassert → connection.prompt */
  }
  async kill() {
    /* 编排 connection.disconnect → cleanup */
  }
}
```

## Phase 3：定义抽象接口并包装现有实现

在 Phase 2 的接口基础上，将现有实现包装为接口适配器（Adapter Pattern），使新旧实现可以共存。

```typescript
// 旧实现的适配器
class LegacyAcpConnectionAdapter implements IAcpTransport {
  constructor(private legacy: AcpConnection) {}
  // 将旧 AcpConnection 的行为适配到新接口
}
```

这样新模块可以逐个替换旧模块，不需要一次性切换。

## Phase 4：逐步切换

按风险从低到高的顺序切换：

| 顺序 | 模块                                   | 风险 | 原因                                     |
| ---- | -------------------------------------- | ---- | ---------------------------------------- |
| 1    | `core/` 工具函数                       | 低   | 纯函数，无副作用，容易验证               |
| 2    | `error-shapes` / `error-normalization` | 低   | 替换字符串匹配为结构化分类，行为更好     |
| 3    | `jsonrpc` 消息校验                     | 低   | 添加校验层，不改变现有行为               |
| 4    | `AcpRequestTracker`                    | 中   | 提取逻辑，timeout 行为必须保持一致       |
| 5    | `AcpTransport`                         | 中   | 替换 stdio 处理，需要验证消息流完整性    |
| 6    | `PermissionHandler`                    | 中   | 涉及 UI 交互，需要端到端测试             |
| 7    | `SessionManager`                       | 高   | 涉及三种后端 resume 策略，需要逐后端验证 |
| 8    | `AcpAgent` 瘦身                        | 高   | 最终编排层切换，依赖前面所有模块就绪     |

每个步骤完成后都应该能独立运行和测试，不依赖后续步骤。

## 非目标

以下不在本次重构范围内：

- **不重写 AcpDetector.ts**：Agent 发现逻辑独立且稳定。
- **不重写 AcpAdapter.ts**：session update → TMessage 的转换是纯 AionUi 业务，与协议层无关。
- **不改变外部 API**：`AcpAgent` 的公共方法签名（`start` / `sendMessage` / `kill` / `confirmMessage` 等）保持不变，调用方无感知。

> Note: `acpConnectors.ts`（npx 启动、npm 缓存恢复等）和 `agent-registry`（命令解析策略）的改进待后续分析，不在本轮重构的首要范围内，但不排除在实施过程中一并优化。
