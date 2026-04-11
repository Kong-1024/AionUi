# AionUi ACP 层现状问题

> Source: `src/process/agent/acp/`

## 1. AcpAgent — 上帝类（index.ts, ~1765 行）

`AcpAgent` 承担了几乎所有职责，是典型的 God Object：

- ACP 连接生命周期（start / kill / auto-reconnect）
- 认证流程（performAuthentication / ensureQwenAuth / ensureClaudeAuth）
- 消息发送 + `@` 文件引用解析 + 工作区文件搜索
- 权限请求处理 + ApprovalStore 缓存 + 超时管理
- 导航工具拦截（chrome-devtools URL 提取 + preview_open 事件）
- Model 切换 + `<system-reminder>` 注入通知 AI model 已变更
- Session update 分发 → UI 事件（content / thought / tool_call / plan）
- 状态消息 / 错误消息 emit
- YOLO mode / session mode 管理
- MCP server 注入（builtin / team / aion）
- Session resume（三种后端三种策略）
- Prompt 超时配置读取

任何单一职责的修改都需要在这个 1765 行的文件中定位和理解上下文，增加了维护成本和引入 bug 的风险。

## 2. AcpConnection — 手搓 JSON-RPC（~1107 行）

AcpConnection 手写了完整的 JSON-RPC 2.0 客户端，没有使用 `@agentclientprotocol/sdk` 或任何 JSON-RPC 库。

### 2.1 无消息校验

收到的 JSON 直接按字段存在性分发，没有校验 `jsonrpc: "2.0"` 版本号、id 类型、error 结构体等：

```typescript
// AcpConnection.ts:612
if ('method' in message) {
  this.handleIncomingRequest(message as AcpIncomingMessage);
} else if ('id' in message && typeof message.id === 'number') {
  // response
}
```

对比 JSON-RPC 2.0 规范，response 的 id 可以是 `string | number | null`，notification 的特征是有 `method` 且无 `id`。当前实现对这些边界情况没有处理。

### 2.2 超时管理复杂度高

为了在权限请求期间暂停 prompt 超时，实现了 pause / resume / reset 三套机制（约 70 行），相互交织在 `sendRequest`、`handlePermissionRequest`、`handleIncomingRequest` 中：

- `pauseRequestTimeout(id)` / `resumeRequestTimeout(id)` — 单个请求
- `pauseSessionPromptTimeouts()` / `resumeSessionPromptTimeouts()` — 批量
- `resetSessionPromptTimeouts()` — 收到流式更新时重置

这些逻辑散布在连接层中，与 JSON-RPC 传输职责混在一起。

### 2.3 错误响应硬编码

向 agent 返回错误时，固定使用 `-32603`（Internal error）：

```typescript
this.sendResponseMessage({
  jsonrpc: JSONRPC_VERSION,
  id: message.id,
  error: { code: -32603, message: error.message },
});
```

没有根据错误类型选择合适的 JSON-RPC error code（如 -32601 Method not found、-32602 Invalid params）。

### 2.4 无背压控制

`child.stdout.on('data')` 直接 JSON.parse + handleMessage，没有 ReadableStream / WritableStream 的背压机制。大量 session update 可能导致事件积压。

## 3. 错误处理 — 字符串匹配

`AcpAgent.sendMessage()` 中的错误分类完全依赖字符串包含判断：

```typescript
if (errorMsg.includes('authentication') || errorMsg.includes('认证失败') || errorMsg.includes('[ACP-AUTH-')) {
  errorType = AcpErrorType.AUTHENTICATION_FAILED;
} else if (errorMsg.includes('timeout') || errorMsg.includes('Timeout') || errorMsg.includes('timed out')) {
  errorType = AcpErrorType.TIMEOUT;
} else if (errorMsg.includes('permission') || errorMsg.includes('Permission')) {
  errorType = AcpErrorType.PERMISSION_DENIED;
} else if (errorMsg.includes('connection') || errorMsg.includes('Connection')) {
  errorType = AcpErrorType.NETWORK_ERROR;
}
```

问题：

- **脆弱**：错误消息文本随上游依赖版本变化
- **大小写敏感**：`'Timeout'` vs `'timeout'` 需要逐个列举
- **混合语言**：中文 `'认证失败'` 写死在协议层
- **丢失结构化信息**：ACP 错误响应本身有 `code`（如 -32001, -32603），完全没有利用
- **没有重试判断**：无法区分瞬态错误（网络中断、模型 API 500）和永久错误（认证失败、session 不存在）

## 4. 进程管理工具零散

进程生命周期相关的工具函数分散在多个文件中，风格不一致：

| 功能           | 位置                             | 问题                                                             |
| -------------- | -------------------------------- | ---------------------------------------------------------------- |
| 进程存活检查   | `utils.ts: isProcessAlive()`     | 用 `process.kill(pid, 0)` 信号探测                               |
| 等待进程退出   | `utils.ts: waitForProcessExit()` | 50ms 轮询，不是事件驱动                                          |
| 杀进程         | `utils.ts: killChild()`          | 平台特化（taskkill / SIGTERM→SIGKILL），但耦合了 descendant 收集 |
| 子进程运行检查 | `AcpConnection.ts` 内联          | `child.killed` 判断（不准确）                                    |
| spawn 等待     | `AcpConnection.ts` 内联          | `setImmediate` + 检查 `spawnError`，非标准模式                   |
| 命令行解析     | `acpConnectors.ts` 内联          | `cliPath.split(' ')` 散装写法，不支持引号                        |

## 5. 职责边界模糊

当前文件之间的职责划分不清晰：

- **AcpConnection** 既管连接也管 session（newSession / loadSession / sendPrompt / setModel / setConfigOption / setSessionMode / cancelPrompt），还直接处理文件读写请求
- **AcpAgent** 既是业务编排层也直接操作连接细节（注入 `<system-reminder>`、处理 `@` 文件引用）
- **utils.ts** 混合了进程管理（killChild）、文件 I/O（readTextFile / writeTextFile）、Claude 配置读取（readClaudeSettings / getClaudeModel）三类完全不相关的功能
- **acpConnectors.ts** 既有通用 spawn 逻辑（createGenericSpawnConfig）也有 npx 后端特化逻辑（prepareClaude / prepareCodex / prepareCodebuddy），还有环境变量清理（prepareCleanEnv）和 Node 版本检查（ensureMinNodeVersion）

## 6. 缺少协议层抽象

没有独立的 JSON-RPC 传输层抽象。如果未来需要支持非 stdio 传输（如 WebSocket、HTTP SSE），需要重写 AcpConnection 的大部分代码。acpx 通过 `ReadableStream<AnyMessage>` / `WritableStream<AnyMessage>` 抽象了传输层，切换传输方式只需替换 stream 构造。
