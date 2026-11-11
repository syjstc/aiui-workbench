# AI 工具：MCP 与共享 CLI

AI 用现有编码工具修改真实源码，工坊负责运行、等待、模拟输入和结果核对。MCP、桌面、Web 和工坊 CLI 连接同一个本地服务；使用相同的 `AIUI_WORKBENCH_HOME`，即可共享项目 ID、预览会话、应用/SDK 日志、截图路径、构建任务和结果。

## 升级与稳定连接

MCP 与共享 CLI 不要求自己的应用版本和后台服务版本一致，也不会为了版本差异停止正在使用的工坊。它们从已认证的本机服务 `/api/tools` 读取实际工具及 JSON Schema；`aiui_tools_list` 和 `aiui://tools` 提供相同清单。服务替换后，现有 MCP 进程重新发现端口和口令，并在工具清单变化时发送 MCP 通知。已经发出的写操作不会因响应丢失而自动重放。

连接页生成的配置使用数据目录中的固定启动入口；启动新版工坊会更新入口指向的程序，因此升级或更换安装目录后不必重新复制这份配置。未启动工坊时，入口使用最近一次注册的安装启动后台。桌面本身仍会确认后台与其界面匹配，并在旧版没有运行任务和活动界面时切换到新版。

原来直接指向应用内 `mcp/server.mjs` 的配置，在原安装路径覆盖升级后仍可使用；如果删除或移动了配置直接引用的可执行文件，必须先改用连接页的固定入口。尚未提供工具发现接口的旧服务按其能力声明提供兼容工具子集，不冒充新版完整功能。

`npm run qa:mcp-stability` 在隔离目录中验证真实安装包的旧配置、固定入口、无系统 Node 的冷启动、CLI 同步和服务替换后重连；报告保存在 `output/qa/mcp-stability/packaged-acceptance.json`。源码回归另覆盖跨版本服务、新工具与参数发现、能力变更通知、失去响应时不重放写操作、崩溃遗留启动锁和连接文件归属。

## 优先使用组合调用

| 需求 | 工具 | 一次调用返回 |
| --- | --- | --- |
| 发现能力 | `aiui_capabilities_get` | 工具用途、参数示例、模拟能力与当前边界 |
| 项目开发规范 | `aiui_context_get` | 绑定的 SDK/CLI、官方 Skill、资料版本与工作流 |
| 模拟验证 | `aiui_preview_test` | 打开当前源码、等待运行时、顺序操作、显式断言、PNG、日志与 JSON 报告 |
| 检查与打包 | `aiui_project_build` | 官方检查、真实 AIX、SHA256、源码/SDK 版本、平台导入清单 |
| 等待长任务 | `aiui_job_wait` | 同一任务的最新或最终结果，不会重新执行 |
| 定位 CLI | `aiui_cli_info` | 本机可执行路径、参数、数据目录和同步边界 |
| 录制短片 | `aiui_record_clip` | 一次录制 1–30 秒，返回完成封装的视频、SHA256 与来源 |

`aiui_preview_test` 和 `aiui_project_build` 默认等待最多 45 秒；完成时直接返回 `status` 和 `result`。只有返回 `status: "running"` 才需用任务 `id` 调用 `aiui_job_wait`。`waitMs: 0` 可立即返回任务；通过 `aiui_job_cancel` 取消。MCP 中失败任务返回 `isError: true`，仍保留结构化诊断、报告和可用的截图。CLI 中失败任务输出同一份 JSON，并返回非零退出码。

## 一次完成模拟

先用 `aiui_project_import` 或 `aiui_project_create` 获取项目 ID，再调用：

```json
{
  "name": "aiui_preview_test",
  "arguments": {
    "projectId": "<projectId>",
    "steps": [
      {
        "name": "长滑只移动一项",
        "action": "swipe",
        "parameters": {
          "direction": "forward",
          "repeats": 24,
          "intervalMs": 65,
          "keyupOnly": true,
          "aliases": true
        },
        "expect": {
          "logCount": { "contains": "MENU_CHANGED", "count": 1 }
        }
      },
      {
        "action": "swipe",
        "waitMs": 400,
        "parameters": { "direction": "forward" },
        "expect": { "logContains": "MENU_CHANGED" }
      },
      {
        "action": "pose",
        "parameters": { "yaw": 12, "pitch": -5, "roll": 0 },
        "expect": { "state": { "pose.yaw": 12 } }
      }
    ]
  }
}
```

`MENU_CHANGED` 是示例应用需要主动打印的日志标记，应替换为实际项目的业务日志。`expect.state` 读取模拟器状态，例如姿态、相机权限和 `running`，不读取应用私有数据。业务行为需要项目日志断言和截图检查；未配置断言时，报告将标记 `runtime-smoke-only`，不能据此宣称业务功能正确。

每个步骤支持 `waitMs`（操作前暂停）、`settleMs`（操作后观察，默认 200 ms）、`timeoutMs`（等待断言，默认 3000 ms）。`logContains` 与 `logCount` 只读取本步骤新产生的日志，旧日志不能满足新断言。精确次数应给出覆盖异步回调的 `settleMs`。最多 40 个步骤，回放有 90 秒执行上限；较长流程应拆分。

默认重新加载应用并截取最终画面。关闭应用后不会生成伪造截图，报告包含 `captureSkipped`。模拟器已在桌面/Web 运行时直接复用；没有界面连接时尝试在本机浏览器打开运行时。浏览器不能打开或运行时未就绪会返回失败。不要同时关闭正在执行测试的运行时。

PNG 和报告带源码摘要、SDK/引擎版本和运行实例 ID。测试期间源码、SDK 或实例变化会使结果失效。默认应用错误日志也会使验收失败。模拟通过仍需实际画面和目标眼镜佩戴验收。

## CLI 与 MCP 的同步

源码目录可这样调用；安装 npm 包后将 `node web/cli.mjs` 换成 `aiui-workbench`：

```sh
node web/cli.mjs tools aiui_preview_test
node web/cli.mjs call aiui_cli_info --args '{}'
node web/cli.mjs call aiui_preview_test --args-file /absolute/simulation.json
node web/cli.mjs call aiui_project_build --args-file /absolute/build.json
node web/cli.mjs call aiui_preview_logs --args-file /absolute/logs.json
node web/cli.mjs mcp
```

参数文件只包含工具参数，例如 `build.json` 是 `{"projectId":"..."}`，不包裹 `name` 或 `arguments`。所有命令默认输出 JSON；截图返回本机 PNG 路径与 SHA256，不在终端打印 base64。`tools [工具名]` 使用与 MCP 相同的输入契约。

独立桌面包无需系统 Node。通过 `aiui_cli_info.shared` 获取正确的 `command`、`args` 和 `env`，按原样用进程 API 调用。尤其保留 `AIUI_WORKBENCH_HOME`；Electron 自带运行时时还需 `ELECTRON_RUN_AS_NODE=1`。不要把另一份 `.local` 或默认数据目录混为同一个服务。

工坊 CLI 的 `call` 会记录为 `CLI` 客户端，模拟器请求也会自动切换桌面。CLI 触发的任务可用 MCP 的同一任务 ID 查询；MCP 发出的模拟事件可用 CLI 读取同一日志游标。

内置官方 `aix` 的路径与项目绑定版本在 `aiui_cli_info.official`。**直接执行 `aix` 是独立进程**：其终端输出不会自动进入工坊任务记录，另起的预览也不是工坊的共享会话。需要同步时使用工坊 `call`；检查、打包和安装底层仍使用绑定的官方 CLI。

## 日志与发布边界

### 录制视频供后续剪辑

在 `aiui_preview_test` 参数中加入 `"record": true`，即可一边回放操作一边录制实际应用 canvas。结果 `result.video` 包含视频本机路径、格式、时长、尺寸、SHA256、源码版本及 `simulated: true`。模拟器优先使用浏览器内置 MP4 编码器，无法使用时降为 WebM；不依赖用户另装 FFmpeg。单独录制可调用：

```json
{"name":"aiui_record_clip","arguments":{"source":"simulator","projectId":"<projectId>","durationSeconds":10,"fps":24}}
```

```json
{"name":"aiui_record_clip","arguments":{"source":"glasses","serial":"<serial>","durationSeconds":10,"fps":24,"rotation":0}}
```

真机通过内置 scrcpy 直接记录眼镜显示屏为 MP4，可与投屏窗口同时使用，不发送操作按键。来源标记为 `simulated: false`、`opticalCapture: false`；这是屏幕录制，不是透过镜片拍摄的光学实景。

真机的 `durationSeconds` 是采集进程时间上限，包含编码启动时间，最终可播放时长以视频容器读取的 `durationMs` 为准。帧率是采集目标或上限，静态真机画面可能使用可变帧率。录制命令采用 [scrcpy 官方录制参数](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/recording.md)。

需要边操作边录制较长场景时，先 `aiui_record_start`，通过其他工具操作，再 `aiui_record_stop` 等待文件封装；最长 120 秒会自动停止。`aiui_record_status` 查询共享记录，只有 `completed` 才是已封装视频。中断、编码或连接失败会显示错误；静止模拟画面仍按所选帧率采样。模拟器重新载入或应用退出时先保存当前录制。

桌面模拟器和真机投屏页均有开始/停止录制和打开视频位置按钮。当前录制无声音，文件默认位于工坊数据目录 `recordings/`。CLI 与 MCP 可交叉开始、停止和查询同一段录制。视频文件保留在本地，AI 可继续用剪辑工具拼接、加字幕和导出短片。

录制验收：`npm run qa:recording -- <serial>`。脚本用真实 Ink 自动回放并录制、CLI/MCP 交叉控制、真实眼镜并行投屏录制，再使用本机 QA 的 FFprobe/FFmpeg 完整解码检查；FFmpeg 仅用于开发验收，不是录制运行依赖。证据及样片位于 `output/qa/recording/`。

`aiui_preview_logs` 支持 `afterSequence`、`level`、`contains` 和 `runId`。下一次将 `afterSequence` 设为上次 `nextSequence`，即可增量读取；`truncated` 表示游标之前的日志已超出保留范围。清空日志不会重用序号。

`aiui_project_build` 遇到官方检查失败会停止打包，返回诊断；检查与打包期间源码/SDK 变化也会失败。`uploaded`、`submittedForReview` 始终为 `false`。平台登录、导入、上传和审核仍需独立完成，当前没有已验证的自动上传/提审接口。

## 复验

```sh
npm test
npm run qa:mcp-workflows
```

验收脚本使用隔离数据目录、真实 stdio MCP、工坊 CLI、Electron、官方 Ink 和真实 AIX 打包。覆盖长滑、重复方向别名、停顿后第二滑、反向、翻页返回、姿态断流、照片、权限拒绝、失败断言、错误日志、源码变化和取消。能力页同时检查中文、英文、复制参数和窗口宽度。浏览器独立运行的验收将系统打开操作定向到隔离 Chrome，不使用用户浏览器资料。证据位于 `output/qa/mcp-workflows/`。
