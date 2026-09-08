import { parseJsonPayload } from "@/lib/resume-import-schema";

/**
 * ReAct 输出解析 + 容错修复。
 *
 * 模型（尤其带 reasoning 的模型）偶发输出畸形 JSON，日志中已捕获真实案例：
 *   {"action": {"tool": "update_resume", "args": {"patch": {...}}}}]
 *   —— 缺最外层 `}` 且尾部多一个 `]`。
 *
 * 修复策略（按优先级）：
 *   1. 原样解析（parseJsonPayload：裸 JSON / ```json 围栏 / {} 提取）；
 *   2. 去掉尾部游离的 `]`/空白后再解析；
 *   3. 尾部括号边界逐个回退 + 平衡补全（补缺失的 `}`/`]`/引号、清理悬挂逗号）。
 *
 * 全部失败返回 null，由调用方走纠正重试流程。
 */

interface ParseAttempt {
  ok: boolean;
  value?: unknown;
}

function safeParse(text: string): ParseAttempt {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** 扫描括号/字符串状态，补全未闭合的引号与括号 */
function balanceAndClose(prefix: string): string {
  let text = prefix;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop(); // 不匹配的闭合符一并弹出（尾部回退已尽量规避）
  }
  if (inString) text += '"';
  // 循环修剪末尾悬挂的逗号/冒号残片
  let prev: string;
  do {
    prev = text;
    text = text.replace(/[,:]\s*$/, "");
  } while (text !== prev);
  // 逆序补全未闭合括号
  for (let i = stack.length - 1; i >= 0; i -= 1) text += stack[i];
  // 清理补全后暴露的悬挂逗号（如 {"a": 1,} → {"a": 1}）
  text = text.replace(/,\s*([}\]])/g, "$1");
  return text;
}

/** 从尾部按括号边界生成候选前缀（最多 limit 个），保底包含全文 */
function tailBoundaries(text: string, limit = 10): string[] {
  const candidates: string[] = [];
  let searchEnd = text.length;
  for (let i = 0; i < limit; i += 1) {
    let idx = -1;
    for (let p = searchEnd - 1; p > 0; p -= 1) {
      const ch = text[p];
      if (ch === "}" || ch === "]") {
        idx = p + 1;
        searchEnd = p; // 下一轮从该括号之前继续向前找
        break;
      }
    }
    if (idx <= 0) break;
    candidates.push(text.slice(0, idx));
  }
  if (candidates.length === 0) candidates.push(text); // 纯截断（无任何闭合括号）：对全文补全
  return candidates;
}

export interface ReActParseResult {
  parsed: unknown;
  /** 是否经过修复（调优时统计模型输出格式质量） */
  repaired: boolean;
}

export function tryParseReActOutput(raw: string): ReActParseResult | null {
  const text = raw.trim();
  if (!text) return null;

  // 1) 原样解析
  try {
    return { parsed: parseJsonPayload(text), repaired: false };
  } catch {
    /* 继续修复 */
  }

  const start = text.indexOf("{");
  if (start === -1) return null;
  const body = text.slice(start);

  // 2) 去掉尾部游离字符（多余的 ] / 空白 / 尾随残句）再试
  const trimmed = body.replace(/(?:[\]\s]|"[^"]*$)+$/, "");
  if (trimmed !== body) {
    const attempt = safeParse(trimmed);
    if (attempt.ok) return { parsed: attempt.value, repaired: true };
  }

  // 3) 尾部括号边界回退 + 平衡补全
  for (const candidate of tailBoundaries(body)) {
    const attempt = safeParse(balanceAndClose(candidate));
    if (attempt.ok) return { parsed: attempt.value, repaired: true };
  }

  return null;
}
