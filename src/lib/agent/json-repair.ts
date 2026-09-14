import { parseJsonPayload } from "@/lib/resume-import-schema";

/**
 * ReAct 输出解析 + 容错修复。
 *
 * 模型（尤其带 reasoning 的模型）偶发输出畸形 JSON，日志中已捕获真实案例：
 *   {"action": {"tool": "update_resume", "args": {"patch": {...}}}}]
 *   —— 缺最外层 `}` 且尾部多一个 `]`。
 *   {"action": ...}\n\n[tool_result] ...(模型伪造的后续对话)...
 *   —— 输出一个 JSON 后幻觉续写 transcript（deepseek-v4-flash 实录）。
 *   <｜｜DSML｜｜ invoke name="read_material">...（内部工具标记泄漏）
 *
 * 修复策略（按优先级）：
 *   0. DeepSeek DSML 内部标记泄漏 → 机械转换为 ReAct action JSON；
 *   1. 原样解析（parseJsonPayload：裸 JSON / ```json 围栏 / {} 提取）；
 *   2. 首个平衡 JSON 对象提取（括号配对扫描，治幻觉续写/多 JSON 连发）；
 *   3. 去掉尾部游离的 `]`/空白后再解析；
 *   4. 尾部括号边界逐个回退 + 平衡补全（补缺失的 `}`/`]`/引号、清理悬挂逗号）。
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

/** 扫描括号/字符串状态，丢弃不匹配的噪声闭合符并补全未闭合的引号与括号 */
function balanceAndClose(prefix: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let out = "";
  for (const ch of prefix) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out += ch;
    } else if (ch === "}" || ch === "]") {
      // 仅接受与栈顶匹配的闭合符；不匹配的（如缺失 } 却出现的 ]）作为噪声丢弃，
      // 避免污染输出（例：{"reply": "done"] 应修复为 {"reply": "done"}）
      if (stack[stack.length - 1] === ch) {
        stack.pop();
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  let text = out;
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

/**
 * DeepSeek 模型偶发把内部 DSML 工具标记泄漏到可见输出（而非协议约定的 JSON），
 * 例如：
 *   <｜｜DSML｜｜ invoke name="read_material">
 *   <｜｜DSML｜｜ parameter name="path" string="true">cli.py</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 * 机械转换为等价的 ReAct action JSON；无法提取工具名时返回 null。
 */
function convertDsmlToAction(raw: string): string | null {
  if (!raw.includes("DSML")) return null;
  const tool = raw.match(/invoke\s+name="([^"]+)"/)?.[1];
  if (!tool) return null;
  const args: Record<string, string> = {};
  const paramRe = /<[^>]*parameter[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*parameter>/g;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(raw)) !== null) {
    args[match[1]] = match[2].trim();
  }
  return JSON.stringify({ action: { tool, args } });
}

/**
 * 从第一个 `{` 开始做括号平衡扫描（考虑字符串转义），提取第一个完整闭合的
 * JSON 对象子串。模型在输出一个合法 JSON 后常幻觉续写伪造的 [tool_result]、
 * [assistant] 等后续对话内容，整串解析必然失败，但第一个对象才是真实意图。
 * 返回 null 表示从首个 `{` 起直到文本结尾都未闭合（交给后续截断修复）。
 */
function extractFirstBalancedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface ReActParseResult {
  parsed: unknown;
  /** 是否经过修复（调优时统计模型输出格式质量） */
  repaired: boolean;
}

export function tryParseReActOutput(raw: string): ReActParseResult | null {
  // 0) DSML 内部标记泄漏 → 机械转换为规范 JSON 后继续解析
  const dsml = convertDsmlToAction(raw);
  const text = (dsml ?? raw).trim();
  if (!text) return null;

  // 1) 原样解析
  try {
    return { parsed: parseJsonPayload(text), repaired: dsml !== null };
  } catch {
    /* 继续修复 */
  }

  const start = text.indexOf("{");
  if (start === -1) return null;

  // 2) 首个平衡 JSON 对象提取：治「输出一个 JSON 后幻觉续写伪造对话」与「多 JSON 连发」
  const balanced = extractFirstBalancedJson(text);
  if (balanced) {
    const attempt = safeParse(balanced);
    if (attempt.ok) return { parsed: attempt.value, repaired: true };
  }

  const body = text.slice(start);

  // 3) 去掉尾部游离字符（多余的 ] / 空白 / 尾随残句）再试
  const trimmed = body.replace(/(?:[\]\s]|"[^"]*$)+$/, "");
  if (trimmed !== body) {
    const attempt = safeParse(trimmed);
    if (attempt.ok) return { parsed: attempt.value, repaired: true };
  }

  // 4) 尾部括号边界回退 + 平衡补全
  for (const candidate of tailBoundaries(body)) {
    const attempt = safeParse(balanceAndClose(candidate));
    if (attempt.ok) return { parsed: attempt.value, repaired: true };
  }

  return null;
}
