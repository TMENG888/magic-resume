import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_LOG_FIELD_LIMIT,
  AGENT_LOG_SCHEMA_VERSION,
  type AgentLogRecord,
} from "@/lib/agent/log-types";
import type { AIConnection } from "@/config/ai-models";

/**
 * PI 智能体日志落盘（JSONL，按天分文件）。
 *
 * 目录：<process.cwd()>/logs/agent/
 * 文件：agent-YYYY-MM-DD.jsonl（服务器本地时区日期，一行一条 JSON 记录）
 *
 * - 永不写入 apiKey；
 * - 超长字段截断（AGENT_LOG_FIELD_LIMIT），保证单条记录可控；
 * - 写入失败绝不抛出（日志是旁路能力，不影响智能体主流程）。
 */

const FIELD_LIMIT = AGENT_LOG_FIELD_LIMIT;

export function localDayString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function sha256(text: string): string | undefined {
  try {
    return createHash("sha256").update(text, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

/** 连接信息脱敏（剥离 apiKey 等敏感字段） */
export function sanitizeConnection(connection: AIConnection | undefined) {
  if (!connection) return { provider: "unknown", protocol: "unknown", model: "unknown" };
  return {
    provider: String(connection.provider ?? "unknown"),
    protocol: String(connection.protocol ?? "unknown"),
    model: String(connection.model ?? "unknown"),
  };
}

/** 截断超长文本字段 */
export function truncateField(text: unknown, limit: number = FIELD_LIMIT): string {
  const value = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  return value.length > limit ? `${value.slice(0, limit)}…（日志截断，原始长度 ${value.length}）` : value;
}

/** 从上游原始响应中尽力提取 token 用量（各协议字段不同） */
export function extractUsage(protocol: string, raw: unknown): unknown | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const data = raw as Record<string, unknown>;
  if (protocol === "gemini" && data.usageMetadata) return data.usageMetadata;
  if (data.usage) return data.usage;
  if (data.usage_metadata) return data.usage_metadata;
  return undefined;
}

/**
 * 追加一条智能体日志到当天的 JSONL 文件。
 * 返回写入结果（供 /api/agent-log 响应），内部吞掉所有异常。
 */
export async function appendAgentLog(
  record: AgentLogRecord,
): Promise<{ ok: boolean; file?: string; reason?: string }> {
  try {
    const dir = path.join(process.cwd(), "logs", "agent");
    await mkdir(dir, { recursive: true });
    const day = localDayString();
    const file = path.join(dir, `agent-${day}.jsonl`);
    const line = `${JSON.stringify({ ...record, day })}\n`;
    await appendFile(file, line, "utf8");
    return { ok: true, file: `logs/agent/agent-${day}.jsonl` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 服务端补全完成后的旁路记录（fire-and-forget） */
export function logAgentCompletion(input: {
  connection: AIConnection | undefined;
  system: string;
  transcript: string;
  rawOutput?: string;
  rawJson?: unknown;
  durationMs: number;
  error?: { code: string; message: string };
}): void {
  const { connection, system, transcript, rawOutput, rawJson, durationMs, error } = input;
  void appendAgentLog({
    type: "completion",
    ts: new Date().toISOString(),
    schemaVersion: AGENT_LOG_SCHEMA_VERSION,
    ...sanitizeConnection(connection),
    systemChars: system.length,
    transcriptChars: transcript.length,
    transcript: truncateField(transcript),
    rawOutput: truncateField(rawOutput ?? ""),
    usage: rawJson ? extractUsage(String(connection?.protocol ?? ""), rawJson) : undefined,
    durationMs,
    error,
  }).catch(() => {});
}
