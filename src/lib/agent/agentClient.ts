import { buildMaterialContextBlock, type MaterialAttachment } from "@/lib/material-context";
import { executeAgentTool } from "./tools";
import { buildAgentSystemPrompt } from "./prompts";
import { tryParseReActOutput } from "./json-repair";
import { reportAgentTurn, sha256Hex } from "./turnLogger";
import {
  AGENT_LOG_FIELD_LIMIT,
  AGENT_LOG_SCHEMA_VERSION,
  type AgentRoundLog,
  type AgentToolCallLog,
} from "./log-types";
import type { AIConnection } from "@/config/ai-models";

/**
 * PI 智能体客户端循环。
 *
 * 采用客户端驱动的 ReAct 循环（与 PI Agent 一致：无工具调用轮次上限）：
 *  transcript → /api/agent-chat（一次补全）→ 解析 JSON
 *    → action: 浏览器端执行工具 → 回填 [tool_result] → 下一轮
 *    → reply:  结束，展示给用户
 * 终止条件：模型输出 reply / 发生错误 / 用户中止（signal）。
 */

export interface AgentTurn {
  role: "user" | "assistant" | "tool_result";
  content: string;
}

export type AgentEvent =
  | { type: "round_start"; round: number }
  | { type: "tool_start"; tool: string }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string }
  | { type: "notice"; message: string }
  | { type: "final"; reply: string }
  | { type: "error"; message: string };

const TOOL_RESULT_CHAR_LIMIT = 12_000;
/** 解析/协议失败时自动纠正重试的最大次数（仅针对格式异常反馈，非工具调用轮次限制） */
const MAX_CORRECTIVE_RETRIES = 1;

const renderTurn = (turn: AgentTurn) => `[${turn.role}] ${turn.content}`;

const renderTranscript = (turns: AgentTurn[]) => turns.map(renderTurn).join("\n\n");

function stringifyToolData(data: unknown): string {
  if (data == null) return "";
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return text.length > TOOL_RESULT_CHAR_LIMIT
    ? `${text.slice(0, TOOL_RESULT_CHAR_LIMIT)}…（过长已截断）`
    : text;
}

export interface RunAgentOptions {
  history: AgentTurn[];
  userMessage: string;
  attachments: MaterialAttachment[];
  connection: AIConnection;
  resumeTitle: string;
  signal?: AbortSignal;
  /** 会话 id（同一面板会话内的多次回合共享，用于日志归组） */
  sessionId?: string;
  onEvent: (event: AgentEvent) => void;
}

const truncateLogField = (text: string) =>
  text.length > AGENT_LOG_FIELD_LIMIT
    ? `${text.slice(0, AGENT_LOG_FIELD_LIMIT)}…（日志截断，原始长度 ${text.length}）`
    : text;

export async function runAgentTurn(options: RunAgentOptions): Promise<void> {
  const { history, userMessage, attachments, connection, resumeTitle, signal, sessionId, onEvent } = options;
  const startedAt = Date.now();
  const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // —— 日志采集（旁路）：回合级 trace，结束时上报 /api/agent-log ——
  const roundLogs: AgentRoundLog[] = [];
  const toolLogs: AgentToolCallLog[] = [];
  let systemPrompt = "";
  let materialContextInfo: { chars: number; sha256?: string; sample?: string } | undefined;
  let outcome: { status: "final" | "error" | "aborted" | "max_rounds"; final?: { reply: string }; errorMessage?: string } = {
    status: "error",
  };
  // 注："max_rounds" 仅为旧版日志兼容保留，现行循环无轮次上限
  let correctiveRetries = 0;

  const reportTurnLog = async () => {
    try {
      await reportAgentTurn({
        type: "agent_turn",
        ts: new Date().toISOString(),
        schemaVersion: AGENT_LOG_SCHEMA_VERSION,
        sessionId: sessionId || "unknown-session",
        turnId,
        provider: String(connection.provider),
        protocol: String(connection.protocol),
        model: String(connection.model),
        resumeTitle,
        attachments,
        userMessage: truncateLogField(userMessage),
        materialContext: materialContextInfo,
        systemChars: systemPrompt.length,
        rounds: roundLogs,
        toolCalls: toolLogs,
        historyTurns: history.length,
        correctiveRetries,
        final: outcome.final,
        status: outcome.status,
        errorMessage: outcome.errorMessage,
        totalDurationMs: Date.now() - startedAt,
        ua: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      });
    } catch {
      // 日志上报失败静默忽略
    }
  };

  const system = buildAgentSystemPrompt(resumeTitle);
  systemPrompt = system;

  // 组装本轮用户消息：附件上下文 + 用户输入
  let contextBlock = "";
  try {
    contextBlock = await buildMaterialContextBlock(attachments, { totalCharLimit: 40_000 });
  } catch (error) {
    onEvent({ type: "error", message: `附件读取失败：${error instanceof Error ? error.message : String(error)}` });
    outcome = {
      status: "error",
      errorMessage: `附件读取失败：${error instanceof Error ? error.message : String(error)}`,
    };
    await reportTurnLog();
    return;
  }
  if (contextBlock) {
    void sha256Hex(contextBlock).then((sha256) => {
      materialContextInfo = {
        chars: contextBlock.length,
        sha256,
        sample: truncateLogField(contextBlock.slice(0, 4000)),
      };
    });
  } else {
    materialContextInfo = { chars: 0 };
  }
  const composedUser = contextBlock
    ? `${userMessage}\n\n${contextBlock}`
    : userMessage;

  const turns: AgentTurn[] = [...history, { role: "user", content: composedUser }];

  /**
   * 解析/协议失败统一处理：
   * 返回 true = 回合已终结（调用方 return）；false = 已回填纠正消息（调用方 continue 下一轮）。
   */
  const handleProtocolFailure = async (params: {
    round: number;
    roundTranscript: string;
    rawOutput: string;
    roundStartedAt: number;
    parseOk: boolean;
    parseError: string;
  }): Promise<boolean> => {
    const { round, roundTranscript, rawOutput, roundStartedAt, parseOk, parseError } = params;
    roundLogs.push({
      round,
      transcript: truncateLogField(roundTranscript),
      rawOutput: truncateLogField(rawOutput),
      parseOk,
      parseError,
      durationMs: Date.now() - roundStartedAt,
    });
    // 纠正重试：把失败原因反馈给模型，要求重新输出（无轮次上限，仅受纠正次数与用户中止约束）
    if (correctiveRetries < MAX_CORRECTIVE_RETRIES) {
      correctiveRetries += 1;
      turns.push({ role: "assistant", content: rawOutput });
      turns.push({
        role: "user",
        content:
          `系统提示：你上一轮的输出不符合要求（${parseError}）。请严格只输出一个 JSON 对象：需要调用工具时输出 {"action": {"tool": "工具名", "args": {...}}}；信息足够时输出 {"reply": "最终回复"}。不要输出任何其它文本、注释或代码围栏，确保 JSON 完整闭合。输出一个 JSON 后立即停止：禁止续写 [tool_result] 或 [assistant] 等后续内容，禁止伪造工具结果——工具由系统真实执行，结果由系统回填。`,
      });
      onEvent({ type: "notice", message: `模型输出格式异常，已自动纠正重试（${correctiveRetries}/${MAX_CORRECTIVE_RETRIES}）` });
      return false;
    }
    // 重试后仍失败：友好提示，不暴露内部协议原文
    const looksLikeAction = /"action"\s*:|"(get_resume|update_resume|list_resume_sections|toggle_resume_section|set_resume_theme|list_materials|read_material)"\s*:/.test(rawOutput);
    const reply = looksLikeAction
      ? "（模型返回的数据格式异常，未能执行操作。请重新发送消息重试，或在「AI 服务商」页更换模型）"
      : rawOutput.trim() || "（模型未返回有效内容，请重试）";
    outcome = { status: "final", final: { reply }, errorMessage: `${parseError}（纠正重试后仍失败）` };
    onEvent({ type: "final", reply });
    await reportTurnLog();
    return true;
  };

  let round = 0;
  while (true) {
    // 用户中止（停止按钮/清空对话）随时退出，与 PI Agent 一致不设轮次上限
    if (signal?.aborted) {
      outcome = { status: "aborted" };
      await reportTurnLog();
      return;
    }
    round += 1;
    onEvent({ type: "round_start", round });
    const roundStartedAt = Date.now();
    const roundTranscript = renderTranscript(turns);
    let output = "";
    try {
      const response = await fetch("/api/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection, system, transcript: roundTranscript }),
        signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? response.status;
        throw new Error(`AI 请求失败（${code}）`);
      }
      const payload = (await response.json()) as { output?: string };
      output = payload.output ?? "";
    } catch (error) {
      if (signal?.aborted) {
        outcome = { status: "aborted" };
      } else {
        const message = error instanceof Error ? error.message : "AI 请求失败";
        outcome = { status: "error", errorMessage: message };
        onEvent({ type: "error", message });
      }
      roundLogs.push({
        round,
        transcript: truncateLogField(roundTranscript),
        rawOutput: "",
        parseOk: false,
        durationMs: Date.now() - roundStartedAt,
      });
      await reportTurnLog();
      return;
    }

    // 解析 ReAct JSON（带容错修复，见 json-repair.ts）。
    // 解析/协议失败时先纠正重试，绝不把内部协议原文直接展示给用户。
    const parseResult = tryParseReActOutput(output);
    const candidate = parseResult?.parsed as
      | { reply?: string; action?: { tool?: string; args?: Record<string, unknown> } }
      | undefined;

    // 第一层：JSON 解析失败或结构不合法 → 纠正重试
    // 第一层：JSON 解析彻底失败 → 纠正重试
    if (!candidate) {
      const finished = await handleProtocolFailure({
        round,
        roundTranscript,
        rawOutput: output,
        roundStartedAt,
        parseOk: false,
        parseError: "模型输出不是合法 JSON（缺少闭合括号或混入多余字符）",
      });
      if (finished) return;
      continue;
    }

    const replyText = typeof candidate.reply === "string" ? candidate.reply.trim() : "";
    if (replyText) {
      turns.push({ role: "assistant", content: output });
      const reply = replyText;
      outcome = { status: "final", final: { reply } };
      roundLogs.push({
        round,
        transcript: truncateLogField(roundTranscript),
        rawOutput: truncateLogField(output),
        parseOk: true,
        repaired: !!parseResult?.repaired,
        reply,
        durationMs: Date.now() - roundStartedAt,
      });
      onEvent({ type: "final", reply });
      await reportTurnLog();
      return;
    }

    // 第二层：合法 JSON 但不符合 ReAct 协议（缺少 action/tool）→ 纠正重试
    const toolName = candidate.action?.tool;
    if (typeof toolName !== "string" || !toolName) {
      const finished = await handleProtocolFailure({
        round,
        roundTranscript,
        rawOutput: output,
        roundStartedAt,
        parseOk: true,
        parseError: "输出合法 JSON 但不符合 ReAct 协议（缺少 action/tool）",
      });
      if (finished) return;
      continue;
    }

    onEvent({ type: "tool_start", tool: toolName });
    const toolStartedAt = Date.now();
    const result = await executeAgentTool(toolName, candidate.action?.args ?? {});
    const toolDurationMs = Date.now() - toolStartedAt;
    const resultText = stringifyToolData(result.data) || result.summary;
    toolLogs.push({
      tool: toolName,
      args: candidate.action?.args,
      ok: result.ok,
      summary: result.summary,
      resultChars: resultText.length,
      error: result.ok ? undefined : result.summary,
      durationMs: toolDurationMs,
    });
    onEvent({ type: "tool_result", tool: toolName, ok: result.ok, summary: result.summary });

    roundLogs.push({
      round,
      transcript: truncateLogField(roundTranscript),
      rawOutput: truncateLogField(output),
      parseOk: true,
      repaired: !!parseResult?.repaired,
      action: { tool: toolName, args: candidate.action?.args },
      durationMs: Date.now() - roundStartedAt,
    });

    turns.push({ role: "assistant", content: output });
    turns.push({
      role: "tool_result",
      content: `tool: ${toolName}\nok: ${result.ok}\n${resultText}`,
    });
  }
}
