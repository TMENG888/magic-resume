import test from "node:test";
import assert from "node:assert/strict";
import { resolveSaveTarget } from "../src/utils/materials";

test("folder upload keeps the selected folder name as the root directory", () => {
  // webkitdirectory 选择 xianyu-agent 文件夹后，文件携带完整相对路径
  const main = resolveSaveTarget("xianyu-agent/main.py", "main.py");
  assert.deepEqual(main.dirSegments, ["xianyu-agent"]);
  assert.equal(main.fileName, "main.py");

  const registry = resolveSaveTarget("xianyu-agent/tools/registry.py", "registry.py");
  assert.deepEqual(registry.dirSegments, ["xianyu-agent", "tools"]);
  assert.equal(registry.fileName, "registry.py");
});

test("plain file selection (no relative path) saves into the current directory", () => {
  const target = resolveSaveTarget("", "resume.pdf");
  assert.deepEqual(target.dirSegments, []);
  assert.equal(target.fileName, "resume.pdf");
});

test("malformed relative path falling back to the file name", () => {
  const target = resolveSaveTarget("", "a.pdf");
  assert.equal(target.fileName, "a.pdf");
});
