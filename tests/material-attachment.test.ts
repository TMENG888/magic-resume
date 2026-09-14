import test from "node:test";
import assert from "node:assert/strict";
import {
  createMaterialsAttachment,
  extractAttachment,
} from "../src/lib/material-context";

/** 模拟 webkitdirectory 选择：File 对象附加 webkitRelativePath */
const localFile = (relativePath: string, content: string): File => {
  const name = relativePath.split("/").pop() ?? relativePath;
  const file = new File([content], name, { type: "text/plain" });
  return Object.assign(file, { webkitRelativePath: relativePath });
};

test("local folder attachment extracts every file with its relative path", async () => {
  const attachment = createMaterialsAttachment({
    source: "local",
    path: "xianyu-agent",
    name: "xianyu-agent",
    kind: "dir",
    size: 100,
    files: [
      localFile("xianyu-agent/main.py", "print('main')"),
      localFile("xianyu-agent/agent.py", "agent = True"),
      localFile("xianyu-agent/tools/registry.py", "registry = {}"),
    ],
  });

  const results = await extractAttachment(attachment);
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((item) => item.path),
    [
      "xianyu-agent/main.py",
      "xianyu-agent/agent.py",
      "xianyu-agent/tools/registry.py",
    ],
  );
  assert.ok(results.every((item) => item.kind === "file"));
  assert.match(results[0].content ?? "", /print\('main'\)/);
});

test("local folder attachment caps extraction at 30 files and marks the rest skipped", async () => {
  const files = Array.from({ length: 35 }, (_, index) =>
    localFile(`proj/file-${index}.txt`, `content ${index}`),
  );
  const attachment = createMaterialsAttachment({
    source: "local",
    path: "proj",
    name: "proj",
    kind: "dir",
    size: 1000,
    files,
  });

  const results = await extractAttachment(attachment);
  assert.equal(results.length, 35);
  const skipped = results.filter((item) => item.note?.includes("跳过"));
  assert.equal(skipped.length, 5);
  assert.ok(results.slice(0, 30).every((item) => item.content?.includes("content")));
});

test("local file attachment still extracts as a single file", async () => {
  const file = new File(["resume text"], "resume.txt", { type: "text/plain" });
  const attachment = createMaterialsAttachment({
    source: "local",
    path: "resume.txt",
    name: "resume.txt",
    kind: "file",
    size: file.size,
    file,
  });

  const results = await extractAttachment(attachment);
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "resume.txt");
  assert.equal(results[0].content, "resume text");
});

test("local dir attachment without files yields no results instead of throwing", async () => {
  const attachment = createMaterialsAttachment({
    source: "local",
    path: "empty",
    name: "empty",
    kind: "dir",
  });
  const results = await extractAttachment(attachment);
  assert.deepEqual(results, []);
});
