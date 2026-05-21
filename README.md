# AI File Manager - MCP Server

基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 的文件管理服务器，提供文件浏览、读写、整理和批量重命名能力。可接入任何支持 MCP 的 AI 客户端，附带命令行测试脚本和浏览器调试工具。

## 功能列表

| 工具 | 功能 | 说明 |
|------|------|------|
| `list_files` | 列出目录内容 | 返回文件名、类型、大小、修改时间，目录优先排序 |
| `read_file` | 读取文件内容 | 读取文本文件，显示大小、行数和内容（超过 1MB 拒绝，超过 500 行截断） |
| `write_file` | 写入文件 | 创建或覆盖文件，自动创建父目录，返回写入字节数和行数 |
| `organize_by_type` | 按类型整理文件 | 根据扩展名自动创建分类文件夹并移入（图片/视频/音频/代码/压缩包/文档/misc） |
| `batch_rename` | 批量重命名 | 支持添加前缀、添加后缀、查找替换三种模式 |
| `echo` | 消息回显 | 用于测试 Server 通信链路是否正常 |

### 安全检查

- 拒绝路径遍历攻击（包含 `..` 的路径直接拦截）
- 拒绝空路径和空字节注入
- 所有文件操作均有 try-catch 兜底，返回中文错误信息，Server 不会崩溃

---

## 安装步骤

### 环境要求

- [Node.js](https://nodejs.org) >= 18
- npm >= 9

### 克隆项目

```bash
git clone https://github.com/你的用户名/ai-file-manager.git
cd ai-file-manager
```

### 安装依赖

```bash
npm install
```

### 编译 TypeScript

```bash
npm run build
```

编译产物输出到 `dist/` 目录。

---

## 可用的 npm 脚本

| 命令 | 功能 |
|------|------|
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm run dev` | 开发模式（nodemon 热重载，修改代码自动重启） |
| `npm start` | 运行编译后的 JS 文件 |
| `npm test` | 运行本地测试脚本，验证所有工具 |

---

## 测试和调试

### 方式一：终端一键测试（推荐入门）

```bash
npm test
```

测试脚本依次验证：Server 启动 → MCP 握手 → 工具注册 → 安全拦截 → 读写文件 → 批量重命名。全部通过输出 `✅ 所有测试通过！`。

### 方式二：MCP Inspector（浏览器图形界面）

```bash
# 全局安装（只需一次）
npm install -g @modelcontextprotocol/inspector

# 启动 Inspector
cd ai-file-manager
npx @modelcontextprotocol/inspector npx ts-node src/index.ts
```

浏览器自动打开 `http://localhost:5173`：

1. 左侧 **Tools** 列表显示全部 6 个工具
2. 点击工具名称进入测试页
3. 填写参数后点击 **Run Tool** 查看返回结果

### 方式三：开发热重载

```bash
npm run dev
```

修改 `src/index.ts` 后自动重启，配合 Inspector 可实现边改边测。

### 如何接入 MCP 客户端

任何兼容 MCP 协议的客户端都可以通过 stdio 接入本 Server，通用配置模板：

```json
{
  "mcpServers": {
    "ai-file-manager": {
      "command": "npx",
      "args": ["ts-node", "/absolute/path/to/ai-file-manager/src/index.ts"]
    }
  }
}
```

或将项目编译后用 `node` 直接运行 `dist/index.js`，避免依赖 `ts-node`：

```json
{
  "mcpServers": {
    "ai-file-manager": {
      "command": "node",
      "args": ["/absolute/path/to/ai-file-manager/dist/index.js"]
    }
  }
}
```

> Windows 下如果遇到 `EFTYPE` 等 spawn 错误，可将 `node` 替换为完整路径（如 `C:\\Program Files\\nodejs\\node.exe`），或使用 `cmd /c node ...` 作为 command。

---

## 工具使用示例

### list_files — 列出目录内容

```
参数：{ "directoryPath": "./src" }

返回：
目录 "D:\AI-File-Manager\src" 包含 2 个项目：

[
  {
    "name": "index.ts",
    "type": "file",
    "size": 25476,
    "mtime": "2026-05-21T07:55:20.891Z"
  },
  {
    "name": "test.ts",
    "type": "file",
    "size": 9521,
    "mtime": "2026-05-21T07:56:19.061Z"
  }
]
```

### read_file — 读取文件内容

```
参数：{ "filePath": "./src/index.ts" }

返回：
文件: "D:\AI-File-Manager\src\index.ts"
大小: 24.9 KB
修改时间: 2026-05-21T07:55:20.891Z
────────────────────────────────────────
import { McpServer } from ...
...
```

### write_file — 写入文件

```
参数：{
  "filePath": "./tools_test/demo5.txt",
  "content": "Hello World!"
}

返回：
文件写入成功。

{
  "filePath": "D:\\AI-File-Manager\\tools_test\\demo5.txt",
  "size": "12 B",
  "bytes": 12,
  "lines": 1
}
```

> 父目录不存在时会自动创建。

### organize_by_type — 按类型整理

```
参数：{ "targetPath": "./tools_test" }

整理前：5个文件散落在目录
整理后：
整理完成：共 5 个文件，成功 5 个，失败 0 个。

目录 "D:\AI-File-Manager\tools_test"：

[
  {
    "fileName": "demo1.bmp",
    "extension": "bmp",
    "targetFolder": "bmp_images",
    "status": "成功"
  },
  {
    "fileName": "demo2.docx",
    "extension": "docx",
    "targetFolder": "docx_files",
    "status": "成功"
  },
  {
    "fileName": "demo3.txt",
    "extension": "txt",
    "targetFolder": "txt_files",
    "status": "成功"
  },
  {
    "fileName": "demo4.zip",
    "extension": "zip",
    "targetFolder": "zip_archives",
    "status": "成功"
  },
  {
    "fileName": "demo5.txt",
    "extension": "txt",
    "targetFolder": "txt_files",
    "status": "成功"
  }
]
```

分类规则：图片 → `{ext}_images`，视频 → `{ext}_videos`，音频 → `{ext}_audio`，代码 → `{ext}_code`，压缩包 → `{ext}_archives`，文档及其他 → `{ext}_files`，无扩展名 → `misc/`。

### batch_rename — 批量重命名

```
add_prefix 示例：
  参数：{ "operation": "add_prefix", "prefixOrSuffix": "backup_" }
  效果：report.txt → backup_report.txt

add_suffix 示例：
  参数：{ "operation": "add_suffix", "prefixOrSuffix": "_v2" }
  效果：report.txt → report_v2.txt

replace 示例：
  参数：{ "operation": "replace", "oldText": "backup", "newText": "final" }
  效果：backup_report.txt → final_report.txt
```

新文件名已被占用时跳过并记录原因，replace 操作要求 `oldText` 不能为空。

---

## 项目结构

```
ai-file-manager/
├── package.json              # 项目配置与依赖
├── tsconfig.json             # TypeScript 编译配置
├── README.md                 # 本文件
├── src/
│   ├── index.ts              # MCP Server 主程序（6 个工具）
│   └── test.ts               # 本地测试脚本
└── dist/                     # 编译输出（npm run build 后生成）
```

---

## 技术栈

- **运行时**: Node.js 18+
- **语言**: TypeScript 5.7
- **协议**: MCP (Model Context Protocol)
- **核心依赖**: `@modelcontextprotocol/sdk` ^1.12.0, `zod` ^3.24.0
- **开发工具**: `ts-node`, `nodemon`, `@types/node`

---

## 安全说明

- **路径限制**：所有路径输入在 `resolve()` 前后各检查一次，拒绝包含 `..` 的路径、空路径和含空字节的路径，防止目录遍历攻击
- **只操作文件**：`organize_by_type` 和 `batch_rename` 只处理文件，忽略子目录，不会误操作文件夹结构
- **不覆盖已有文件**：重命名或移动前检查目标是否已存在，存在则跳过并记录原因
- **错误不崩溃**：所有异步 I/O 操作均包裹在 try-catch 中，返回中文错误信息，Server 进程不会因单次操作失败而退出
- **日志输出隔离**：所有日志通过 stderr 输出，不污染 stdout 的 JSON-RPC 协议通道

---

## 许可证

MIT

---

## 贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request
