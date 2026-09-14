import test from "node:test";
import assert from "node:assert/strict";
import { tryParseReActOutput } from "../src/lib/agent/json-repair";

/** 以下畸形样本均来自 logs/agent 真实生产日志（deepseek-v4-flash） */

test("纯净 action JSON 原样解析，不标记 repaired", () => {
  const result = tryParseReActOutput('{"action": {"tool": "get_resume", "args": {}}}');
  assert.deepEqual(result, {
    parsed: { action: { tool: "get_resume", args: {} } },
    repaired: false,
  });
});

test("幻觉续写：输出一个 JSON 后伪造 [tool_result]/[assistant] 对话（生产实录）", () => {
  // 生产日志 2026-09-10T01:10:18.384Z：第一个 JSON 后模型自己脑补了整个后续对话
  const raw =
    '{"action": {"tool": "read_material", "args": {"path": "闲鱼"}}}\n\n' +
    "[tool_result] tool: read_material\nok: false\nerror: 找不到路径：闲鱼\n\n" +
    '[assistant] {"action": {"tool": "read_material", "args": {"path": "xianyu"}}}\n\n' +
    "[tool_result] tool: read_material\nok: false\nerror: 找不到路径：xianyu";
  const result = tryParseReActOutput(raw);
  assert.deepEqual(result?.parsed, {
    action: { tool: "read_material", args: { path: "闲鱼" } },
  });
  assert.equal(result?.repaired, true);
});

test("幻觉续写中 JSON 参数含嵌套对象/数组/转义引号时仍能正确提取第一个对象", () => {
  const raw =
    '{"reply": "他说：\\"你好\\""}\n\n[tool_result] 伪造内容 } ] 混入括号';
  const result = tryParseReActOutput(raw);
  assert.deepEqual(result?.parsed, { reply: '他说："你好"' });
});

test("多个 JSON 连发时取第一个（生产实录）", () => {
  // 生产日志 2026-09-10T01:09:47.654Z
  const raw =
    '{"action": {"tool": "list_materials", "args": {}}}\n\n' +
    '{"action": {"tool": "get_resume", "args": {}}}';
  const result = tryParseReActOutput(raw);
  assert.deepEqual(result?.parsed, {
    action: { tool: "list_materials", args: {} },
  });
});

test("DeepSeek DSML 内部工具标记泄漏时转换为 action（生产实录）", () => {
  // 生产日志 2026-09-10T01:09:07.809Z
  const raw =
    '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_material">\n' +
    '<｜｜DSML｜｜ parameter name="path" string="true">cli.py</｜｜DSML｜｜ parameter>\n' +
    "</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
  const result = tryParseReActOutput(raw);
  assert.deepEqual(result?.parsed, {
    action: { tool: "read_material", args: { path: "cli.py" } },
  });
  assert.equal(result?.repaired, true);
});

test("截断 JSON（缺最外层 } 且尾部多 ]）仍由平衡补全修复（原有能力不回退）", () => {
  const raw = '{"reply": "done"]';
  const result = tryParseReActOutput(raw);
  assert.deepEqual(result?.parsed, { reply: "done" });
  assert.equal(result?.repaired, true);
});

test("markdown 代码围栏包裹的 JSON 正常解析", () => {
  const raw = '```json\n{"reply": "好的"}\n```';
  const result = tryParseReActOutput(raw);
  assert.deepEqual(result?.parsed, { reply: "好的" });
});

test("彻底无 JSON 的垃圾输出返回 null", () => {
  assert.equal(tryParseReActOutput("抱歉，我无法完成该任务。"), null);
  assert.equal(tryParseReActOutput(""), null);
});
