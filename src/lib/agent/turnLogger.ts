import type { AgentTurnLogRecord } from "./log-types";

/**
 * 智能体回合日志上报（客户端 → /api/agent-log → logs/agent/）。
 *
 * 设计原则：旁路能力，fire-and-forget——上报失败绝不影响智能体对话主流程。
 */

/** 计算 SHA-256 指纹（浏览器 crypto.subtle，失败返回 undefined） */
export async function sha256Hex(text: string): Promise<string | undefined> {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

export async function reportAgentTurn(record: AgentTurnLogRecord): Promise<void> {
  try {
    await fetch("/api/agent-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      keepalive: true,
    });
  } catch {
    // 日志上报失败静默忽略
  }
}
