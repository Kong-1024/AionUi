# acpx 实现分析与可复用模块

> Source: [github.com/openclaw/acpx](https://github.com/openclaw/acpx) `src/acp/`
> Version: 0.5.3

acpx 是 OpenClaw 官方的 ACP 命令行客户端工具。其 `src/acp/` 目录实现了一个干净的 ACP 协议客户端，职责划分清晰，业务无关的协议层代码可以直接复用。

## 架构概览

```
src/acp/
├── client.ts                  # AcpClient 主类 — 连接生命周期 + session 管理
├── client-process.ts          # 进程工具函数（命令行解析、spawn 等待、退出检测）
├── jsonrpc.ts                 # JSON-RPC 2.0 消息校验与解析
├── jsonrpc-error.ts           # JSON-RPC 错误响应构建
├── error-shapes.ts            # ACP 错误提取（递归 error/cause/acp 字段）
├── error-normalization.ts     # 错误标准化（分类 + 重试判断 + 退出码映射）
├── session-control-errors.ts  # Session 控制操作错误包装
├── auth-env.ts                # 认证凭证解析（env var → config）
├── agent-command.ts           # Agent 命令识别与适配（Gemini/Claude/Copilot/Qoder）
├── agent-session-id.ts        # Session ID 提取
├── terminal-manager.ts        # 终端管理器（Agent 请求创建的终端进程）
└── codex-compat.ts            # Codex 兼容层
```

核心设计特点：

- **传输层抽象**：通过 `ReadableStream<AnyMessage>` / `WritableStream<AnyMessage>` 抽象 JSON-RPC 传输，子进程 stdio 只是一种实现
- **SDK 依赖**：使用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 处理 JSON-RPC 请求/响应/通知的路由。SDK 提供了完整的 ACP 方法封装（initialize / newSession / loadSession / prompt / cancel / setSessionMode / unstable_setSessionModel / setSessionConfigOption 等），以及全套 TypeScript 类型定义。**AionUi 应该引入这个 SDK，而不是继续手搓 JSON-RPC。**
- **结构化错误**：递归提取 ACP 错误 payload（`{code, message, data}`），按 code 而非文本分类
- **纯函数工具**：协议层工具函数无副作用、无外部依赖，可直接复制

## 可直接复用的模块

以下模块与 acpx 业务逻辑无关，可直接移植到 AionUi。

### 1. `client-process.ts` — 进程工具

约 155 行，零外部依赖（仅 `node:child_process` 和 `node:path`）。

| 函数                                 | 用途                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| `splitCommandLine(value)`            | 命令行解析，支持单/双引号和反斜杠转义                              |
| `waitForSpawn(child)`                | Promise 化的 spawn 等待（spawn/error 事件对）                      |
| `waitForChildExit(child, timeoutMs)` | 带超时的进程退出等待（事件驱动，非轮询）                           |
| `isChildProcessRunning(child)`       | `exitCode == null && signalCode == null`（比 `child.killed` 准确） |
| `basenameToken(value)`               | 提取命令基名并去掉 `.exe/.cmd/.bat` 后缀                           |
| `isoNow()`                           | ISO 时间戳                                                         |
| `asAbsoluteCwd(cwd)`                 | `path.resolve` 封装                                                |

**AionUi 对应**：散布在 `AcpConnection.ts`（内联 spawn 检查）、`utils.ts`（轮询式 waitForProcessExit）、`acpConnectors.ts`（`cliPath.split(' ')` 命令解析）中。

### 2. `jsonrpc.ts` — JSON-RPC 消息解析

约 138 行。严格按 JSON-RPC 2.0 规范校验消息结构。

| 函数                                        | 用途                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAcpJsonRpcMessage(value)`                | 完整的 JSON-RPC 2.0 消息校验（notification / request / response 三路），验证 `jsonrpc: "2.0"`、id 类型（`string \| number \| null`）、error 结构体（`{code: number, message: string}`） |
| `isJsonRpcNotification(message)`            | 区分 notification（有 method 无 id）和 request                                                                                                                                          |
| `isSessionUpdateNotification(message)`      | 判断 `method === 'session/update'`                                                                                                                                                      |
| `extractSessionUpdateNotification(message)` | 安全提取 `{sessionId, update}`                                                                                                                                                          |
| `parsePromptStopReason(message)`            | 从 response.result 提取 `stopReason`                                                                                                                                                    |
| `parseJsonRpcErrorMessage(message)`         | 从 response.error 提取 `message`                                                                                                                                                        |

**AionUi 对应**：完全缺失。`AcpConnection.handleMessage()` 直接用 `'method' in message` / `'id' in message` 判断，没有校验 jsonrpc 版本、id 类型、error 结构。

### 3. `error-shapes.ts` — ACP 错误提取

约 154 行。从各种形式的错误对象中提取结构化的 ACP error payload。

| 函数                                | 用途                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `extractAcpError(error)`            | 递归（最多 5 层）从 `error` / `cause` / `acp` 字段中提取 `{code: number, message: string, data?: unknown}` 格式的 ACP 错误 |
| `formatUnknownErrorMessage(error)`  | 通用的 unknown → string 转换，处理 Error 实例、带 message 的对象、JSON.stringify fallback、最终 `String()` 四级降级        |
| `isAcpResourceNotFoundError(error)` | 检测 session 丢失（code -32001/-32002 + 文本匹配兜底）                                                                     |

**`extractAcpError()` 是最有价值的单个函数**。AionUi 当前收到 error response 时只做 `message.error?.message || 'Unknown ACP error'`，丢失了 code 和 data，导致后续无法按 code 分类错误。

### 4. `error-normalization.ts` — 错误标准化

约 288 行。将各种错误统一为结构化的 `NormalizedOutputError`：

```typescript
type NormalizedOutputError = {
  code: OutputErrorCode; // RUNTIME | TIMEOUT | NO_SESSION | PERMISSION_DENIED | ...
  message: string;
  detailCode?: string; // AUTH_REQUIRED 等细分码
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: { code: number; message: string; data?: unknown };
};
```

关键函数：

| 函数                                   | 用途                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `normalizeOutputError(error, options)` | 错误标准化入口：`extractAcpError()` → 错误类型映射 → 组装结构体                                    |
| `isRetryablePromptError(error)`        | 判断 prompt 错误是否可重试（ACP -32603/-32700 可重试；auth/session-not-found/permission 不可重试） |
| `exitCodeForOutputErrorCode(code)`     | 错误码到进程退出码的映射                                                                           |

**AionUi 对应**：用字符串 `includes()` 匹配代替。没有重试判断能力。

### 5. `jsonrpc-error.ts` — JSON-RPC 错误响应构建

约 88 行。根据错误类型构建规范的 JSON-RPC 2.0 error response。

| 函数                                | 用途                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `buildJsonRpcErrorResponse(params)` | 优先透传原始 ACP error payload，否则根据 `OutputErrorCode` 选择正确的 JSON-RPC error code 并构建 data 字段 |

错误码映射表：

```typescript
NO_SESSION: -32002;
TIMEOUT: -32070;
PERMISSION_DENIED: -32071;
PERMISSION_PROMPT_UNAVAILABLE: -32072;
RUNTIME: -32603;
USAGE: -32602;
```

**AionUi 对应**：硬编码 `{ code: -32603, message: ... }`，所有错误都报为 Internal error。

### 6. `session-control-errors.ts` — Session 控制错误

约 64 行。包装 `session/set_mode`、`session/set_model`、`session/set_config_option` 的错误。

| 函数                                                   | 用途                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `maybeWrapSessionControlError(method, error, context)` | 检测 agent 不支持该 session 控制方法（code -32601/-32602），包装为友好的错误消息 |
| `formatSessionControlAcpSummary(acp)`                  | 从 ACP error 的 data.details 提取人类可读摘要                                    |

**AionUi 对应**：`setSessionMode` / `setModel` / `setConfigOption` 都是简单 try-catch + `console.warn`，没有区分 "agent 不支持" 和 "参数错误" 等情况。

## 设计模式值得借鉴但不直接复制的

以下部分的代码不能直接复制，但设计模式值得参考。

### AcpClient 连接管理模式

acpx `client.ts` 的 `AcpClient` 类：

- **pendingConnectionRequests**：跟踪所有 in-flight 的 JSON-RPC 请求，agent 断开时批量 reject。AionUi 的 `handleProcessExit` 做了类似的事情，但 acpx 的实现更干净（`runConnectionRequest` 包装每个请求，统一注册/清理）。
- **三级关闭**：`close()` 先 `stdin.end()`（最优雅），等待超时后 `SIGTERM`，再超时后 `SIGKILL`。AionUi 的 `killChild` 直接 `SIGTERM` → `SIGKILL`，缺少 stdin 关闭这个最优雅的阶段。
- **Tapped stream**：`createTappedStream()` 在不修改原始 stream 的情况下插入 inbound/outbound 消息观察，用于调试和事件通知。AionUi 没有等价机制。

### ndjson 消息流

acpx 的 `createNdJsonMessageStream()` 将子进程 stdio 转为 `ReadableStream<AnyMessage>` / `WritableStream<AnyMessage>`，实现了传输层抽象和背压控制。AionUi 直接在 `stdout.on('data')` 回调里 `JSON.parse`。

### Agent 生命周期观察

`attachAgentLifecycleObservers()` 统一监听 `exit` / `close` / `stdout.close` 三个事件，只记录第一次（`recordAgentExit` 幂等），维护 `AgentExitInfo` 快照。AionUi 只监听了 `exit` 事件。

### Agent Registry 命令解析策略（`src/agent-registry.ts`）

acpx 的 agent 启动不是直接跑 `npx`，而是用**两级解析策略**：

```
resolveBuiltInAgentLaunch(agentCommand)
  ├── 1. resolveInstalledBuiltInAgentLaunch()  → source: "installed"
  │     找 node_modules 里已安装的包，直接用 process.execPath 执行 bin 文件
  │
  └── 2. resolvePackageExecBuiltInAgentLaunch() → source: "package-exec"
        找 npm-cli.js，用 `npm exec --yes --package=<pkg>@<range>` 动态拉取
```

#### Agent 注册表

`AGENT_REGISTRY` 维护了所有已知 agent 的命令映射（约 15 个）：

```typescript
export const AGENT_REGISTRY: Record<string, string> = {
  pi: 'npx pi-acp@^0.0.22',
  openclaw: 'openclaw acp',
  codex: 'npx @zed-industries/codex-acp@^0.11.1',
  claude: 'npx -y @agentclientprotocol/claude-agent-acp@^0.25.0',
  gemini: 'gemini --acp',
  cursor: 'cursor-agent acp',
  copilot: 'copilot --acp --stdio',
  droid: 'droid exec --output-format acp',
  // ... qwen, kimi, kiro, opencode, qoder, trae, kilocode, iflow
};
```

其中 codex 和 claude 是 npx 包，有专门的 `BUILT_IN_AGENT_PACKAGES` 定义（包含 packageName、packageRange、preferredBinName）。

#### 解析优先级

1. **installed**（优先）：从当前文件位置向上遍历目录树，找 `node_modules/<package>/package.json`，读取 bin 字段，用 `process.execPath`（当前 Node 进程）直接执行 bin 文件。
   - 优点：零网络、零延迟，版本确定
   - 命令形如：`/usr/local/bin/node /path/to/node_modules/@zed-industries/codex-acp/bin/codex-acp`

2. **package-exec**（兜底）：找到 Node 安装目录下的 `npm-cli.js`，构造 `npm exec --yes --package=<pkg>@<range> -- <bin>` 命令。
   - 优点：不依赖 npx shim（绕过 `.cmd` 和 PATH 问题），版本范围可控
   - 命令形如：`/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js exec --yes --package=@zed-industries/codex-acp@^0.11.1 -- codex-acp`

#### 其他设计亮点

- **alias 支持**：`factory-droid` / `factorydroid` → `droid`
- **registry 可覆盖**：`mergeAgentRegistry(overrides)` 允许用户配置覆盖内置命令
- **DI 友好**：resolver 函数接受 `options`（existsSync、readFileSync、resolvePackageRoot），方便单元测试
- **不依赖 npx shim**：package-exec 模式直接调用 `npm-cli.js`，完全绕过 npx 的 `.cmd` shim 问题（Windows 上 `%~dp0` 路径解析经常出错）

#### 与 AionUi `acpConnectors.ts` 的对比

| 维度          | acpx agent-registry                   | AionUi acpConnectors                                        |
| ------------- | ------------------------------------- | ----------------------------------------------------------- |
| npx 启动      | 优先本地已安装 → 兜底 `npm exec`      | `npx --prefer-offline` → retry without offline（Phase 1/2） |
| npx shim 问题 | 直接调用 `npm-cli.js` 绕过            | Windows 上用 `chcp 65001 >nul && "npxCommand"` workaround   |
| 缓存问题      | 不存在（installed 路径不走缓存）      | 检测 stale cache / corrupted \_npx 目录 → 清理重试          |
| 版本管理      | `packageRange` 在代码中集中定义       | 版本号散布在 `CLAUDE_ACP_NPX_PACKAGE` 等常量中              |
| 平台处理      | DI 方式注入 `existsSync` 等，平台无关 | 大量 `process.platform === 'win32'` 分支                    |
| 可测试性      | 所有 resolver 接受 options 注入       | 直接调用 `spawn`，难以单元测试                              |

acpx 的策略更优雅，但 AionUi 的复杂度部分来自桌面应用的现实（用户环境千差万别、npx cache 经常腐败）。后续可以考虑借鉴 acpx 的 installed-first 策略减少对 npx 的依赖。
