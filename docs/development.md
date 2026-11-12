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
| `core/` | 共享本地服务、项目、SDK、资料、设备、任务与录制 |
| `electron/` | 原生窗口、受控 IPC、系统权限和 macOS entitlements |
| `renderer/` | React 工作台、中英文、主题、设备与资料界面 |
| `preview/` | 独立来源的官方 Ink 宿主、输入、姿态、媒体适配 |
| `mcp/` | stdio MCP 接入，使用共享服务的实际工具定义 |
| `web/` | 本地浏览器入口与工坊 CLI |
| `examples/` | 可独立导入、无业务项目依赖的公开示例 |
| `vendor/` | 上游快照、工具来源与固定摘要 |
| `tests/`、`scripts/` | 单元测试、真实桌面/MCP 集成、打包与发布 |

桌面、Web、CLI 和 MCP 使用同一个本地服务；预览页面在独立来源运行，不能访问 Node 或服务控制口令。官方登录使用单独会话。

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
```

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

`npm run qa:screenshots` 复制仓库内公开示例到全新的临时目录，完成实际运行、断言和截图，更新 `docs/screenshots/`。不读取日常客户端数据、设备或官方账号会话。报告保存在 `output/qa/documentation.json`。

## 输入与翻译

菜单输入遵循 [镜腿离散输入规范](rokid-discrete-input.md)。完整 down/up、keyup-only、自动重复、长滑、第二滑、反向、翻页和返回都需要覆盖。同步 Canvas 绘制必须排除阻塞时间；模拟不等于佩戴验证。

中文文案作为消息 ID，英文维护在 `shared/locales/en.json`。React 页面用 `t()` 与 `useLocale()`；保持英文占位符一致。主题集中在 `renderer/themes.css` 与 `renderer/theme.mjs`。
