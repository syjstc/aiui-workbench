# 源码结构与验证

## 环境

Node.js 24 LTS（最低 22.22），npm。macOS 正式签名需要安装 Xcode Command Line Tools 和 Developer ID Application 证书。Windows 桌面目标为 Windows 10 / 11 x64。

```sh
npm ci
npm run prepare:tools
npm run dev
```

`prepare:tools` 从 `vendor/adb/manifest.json`、`vendor/scrcpy/manifest.json` 下载固定版本并验证摘要。官方资料快照直接包含在 Git 中；ADB/scrcpy 二进制、node_modules 和运行数据不进入 Git。

## 目录

| 目录 | 职责 |
| --- | --- |
| `services/feedback/` | Cloudflare 反馈机器人、验证和服务端去重限频；凭据仅放 Worker Secret |
| `core/` | 共享本地服务、项目、SDK、资料、设备、任务与录制 |
| `electron/` | 原生窗口、受控 IPC、系统权限和 macOS entitlements |
| `renderer/` | React 工作台、中英文、主题、设备与资料界面 |
| `preview/` | 独立来源的官方 Ink 宿主、输入、姿态、媒体适配 |
| `mcp/` | stdio MCP 接入，使用共享服务的实际工具定义 |
| `web/` | 本地浏览器入口与工坊 CLI |
| `examples/` | 可独立导入、无业务项目依赖的公开示例 |
| `assets/skills/`、`assets/templates/` | 工坊流程 Skill、新项目交互约束及镜腿输入模板 |
| `vendor/` | 上游快照、工具来源与固定摘要 |
| `tests/`、`scripts/` | 单元测试、真实桌面/MCP 集成、打包与发布 |

桌面、Web、CLI 和 MCP 使用同一个本地服务；预览页面在独立来源运行，不能访问 Node 或服务控制口令。官方登录使用单独会话。

## 自动制作、源码与诊断

`core/development-flow.mjs` 保存制作阶段、断言与证据，源码或 SDK 变化后使旧结果失效；`core/project-files.mjs` 提供项目范围内的文本读写和 revision 冲突保护。`core/agent-skills.mjs` 检测和补齐官方及工坊 Skill，保留用户修改。`core/diagnostics.mjs` 与 `core/diagnostic-scope.mjs` 记录问题、归属和已读状态，工具响应按当前项目附上新问题；已读与修复独立。

`renderer/project-page.jsx` 展示项目预览、想法和完整流程；`renderer/connect-page.jsx` 负责首次连接。`core/ai-connection.mjs` 只认成功的实际 MCP 上下文调用。`core/preview-storage.mjs` 与 `preview/storage-runtime.js` 提供按项目隔离的持久化模拟存储，不改写真机安装包。用户流程和参数见 [自动制作与恢复](automated-development.md)。

## 官方平台上传与提审

用户操作见 [草稿上传与提审](platform-uploads.md) / [English](platform-uploads.en.md)。维护这部分功能时，以下文件分别负责契约、传输、回执及原生授权：

| 文件 | 职责 |
| --- | --- |
| `core/platform-contract.mjs` | MCP / CLI 参数约束、材料数量和文字长度 |
| `core/platform-http.mjs` | 固定官方端点、媒体校验、STS / OSS 上传及地址校验 |
| `core/platform.mjs` | 账号绑定、上传与材料回执、未知结果回查、草稿摘要及一次性确认 |
| `electron/platform-session.cjs`、`electron/platform-login.cjs` | 独立内存官方会话、系统加密快照、即时登录同步、续期及退出撤权 |
| `electron/main.cjs`、`electron/preload.cjs` | 受控 IPC 和用户原生提审确认；不向渲染层或 MCP 暴露确认密钥 |
| `renderer/platform-panel.jsx`、`renderer/platform-records.jsx` | 统一应用选择、两个标签页、顶部警告、只读官方资料 |

更改后应同步中英文 README、两份平台指南和 MCP 示例。保持已有官方记录的读取入口只读，不添加云端删除工具；MCP 允许上传新草稿和准备材料，正式提审仅由桌面原生用户确认。网络响应丢失时不得自动重放写请求；变更账号、绑定、包或资料后原确认必须失效。

## 验证

```sh
npm test
npm run build
npm run check:public
```

按改动选择对应集成验证。以下命令使用隔离数据目录，不安装到眼镜：

```sh
npm run qa:screenshots       # 公开示例：官方检查/AIX、长滑/返回断言、真实截图
npm run qa:mcp-workflows     # stdio MCP、CLI、组合工具与独立浏览器
npm run qa:simulator         # 桌面导航、鼠标姿态、头模和生命周期
npm run qa:camera            # 照片素材、编码、权限和流释放；使用测试摄像头
npm run qa:recording         # 短片解码与退出封装；需 ffmpeg / ffprobe 在 PATH
npm run qa:documents
npm run qa:i18n
npm run qa:web-updates
npm run qa:feedback          # 桌面/Web 反馈、脱敏、仓库变化、模拟机器人及防重发
npm run qa:platform          # 隔离官方会话、模拟 HTTP/OSS、真实 AIX 与 stdio MCP
node scripts/qa-diagnostics.mjs # 项目隔离、MCP/CLI 已读流转、重启及英文界面
```

`qa:platform` 覆盖登录立即同步与关窗、系统加密会话恢复、统一官方绑定、只读官网资料与图片、包/代码摘要、MCP 无法越过确认、取消与原生确认、退出后撤权。脚本的模拟提审不是实际提审，不使用日常账号；报告位于 `output/qa/platform/integration.json`。真实草稿上传、真实提审和上架须另记验证证据，不能用模拟通过替代。

浏览器测试默认寻找 macOS 的 Chrome。其他路径通过 `AIUI_QA_CHROME` 指定。录制测试可用 `AIUI_QA_FFMPEG`、`AIUI_QA_FFPROBE` 覆盖工具路径。

打包后运行：

```sh
npm run package
npm run qa:portable
```

`AIUI_QA_EXECUTABLE` 可指定自定义客户端路径。该检查会清空 PATH，验证应用、MCP、内置 npm/ADB/CLI、含中文及空格的项目路径、官方检查、AIX、模拟器、截图和重启持久化。证据位于 `output/qa/portable/`。

GitHub Actions 在 Linux、macOS 和 Windows 运行基础检查；Windows 另构建未签名 ZIP 并运行 `qa:portable`。真实眼镜测试单独执行，并明确记录设备和验证范围。

## 文档截图

资料库行为见 [官方资料库](document-library.md)。`npm run qa:documents` 检查完整目录层级、未打开长文的全文搜索与章节定位、更新设置持久化、真实离线配图、阅读历史和内部链接；加 `--desktop` 运行 Electron 验收。`npm run prepare:doc-images` 补齐已固定快照的离线图片。

`npm run qa:screenshots` 复制仓库内公开示例到全新的临时目录，完成实际运行、真实 stdio MCP 连接、断言和截图，更新 `docs/screenshots/`。截图包括中英文项目库与项目页、首次连接和成功连接、想法输入、新手指南、完整模拟器、资料和移除确认框；确认框只展示后取消。不读取日常客户端数据、设备或官方账号会话。报告保存在 `output/qa/documentation.json`。

## 输入与翻译

菜单输入遵循 [镜腿离散输入规范](rokid-discrete-input.md)。完整 down/up、keyup-only、自动重复、长滑、第二滑、反向、翻页和返回都需要覆盖。同步 Canvas 绘制必须排除阻塞时间；模拟不等于佩戴验证。

中文文案作为消息 ID，英文维护在 `shared/locales/en.json`。React 页面用 `t()` 与 `useLocale()`；保持英文占位符一致。主题集中在 `renderer/themes.css` 与 `renderer/theme.mjs`。
