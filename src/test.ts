/**
 * 本地测试脚本：直接通过 stdio 与 MCP Server 通信，无需浏览器。
 * 用法：npx ts-node src/test.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

// --------------------- 工具函数 ---------------------

function sendRequest(
  writer: NodeJS.WritableStream,
  requestId: number,
  method: string,
  params?: Record<string, unknown>
): string {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  });
  writer.write(request + "\n");
  return request;
}

// --------------------- 主流程 ---------------------

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  ai-file-manager MCP Server 本地测试");
  console.log("═══════════════════════════════════════════\n");

  // ---- 准备测试目录 ----
  const baseDir = join(process.cwd(), "test_batch");
  await rm(baseDir, { recursive: true, force: true });
  await mkdir(baseDir, { recursive: true });

  // 创建测试文件
  const testFiles = [
    "report.txt",
    "photo.jpg",
    "notes.txt",
    "data.csv",
    "IMG_001.png",
    "readme.md",
  ];
  for (const name of testFiles) {
    await writeFile(join(baseDir, name), "test content");
  }
  // 额外创建一个会与重命名结果冲突的文件
  await writeFile(join(baseDir, "done_report.txt"), "conflict");
  console.log("📁 已创建测试目录: test_batch (7 个文件)\n");

  // ---- 步骤 1：启动 server ----
  console.log("📌 步骤 1：启动 MCP Server...");
  const serverProcess = spawn("npx", ["ts-node", "src/index.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log("  [Server] " + msg);
  });

  const rl = createInterface({ input: serverProcess.stdout! });
  let requestId = 0;
  let pendingResolve: ((value: string) => void) | null = null;

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    if (pendingResolve) {
      pendingResolve(line);
      pendingResolve = null;
    }
  });

  function request(method: string, params?: Record<string, unknown>): Promise<string> {
    requestId++;
    const req = sendRequest(serverProcess.stdin!, requestId, method, params);
    console.log("  📤 " + req);
    return new Promise((resolve) => {
      pendingResolve = (resp: string) => {
        console.log("  📥 " + resp);
        resolve(resp);
      };
    });
  }

  await new Promise((r) => setTimeout(r, 1500));

  // ---- 步骤 2：初始化 ----
  console.log("\n📌 步骤 2：initialize 握手...");
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  console.log("  ✅ 初始化成功！");
  serverProcess.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 500));

  // ---- 步骤 3：列出工具 ----
  console.log("\n📌 步骤 3：列出可用工具...");
  const toolsResp = await request("tools/list");
  const toolsData = JSON.parse(toolsResp);
  const toolNames = toolsData.result?.tools?.map((t: { name: string }) => t.name) || [];
  console.log("  🛠️  已注册工具: " + toolNames.join(", "));

  // ---- 步骤 4：安全测试 — 路径遍历攻击 ----
  console.log("\n📌 步骤 4：安全测试（路径遍历攻击 ..）...");
  const traversalResp = await request("tools/call", {
    name: "list_files",
    arguments: { directoryPath: "../etc" },
  });
  const traversalData = JSON.parse(traversalResp);
  console.log("  🛡️  " + traversalData.result.content[0].text);

  console.log("\n📌 步骤 5：安全测试（空路径）...");
  const emptyResp = await request("tools/call", {
    name: "list_files",
    arguments: { directoryPath: "" },
  });
  const emptyData = JSON.parse(emptyResp);
  console.log("  🛡️  " + emptyData.result.content[0].text);

  // ---- 步骤 6：batch_rename - add_prefix ----
  console.log("\n📌 步骤 6：batch_rename（添加前缀 backup_）...");
  const prefixResp = await request("tools/call", {
    name: "batch_rename",
    arguments: {
      directoryPath: baseDir,
      operation: "add_prefix",
      prefixOrSuffix: "backup_",
      oldText: "",
      newText: "",
    },
  });
  const prefixData = JSON.parse(prefixResp);
  console.log("  📋 " + prefixData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 7：batch_rename - add_suffix ----
  console.log("\n📌 步骤 7：batch_rename（添加后缀 _v2）...");
  const suffixResp = await request("tools/call", {
    name: "batch_rename",
    arguments: {
      directoryPath: baseDir,
      operation: "add_suffix",
      prefixOrSuffix: "_v2",
      oldText: "",
      newText: "",
    },
  });
  const suffixData = JSON.parse(suffixResp);
  console.log("  📋 " + suffixData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 8：batch_rename - replace ----
  console.log("\n📌 步骤 8：batch_rename（replace backup -> final）...");
  const replaceResp = await request("tools/call", {
    name: "batch_rename",
    arguments: {
      directoryPath: baseDir,
      operation: "replace",
      prefixOrSuffix: "",
      oldText: "backup",
      newText: "final",
    },
  });
  const replaceData = JSON.parse(replaceResp);
  console.log("  📋 " + replaceData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 9：batch_rename - 参数校验（replace 缺少 oldText） ----
  console.log("\n📌 步骤 9：batch_rename（replace 但 oldText 为空，应报错）...");
  const errResp = await request("tools/call", {
    name: "batch_rename",
    arguments: {
      directoryPath: baseDir,
      operation: "replace",
      prefixOrSuffix: "",
      oldText: "",
      newText: "something",
    },
  });
  const errData = JSON.parse(errResp);
  console.log("  ⚠️  " + errData.result.content[0].text);

  // ---- 步骤 10：write_file 创建新文件 ----
  console.log("\n📌 步骤 10：write_file（创建新文件）...");
  const writeResp = await request("tools/call", {
    name: "write_file",
    arguments: {
      filePath: join(baseDir, "hello.txt"),
      content: "你好，世界！\n这是 AI File Manager 写入的文件。\n共 3 行。",
    },
  });
  const writeData = JSON.parse(writeResp);
  console.log("  📝 " + writeData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 11：read_file 读取刚写入的文件 ----
  console.log("\n📌 步骤 11：read_file（读取刚写入的文件）...");
  const readResp = await request("tools/call", {
    name: "read_file",
    arguments: { filePath: join(baseDir, "hello.txt") },
  });
  const readData = JSON.parse(readResp);
  console.log("  📖 " + readData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 12：write_file 覆盖已有文件 ----
  console.log("\n📌 步骤 12：write_file（覆盖已有文件）...");
  const overwriteResp = await request("tools/call", {
    name: "write_file",
    arguments: {
      filePath: join(baseDir, "hello.txt"),
      content: "覆盖后的新内容！",
    },
  });
  const overwriteData = JSON.parse(overwriteResp);
  console.log("  📝 " + overwriteData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 13：read_file 验证覆盖 ----
  console.log("\n📌 步骤 13：read_file（验证覆盖结果）...");
  const verifyResp = await request("tools/call", {
    name: "read_file",
    arguments: { filePath: join(baseDir, "hello.txt") },
  });
  const verifyData = JSON.parse(verifyResp);
  console.log("  📖 " + verifyData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 步骤 14：read_file 不存在的文件 ----
  console.log("\n📌 步骤 14：read_file（不存在的文件，应报错）...");
  const missingResp = await request("tools/call", {
    name: "read_file",
    arguments: { filePath: join(baseDir, "nope.txt") },
  });
  const missingData = JSON.parse(missingResp);
  console.log("  ⚠️  " + missingData.result.content[0].text);

  // ---- 步骤 15：list_files 查看最终结果 ----
  console.log("\n📌 步骤 15：查看最终目录内容...");
  const listResp = await request("tools/call", {
    name: "list_files",
    arguments: { directoryPath: baseDir },
  });
  const listData = JSON.parse(listResp);
  console.log("  📂 " + listData.result.content[0].text.replace(/\n/g, "\n  "));

  // ---- 清理 ----
  await rm(baseDir, { recursive: true, force: true });
  console.log("\n🧹 已清理测试目录");

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✅ 所有测试通过！Server 工作正常。");
  console.log("═══════════════════════════════════════════\n");

  serverProcess.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
