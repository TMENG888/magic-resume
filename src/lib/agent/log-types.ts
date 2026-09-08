import type { MaterialAttachment } from "@/lib/material-context";

/**
 * PI 智能体执行日志类型（客户端构建 / 服务端落盘共用）。
 *
 * 落盘位置：<项目根>/logs/agent/agent-YYYY-MM-DD.jsonl（JSONL，一行一条记录）
 *  - type: "agent_turn"  —— 客户端上报的完整回合（含记忆、思考、工具调用链）
 *  - type: "completion"  —— 服务端 /api/agent-chat 每次补全的原始 I/O（兜底与用量分析）
 *
 * 隐私约定：任何记录不得包含 apiKey / 用户简历之外的敏感凭据。
 */

export const AGENT_LOG_SCHEMA_VERSION = 1;

/** 单轮补全（思考）记录 */
export interface AgentRoundLog {
  /** 第几轮（从 1 开始） */
  round: number;
  /** 该轮发给模型的完整对话记录（含记忆与 tool_result，超长截断） */
  transcript: string;
  /** 模型原始输出（ReAct JSON 或降级文本，超长截断） */
  rawOutput: string;
  /** JSON 解析是否成功 */
  parseOk: boolean;
  /** 解析出的动作（若有） */
  action?: { tool: string; args?: Record<string, unknown> };
  /** 解析出的最终回复（若有） */
  reply?: string;
  /** 是否经过容错修复（衡量模型输出格式质量） */
  repaired?: boolean;
  /** 解析/协议失败原因（若有） */
  parseError?: string;
  /** 本轮补全耗时 ms */
  durationMs: number;
}

/** 单次工具调用记录 */
export interface AgentToolCallLog {
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  /** 结果摘要（工具返回的 summary） */
  summary: string;
  /** 结果数据字符数（衡量返回体量） */
  resultChars?: number;
  /** 执行失败信息（若有） */
  error?: string;
  /** 执行耗时 ms */
  durationMs: number;
}

/** 客户端上报的回合级日志 */
export interface AgentTurnLogRecord {
  type: "agent_turn";
  ts: string;
  schemaVersion: number;
  sessionId: string;
  turnId: string;
  /** 模型配置（不含 apiKey） */
  provider: string;
  protocol: string;
  model: string;
  /** 简历上下文 */
  resumeTitle: string;
  /** 附件（我的资料 / 本地文件路径引用） */
  attachments: MaterialAttachment[];
  /** 用户原始输入 */
  userMessage: string;
  /** 附件上下文块统计 */
  materialContext?: {
    chars: number;
    sha256?: string;
    /** 完整内容样本（超长截断） */
    sample?: string;
  };
  /** 系统提示词字符数（调优时关联 prompt 版本） */
  systemChars: number;
  /** 各轮思考与工具链 */
  rounds: AgentRoundLog[];
  toolCalls: AgentToolCallLog[];
  /** 会话记忆（进入本回合前的历史） */
  historyTurns: number;
  /** 本回合内纠正重试次数（格式异常反馈重试） */
  correctiveRetries?: number;
  final?: { reply: string };
  /** final | error | aborted | max_rounds（max_rounds 仅旧版日志兼容，现行无轮次上限） */
  status: "final" | "error" | "aborted" | "max_rounds";
  errorMessage?: string;
  totalDurationMs: number;
  /** 浏览器环境（调试用） */
  ua?: string;
}

/** 服务端补全级日志 */
export interface AgentCompletionLogRecord {
  type: "completion";
  ts: string;
  schemaVersion: number;
  provider: string;
  protocol: string;
  model: string;
  systemChars: number;
  transcriptChars: number;
  transcript: string;
  rawOutput: string;
  /** 上游返回的 token 用量（协议不同字段不同，原样保留） */
  usage?: unknown;
  durationMs: number;
  error?: { code: string; message: string };
}

export type AgentLogRecord = AgentTurnLogRecord | AgentCompletionLogRecord;

export const AGENT_LOG_FIELD_LIMIT = 60_000;

export function isAgentLogRecord(value: unknown): value is AgentLogRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.type === "agent_turn" || record.type === "completion") &&
    typeof record.ts === "string" &&
    typeof record.schemaVersion === "number"
  );
}
