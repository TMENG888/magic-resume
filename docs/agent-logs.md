# PI 智能体执行日志（按天 JSONL）

智能体每次执行回合的**记忆、思考（每轮补全的完整输入/输出）、工具调用链、最终回复**会自动落盘到本目录，用于后续 agent 调优（prompt 迭代、失败案例挖掘、工具链分析、成本观测）。

## 位置与格式

```
logs/agent/
  agent-2026-02-11.jsonl   ← 服务器本地时区按天分文件，一行一条 JSON 记录
  agent-2026-02-12.jsonl
```

已在 `.gitignore` 排除（`/logs/`），仅本地留存。

## 记录类型

### 1. `agent_turn`（客户端上报，回合级完整链路）

每次用户向智能体发送消息后产生一条，包含：

| 字段 | 说明 |
|---|---|
| `sessionId` / `turnId` | 面板会话 id（清空对话后更换）/ 回合 id |
| `provider` / `protocol` / `model` | 模型配置（**永不记录 apiKey**） |
| `resumeTitle` | 操作的简历标题 |
| `attachments` | 附件引用（source: materials/local + 路径） |
| `userMessage` | 用户原始输入 |
| `materialContext` | 附件上下文：字符数、SHA-256 指纹、≤4k 字符样本 |
| `systemChars` | 系统提示词长度（关联 prompt 版本） |
| `rounds[]` | **每轮思考**：`transcript`（含记忆与 tool_result 的完整输入，≤60k 截断）、`rawOutput`（模型原始输出）、`parseOk`、`action`/`reply`、`durationMs` |
| `toolCalls[]` | **工具调用链**：tool、args、ok、summary、resultChars、error、durationMs |
| `historyTurns` | 进入本回合前的会话记忆条数 |
| `final.reply` / `status` | 最终回复；`final`/`error`/`aborted`/`max_rounds` |
| `totalDurationMs` | 回合总耗时 |

### 2. `completion`（服务端兜底，每次补全一条）

`/api/agent-chat` 每次调用产生的原始 I/O：`transcript`、`rawOutput`、`usage`（token 用量，按协议尽力提取）、`durationMs`、`error{code,message}`。即使客户端崩溃/断网，服务端也有完整请求记录。

## 调优用法示例

```bash
# 提取所有解析失败（模型没输出合法 ReAct JSON）的案例
jq -c 'select(.rounds[]?.parseOk == false)' logs/agent/agent-*.jsonl

# 找出工具执行失败的调用
jq -c '.toolCalls[]? | select(.ok == false)' logs/agent/agent-*.jsonl

# 统计每日回合数 / 工具调用分布
jq -r 'select(.type=="agent_turn") | .toolCalls[].tool' logs/agent/agent-$(date +%F).jsonl | sort | uniq -c

# 导出「用户输入 → 最终回复」微调对
jq -r 'select(.type=="agent_turn" and .status=="final") | [.userMessage, .final.reply] | @json' logs/agent/agent-*.jsonl

# 找出达到最大轮次仍未完成的回合（仅旧版日志存在；现行无轮次上限，靠用户中止）
jq -c 'select(.status=="max_rounds") | {turnId, rounds: (.rounds|length), tools: [.toolCalls[].tool]}' logs/agent/agent-*.jsonl

# 中止回合（用户点停止/清空对话）
jq -c 'select(.status=="aborted") | {turnId, rounds: (.rounds|length)}' logs/agent/agent-*.jsonl

# 修复器救回的畸形输出统计（模型格式质量信号）
jq -c 'select(.rounds[]?.repaired == true) | {turnId, model}' logs/agent/agent-*.jsonl
```

## 相关代码

- 采集：`src/lib/agent/agentClient.ts`（rounds/toolCalls trace）
- 上报：`src/lib/agent/turnLogger.ts`（fire-and-forget，不影响对话）
- 落盘：`src/lib/server/agent-logger.ts`（脱敏、截断、按天追加）
- 端点：`/api/agent-log`（客户端回合记录）、`/api/agent-chat`（服务端补全记录）
