# Windows 与中英文界面

Windows 目标为 Windows 10 / 11 x64。Electron 的系统要求见 [Electron 官方说明](https://github.com/electron/electron#platform-support)。当前独立客户端仅提供 x64 包；32 位 Windows 和原生 ARM64 包尚未提供。

## 使用独立客户端

1. 下载 `AIUI-Workbench-0.3.1-win32-x64.zip`，在资源管理器中完整解压。
2. 打开 `AIUI Workshop-win32-x64`，双击 `AIUI Workshop.exe`。保留同目录的 DLL、`resources`、`locales` 等文件。
3. 窗口右上角的地球图标旁常驻 **中文 / EN** 两个按钮，点击即可切换。项目名、源码和应用日志保留原文。
4. 导入现有 AIUI 项目，或新建项目并连接支持 MCP 的 AI 工具。
5. 连接眼镜需要对应机型的专用数据调试线，并在手机 Rokid AI App 中开启眼镜 ADB 调试。若设备管理器显示驱动异常，按照 Rokid 官方说明准备对应驱动。

客户端自带 Electron/Node、官方 CLI、npm、Ink WASM、官方资料快照和 ADB，不依赖系统 PATH。默认数据目录为 `%APPDATA%\AIUI Workbench`，可用 `AIUI_WORKBENCH_HOME` 覆盖。MCP 配置由当前客户端生成，使用随包运行时；Windows 路径中的空格和中文无需手动拼接命令或替换转义字符。

Windows 保留原生标题栏和最小化、最大化、关闭按钮。各系统均使用“打开文件位置”，避免把 Finder 专用文案显示给 Windows 用户。首次语言按系统或浏览器首选语言选择：中文使用中文界面，其余使用英文。手动选择会保存在本机，其他标签页会同步语言偏好。英文模式优先列出已有的官方英文资料，不改写官方文档内容。

Windows 正式 ZIP 仍为未签名包，当前没有 Windows 代码签名证书。

## 从源码构建

源码需要 Node.js 22.22 或更新版本。以下命令可在 Windows PowerShell、命令提示符或 macOS 终端执行：

```sh
npm ci
npm run package:win
```

`package:win` 显式选择 `win32/x64`，校验并携带 Windows ADB 及其依赖 DLL，生成 `.ico` 和 Windows 文件元数据，排除其他系统的 ADB，生成独立 ZIP、SHA256、字节数和更新清单。ZIP 使用跨平台流式写入，保留官方资料所需的隐藏文件，不依赖 PowerShell 的归档行为。

需要自定义目录时：

```sh
npm run build
node scripts/package.mjs --platform win32 --arch x64 --out output/windows
```

`AIUI_ELECTRON_ZIP_DIR` 可指向已有的官方 Electron ZIP 所在目录，文件名需保持 `electron-v45.2.1-win32-x64.zip`。使用前应与该版本官方 `SHASUMS256.txt` 核对。

## 验收及证据

```sh
npm test
npm run qa:i18n
npm run qa:portable
```

`qa:portable` 验证当前系统的独立客户端：清空 PATH 后启动客户端、服务和 MCP，运行内置 npm、ADB 和官方 CLI，在含中文、空格及 `&` 的隔离目录中新建项目、检查源码、构建 AIX、启动官方模拟器、截图、验证文件监听，并重启以验证持久化。不会向眼镜安装应用。

默认检查 `output/desktop/AIUI Workshop-win32-x64/AIUI Workshop.exe`。自定义目录可在 PowerShell 中指定：

```powershell
$env:AIUI_QA_EXECUTABLE = 'C:\AIUI Builds\AIUI Workshop-win32-x64\AIUI Workshop.exe'
npm run qa:portable
```

证据写入 `output/qa/portable/<platform>-<arch>/verification.json`；界面翻译和快捷切换证据写入 `output/qa/i18n/`。跨平台代码测试和 Windows 包结构校验不等同于真实 Windows 启动验收或眼镜连接验收，应分别记录结果。

## 维护翻译

中文原文是消息 ID，英文词条位于 `shared/locales/en.json`。React 界面使用 `t()` 并通过 `useLocale()` 订阅语言；带参数的句子使用 `{0}`、`{1}` 占位符。动态服务提示由 `translateMessage()` 按已知词条翻译，原始代码和应用日志不经过翻译。

新增文案要同时补全英文词条。测试会检查词条覆盖、英文占位符一致性和语言切换。日期使用当前界面语言；图标和“中文 / EN”按钮始终可识别，且不依赖用户读懂当前界面语言。
