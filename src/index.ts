import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir, stat, rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, extname, dirname, basename } from "node:path";

// ==================== 共享工具函数 ====================

/** 日志输出到 stderr（避免污染 stdout 的 JSON-RPC 通道） */
function log(tool: string, action: string, detail?: string) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] [${tool}] ${action}`;
  console.error(detail ? `${line} — ${detail}` : line);
}

/** 路径安全检查：拒绝路径遍历攻击（..）、空字节、空路径 */
function validatePath(raw: string): string | null {
  if (!raw || raw.trim().length === 0) {
    return "路径不能为空";
  }
  if (raw.includes("\0")) {
    return "路径包含非法字符（空字节）";
  }
  const normalized = raw.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      return `路径遍历攻击被拒绝：路径中不能包含 ".." —— "${raw}"`;
    }
  }
  return null; // 通过检查
}

/** 统一目录验证 + 路径安全检查，返回 resolve 后的绝对路径或错误响应 */
async function resolveAndValidateDir(
  toolName: string,
  rawPath: string
): Promise<string | { content: { type: "text"; text: string }[] }> {
  // 1. 安全检查
  const pathError = validatePath(rawPath);
  if (pathError) {
    log(toolName, "安全检查失败", pathError);
    return { content: [{ type: "text" as const, text: `安全拒绝：${pathError}` }] };
  }

  // 2. 解析为绝对路径
  let absolutePath: string;
  try {
    absolutePath = resolve(rawPath);
  } catch {
    log(toolName, "路径解析失败", rawPath);
    return { content: [{ type: "text" as const, text: `错误：无法解析路径 —— "${rawPath}"` }] };
  }

  // 3. 解析后再次检查（防止绕过）
  const resolvedError = validatePath(absolutePath);
  if (resolvedError) {
    log(toolName, "解析后安全检查失败", absolutePath);
    return { content: [{ type: "text" as const, text: `安全拒绝：${resolvedError}` }] };
  }

  // 4. 检查目录是否可访问
  try {
    const dirStat = await stat(absolutePath);
    if (!dirStat.isDirectory()) {
      log(toolName, "目标不是目录", absolutePath);
      return {
        content: [{ type: "text" as const, text: `错误：路径不是一个目录 —— "${absolutePath}"` }],
      };
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      log(toolName, "目录不存在", absolutePath);
      return {
        content: [{ type: "text" as const, text: `错误：目录不存在 —— "${absolutePath}"` }],
      };
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(toolName, "无权访问", absolutePath);
      return {
        content: [{ type: "text" as const, text: `错误：无权访问 —— "${absolutePath}"` }],
      };
    }
    log(toolName, "stat 失败", (err as Error).message);
    return {
      content: [{ type: "text" as const, text: `错误：读取目录失败 —— ${(err as Error).message}` }],
    };
  }

  return absolutePath;
}

/** 读取目录内容，只返回文件（可选是否包含子目录） */
async function readDirectoryEntries(absolutePath: string) {
  try {
    return await readdir(absolutePath, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      return { error: `无权读取目录内容 —— "${absolutePath}"` };
    }
    return { error: `读取目录失败 —— ${(err as Error).message}` };
  }
}

/** 路径安全检查 + resolve，不区分文件/目录，返回绝对路径或错误 */
async function resolveAndValidatePath(
  toolName: string,
  rawPath: string
): Promise<string | { content: { type: "text"; text: string }[] }> {
  const pathError = validatePath(rawPath);
  if (pathError) {
    log(toolName, "安全检查失败", pathError);
    return { content: [{ type: "text" as const, text: `安全拒绝：${pathError}` }] };
  }

  let absolutePath: string;
  try {
    absolutePath = resolve(rawPath);
  } catch {
    log(toolName, "路径解析失败", rawPath);
    return { content: [{ type: "text" as const, text: `错误：无法解析路径 —— "${rawPath}"` }] };
  }

  const resolvedError = validatePath(absolutePath);
  if (resolvedError) {
    log(toolName, "解析后安全检查失败", absolutePath);
    return { content: [{ type: "text" as const, text: `安全拒绝：${resolvedError}` }] };
  }

  return absolutePath;
}

// ==================== 服务器初始化 ====================

const server = new McpServer({
  name: "ai-file-manager",
  version: "1.0.0",
});

// ==================== echo 工具 ====================

server.tool(
  "echo",
  "回显输入的消息。用于测试 MCP Server 是否正常工作，验证通信链路通畅。",
  {
    message: z.string().describe("要回显的消息内容，任意文本均可"),
  },
  async ({ message }) => {
    log("echo", "调用", `message="${message.slice(0, 50)}"`);
    const result = `你说了：${message}`;
    log("echo", "成功", `返回 ${result.length} 个字符`);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ==================== list_files 工具 ====================

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
}

server.tool(
  "list_files",
  "列出指定目录下的所有文件和子文件夹。返回每个条目的名称、类型（file/dir）、" +
    "文件大小（字节，目录为 0）和最后修改时间（ISO 8601）。" +
    "结果会自动排序：目录在前、文件在后，同类按名称字母序排列。",
  {
    directoryPath: z
      .string()
      .describe("要列出内容的目录路径，支持绝对路径或相对于当前工作目录的路径"),
  },
  async ({ directoryPath }) => {
    log("list_files", "调用", `directoryPath="${directoryPath}"`);

    const resolved = await resolveAndValidateDir("list_files", directoryPath);
    if (typeof resolved !== "string") return resolved;
    const absolutePath = resolved;

    const entries = await readDirectoryEntries(absolutePath);
    if ("error" in entries) {
      log("list_files", "读取失败", entries.error);
      return { content: [{ type: "text" as const, text: `错误：${entries.error}` }] };
    }

    const results: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = join(absolutePath, entry.name);
      try {
        const entryStat = await stat(entryPath);
        results.push({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          size: entry.isFile() ? entryStat.size : 0,
          mtime: entryStat.mtime.toISOString(),
        });
      } catch {
        results.push({ name: entry.name, type: entry.isDirectory() ? "dir" : "file", size: 0, mtime: "" });
      }
    }

    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "base" });
    });

    const dirCount = results.filter((r) => r.type === "dir").length;
    const fileCount = results.filter((r) => r.type === "file").length;
    log("list_files", "成功", `${results.length} 个项目 (${dirCount} 目录, ${fileCount} 文件)`);

    return {
      content: [
        {
          type: "text" as const,
          text: `目录 "${absolutePath}" 包含 ${results.length} 个项目：\n\n${JSON.stringify(results, null, 2)}`,
        },
      ],
    };
  }
);

// ==================== organize_by_type 工具 ====================

interface MoveResult {
  fileName: string;
  extension: string;
  targetFolder: string;
  status: "成功" | "失败";
  error?: string;
}

function getTargetFolder(ext: string): string {
  const imageExts = new Set([
    "jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif",
    "raw", "heic", "avif",
  ]);
  const videoExts = new Set([
    "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg",
  ]);
  const audioExts = new Set([
    "mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus",
  ]);
  const codeExts = new Set([
    "js", "ts", "jsx", "tsx", "py", "java", "go", "rs", "c", "cpp", "h",
    "hpp", "cs", "rb", "php", "swift", "kt", "scala", "r", "sql", "sh",
    "bat", "ps1", "css", "scss", "less", "html", "htm", "vue", "svelte",
    "astro", "dart", "lua", "pl", "ex", "exs", "elm", "clj", "fs", "fsx",
  ]);
  const archiveExts = new Set([
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "lz4",
  ]);

  if (imageExts.has(ext)) return `${ext}_images`;
  if (videoExts.has(ext)) return `${ext}_videos`;
  if (audioExts.has(ext)) return `${ext}_audio`;
  if (codeExts.has(ext)) return `${ext}_code`;
  if (archiveExts.has(ext)) return `${ext}_archives`;
  return `${ext}_files`;
}

server.tool(
  "organize_by_type",
  "按文件类型自动整理目录。扫描目标目录中的所有文件（不递归子文件夹），" +
    "根据扩展名创建分类子文件夹并将文件移入。分类规则：\n" +
    "- 图片（jpg/png/gif/svg/webp 等）→ {ext}_images\n" +
    "- 视频（mp4/avi/mkv/mov 等）→ {ext}_videos\n" +
    "- 音频（mp3/wav/flac/aac 等）→ {ext}_audio\n" +
    "- 代码（js/ts/py/java/go/css/html 等）→ {ext}_code\n" +
    "- 压缩包（zip/rar/7z/tar/gz 等）→ {ext}_archives\n" +
    "- 文档及其他（txt/pdf/json/xml/docx 等）→ {ext}_files\n" +
    "- 无扩展名的文件 → misc/\n" +
    "目标文件夹不存在时自动创建，目标位置已有同名文件时跳过并报错。",
  {
    targetPath: z
      .string()
      .describe("要整理文件的目录路径，支持绝对路径或相对路径"),
  },
  async ({ targetPath }) => {
    log("organize_by_type", "调用", `targetPath="${targetPath}"`);

    const resolved = await resolveAndValidateDir("organize_by_type", targetPath);
    if (typeof resolved !== "string") return resolved;
    const absolutePath = resolved;

    const entries = await readDirectoryEntries(absolutePath);
    if ("error" in entries) {
      log("organize_by_type", "读取失败", entries.error);
      return { content: [{ type: "text" as const, text: `错误：${entries.error}` }] };
    }

    const files = entries.filter((e) => e.isFile());

    if (files.length === 0) {
      log("organize_by_type", "无文件可整理");
      return {
        content: [
          { type: "text" as const, text: `目录 "${absolutePath}" 中没有需要整理的文件。` },
        ],
      };
    }

    const results: MoveResult[] = [];

    for (const file of files) {
      const rawExt = extname(file.name).toLowerCase();
      const ext = rawExt.startsWith(".") ? rawExt.slice(1) : "";
      const displayExt = ext || "无扩展名";
      const targetFolder = ext ? getTargetFolder(ext) : "misc";
      const sourcePath = join(absolutePath, file.name);
      const destDir = join(absolutePath, targetFolder);
      const destPath = join(destDir, file.name);

      if (sourcePath === destPath) {
        results.push({ fileName: file.name, extension: displayExt, targetFolder, status: "失败", error: "文件已在目标文件夹中" });
        continue;
      }

      try {
        await mkdir(destDir, { recursive: true });
        await rename(sourcePath, destPath);
        results.push({ fileName: file.name, extension: displayExt, targetFolder, status: "成功" });
      } catch (err: any) {
        const reason =
          err.code === "EEXIST" ? "目标位置已存在同名文件" :
          err.code === "EACCES" || err.code === "EPERM" ? "权限不足" : err.message;
        results.push({ fileName: file.name, extension: displayExt, targetFolder, status: "失败", error: reason });
      }
    }

    const successCount = results.filter((r) => r.status === "成功").length;
    const failCount = results.filter((r) => r.status === "失败").length;
    log("organize_by_type", "完成", `成功 ${successCount}, 失败 ${failCount}`);

    const summary = `整理完成：共 ${results.length} 个文件，成功 ${successCount} 个，失败 ${failCount} 个。`;
    return {
      content: [
        {
          type: "text" as const,
          text: `${summary}\n\n目录 "${absolutePath}"：\n\n${JSON.stringify(results, null, 2)}`,
        },
      ],
    };
  }
);

// ==================== batch_rename 工具 ====================

interface RenamePlan {
  oldName: string;
  newName: string;
}

interface RenameSkipped {
  fileName: string;
  reason: string;
}

function computeNewName(
  oldName: string,
  operation: "add_prefix" | "add_suffix" | "replace",
  prefixOrSuffix: string,
  oldText: string,
  newText: string
): string {
  switch (operation) {
    case "add_prefix":
      return prefixOrSuffix + oldName;

    case "add_suffix": {
      const ext = extname(oldName);
      const base = oldName.slice(0, oldName.length - ext.length);
      return base + prefixOrSuffix + ext;
    }

    case "replace":
      return oldName.split(oldText).join(newText);
  }
}

server.tool(
  "batch_rename",
  "批量重命名目录中的文件（不递归子文件夹）。支持三种操作：\n" +
    "- add_prefix：在文件名最前面添加文本，如 report.txt → backup_report.txt\n" +
    "- add_suffix：在文件名主体与扩展名之间插入文本，如 report.txt → report_v2.txt\n" +
    "- replace：将文件名中所有出现的 oldText 替换为 newText，如 backup_report.txt → final_report.txt\n" +
    "只处理文件，忽略子目录。如果新文件名已被占用则跳过该文件并记录原因。" +
    "replace 操作要求 oldText 不能为空。",
  {
    directoryPath: z
      .string()
      .describe("要处理的目录路径，支持绝对路径或相对路径"),

    operation: z
      .enum(["add_prefix", "add_suffix", "replace"])
      .describe("操作类型：add_prefix（文件名前加前缀）、add_suffix（扩展名前加后缀）、replace（查找并替换文本）"),

    prefixOrSuffix: z
      .string()
      .describe("要添加的前缀或后缀文本（仅 add_prefix / add_suffix 操作需要，replace 操作时传空字符串即可）"),

    oldText: z
      .string()
      .describe("要被替换的原文本（仅 replace 操作需要，会替换文件名中所有匹配项）"),

    newText: z
      .string()
      .describe("替换后的新文本（仅 replace 操作需要）"),
  },
  async ({ directoryPath, operation, prefixOrSuffix, oldText, newText }) => {
    log("batch_rename", "调用", `operation=${operation}, directoryPath="${directoryPath}"`);

    const resolved = await resolveAndValidateDir("batch_rename", directoryPath);
    if (typeof resolved !== "string") return resolved;
    const absolutePath = resolved;

    // 参数校验
    if (operation === "replace" && !oldText) {
      log("batch_rename", "参数错误", "replace 操作缺少 oldText");
      return {
        content: [
          {
            type: "text" as const,
            text: "错误：replace 操作需要提供 oldText 参数（要替换的文本不能为空）。",
          },
        ],
      };
    }

    const entries = await readDirectoryEntries(absolutePath);
    if ("error" in entries) {
      log("batch_rename", "读取失败", entries.error);
      return { content: [{ type: "text" as const, text: `错误：${entries.error}` }] };
    }

    const files = entries.filter((e) => e.isFile());

    if (files.length === 0) {
      log("batch_rename", "无文件可重命名");
      return {
        content: [
          { type: "text" as const, text: `目录 "${absolutePath}" 中没有可重命名的文件。` },
        ],
      };
    }

    const renamed: RenamePlan[] = [];
    const skipped: RenameSkipped[] = [];

    for (const file of files) {
      const newName = computeNewName(file.name, operation, prefixOrSuffix, oldText, newText);

      if (newName === file.name) {
        skipped.push({ fileName: file.name, reason: "新文件名与原文件名相同，无需重命名" });
        continue;
      }

      const sourcePath = join(absolutePath, file.name);
      const destPath = join(absolutePath, newName);

      // 检查目标是否已存在
      try {
        await stat(destPath);
        skipped.push({ fileName: file.name, reason: `目标文件名 "${newName}" 已存在` });
        continue;
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          skipped.push({ fileName: file.name, reason: `无法检查目标文件: ${err.message}` });
          continue;
        }
      }

      // 执行重命名
      try {
        await rename(sourcePath, destPath);
        renamed.push({ oldName: file.name, newName });
      } catch (err: any) {
        const reason = err.code === "EACCES" || err.code === "EPERM" ? "权限不足" : err.message;
        skipped.push({ fileName: file.name, reason: `重命名失败: ${reason}` });
      }
    }

    log("batch_rename", "完成", `成功 ${renamed.length}, 跳过 ${skipped.length}`);

    const summary =
      `批量重命名完成：共 ${files.length} 个文件，成功 ${renamed.length} 个，跳过 ${skipped.length} 个。`;

    return {
      content: [
        {
          type: "text" as const,
          text: `${summary}\n\n${JSON.stringify({ operation, directory: absolutePath, renamed, skipped }, null, 2)}`,
        },
      ],
    };
  }
);

// ==================== read_file 工具 ====================

/** 将字节数格式化为可读大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

server.tool(
  "read_file",
  "读取指定文件的文本内容。返回文件内容、大小和最后修改时间。" +
    "对于文本文件直接返回可读内容；对于超大文件（超过 1MB）会截断并提示。",
  {
    filePath: z
      .string()
      .describe("要读取的文件路径，支持绝对路径或相对路径"),
  },
  async ({ filePath }) => {
    log("read_file", "调用", `filePath="${filePath}"`);

    const resolved = await resolveAndValidatePath("read_file", filePath);
    if (typeof resolved !== "string") return resolved;
    const absolutePath = resolved;

    // 检查存在性和类型
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        log("read_file", "文件不存在", absolutePath);
        return { content: [{ type: "text" as const, text: `错误：文件不存在 —— "${absolutePath}"` }] };
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        log("read_file", "无权访问", absolutePath);
        return { content: [{ type: "text" as const, text: `错误：无权访问 —— "${absolutePath}"` }] };
      }
      log("read_file", "stat 失败", (err as Error).message);
      return { content: [{ type: "text" as const, text: `错误：无法读取文件信息 —— ${(err as Error).message}` }] };
    }

    if (fileStat.isDirectory()) {
      log("read_file", "目标是目录而非文件", absolutePath);
      return { content: [{ type: "text" as const, text: `错误：路径是一个目录而非文件 —— "${absolutePath}"。如需列出目录内容，请使用 list_files 工具。` }] };
    }

    // 大小检查
    const MAX_SIZE = 1024 * 1024; // 1MB
    if (fileStat.size > MAX_SIZE) {
      log("read_file", "文件过大", `${formatFileSize(fileStat.size)} > ${formatFileSize(MAX_SIZE)}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `错误：文件过大（${formatFileSize(fileStat.size)}），超过读取上限 ${formatFileSize(MAX_SIZE)}。` +
              `请使用其他方式打开此文件。\n\n文件路径: "${absolutePath}"\n修改时间: ${fileStat.mtime.toISOString()}`,
          },
        ],
      };
    }

    // 读取内容
    let content: string;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch (err: any) {
      log("read_file", "读取失败", (err as Error).message);
      return { content: [{ type: "text" as const, text: `错误：读取文件失败 —— ${(err as Error).message}` }] };
    }

    log("read_file", "成功", `读取 ${formatFileSize(fileStat.size)}, ${content.split("\n").length} 行`);

    const lines = content.split("\n");
    const preview = lines.slice(0, 500).join("\n");
    const truncated = lines.length > 500
      ? `\n\n... (内容过长，已截断。完整文件共 ${lines.length} 行，此处仅显示前 500 行)`
      : "";

    const header =
      `文件: "${absolutePath}"\n` +
      `大小: ${formatFileSize(fileStat.size)}\n` +
      `修改时间: ${fileStat.mtime.toISOString()}\n` +
      `${lines.length > 500 ? `(显示前 500 行，共 ${lines.length} 行)\n` : ""}` +
      `────────────────────────────────────────\n`;

    return {
      content: [{ type: "text" as const, text: header + preview + truncated }],
    };
  }
);

// ==================== write_file 工具 ====================

server.tool(
  "write_file",
  "将文本内容写入文件。如果文件已存在则覆盖，如果父目录不存在则自动创建。" +
    "写入成功后返回文件路径和写入字节数。",
  {
    filePath: z
      .string()
      .describe("要写入的文件路径，支持绝对路径或相对路径"),

    content: z
      .string()
      .describe("要写入文件的文本内容"),
  },
  async ({ filePath, content }) => {
    log("write_file", "调用", `filePath="${filePath}", 内容 ${content.length} 个字符`);

    const resolved = await resolveAndValidatePath("write_file", filePath);
    if (typeof resolved !== "string") return resolved;
    const absolutePath = resolved;

    // 检查是否指向已存在的目录
    try {
      const existingStat = await stat(absolutePath);
      if (existingStat.isDirectory()) {
        log("write_file", "目标是目录", absolutePath);
        return { content: [{ type: "text" as const, text: `错误：路径是一个目录而非文件 —— "${absolutePath}"。不能将内容写入目录。` }] };
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        if (err.code === "EACCES" || err.code === "EPERM") {
          log("write_file", "无权访问", absolutePath);
          return { content: [{ type: "text" as const, text: `错误：无权访问 —— "${absolutePath}"` }] };
        }
        log("write_file", "stat 失败", (err as Error).message);
        return { content: [{ type: "text" as const, text: `错误：无法检查路径 —— ${(err as Error).message}` }] };
      }
      // ENOENT → 文件不存在，可以继续创建
    }

    // 确保父目录存在
    const parentDir = dirname(absolutePath);
    try {
      await mkdir(parentDir, { recursive: true });
    } catch (err: any) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        log("write_file", "无法创建父目录", parentDir);
        return { content: [{ type: "text" as const, text: `错误：无法创建父目录，权限不足 —— "${parentDir}"` }] };
      }
      log("write_file", "mkdir 失败", (err as Error).message);
      return { content: [{ type: "text" as const, text: `错误：创建父目录失败 —— ${(err as Error).message}` }] };
    }

    // 写入文件
    try {
      await writeFile(absolutePath, content, "utf-8");
    } catch (err: any) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        log("write_file", "写入权限不足", absolutePath);
        return { content: [{ type: "text" as const, text: `错误：权限不足，无法写入 —— "${absolutePath}"` }] };
      }
      log("write_file", "写入失败", (err as Error).message);
      return { content: [{ type: "text" as const, text: `错误：写入文件失败 —— ${(err as Error).message}` }] };
    }

    const byteSize = Buffer.byteLength(content, "utf-8");
    log("write_file", "成功", `写入 ${formatFileSize(byteSize)} 到 "${basename(absolutePath)}"`);

    const result = {
      filePath: absolutePath,
      size: formatFileSize(byteSize),
      bytes: byteSize,
      lines: content.split("\n").length,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: `文件写入成功。\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }
);

// ==================== 启动 ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const startupMsg = "ai-file-manager MCP Server 已启动 (stdio)";
  console.error(startupMsg);
  log("server", "启动", `工具数量: 6 (echo, list_files, read_file, write_file, organize_by_type, batch_rename)`);
}

main().catch((err) => {
  console.error("Server 启动失败:", err);
  process.exit(1);
});
