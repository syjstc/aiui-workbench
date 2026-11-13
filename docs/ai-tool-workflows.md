> 完整自动制作优先使用 `aiui_workflow_start → 编辑真实源码 → aiui_workflow_continue`；阻塞读共享诊断并继续原任务。详见 [自动制作与故障恢复](automated-development.md)。以下逐项工具仍完整保留。

工坊反馈可直接填写「反馈与建议」表单，无需 AI。已经连接 MCP 的外部助手也可调用 `aiui_feedback_prepare` 填写草稿，用 `aiui_feedback_status` 读取记录。工坊本机按固定规则脱敏并生成预览，此反馈流程不调用模型。只接受已定位的工坊缺陷或用户主动建议，目标跟随当前更新源仓库，由用户核对后通过统一机器人提交。普通应用错误留在原项目，不批量公开诊断；MCP 不提供 issue 发布工具。详见 [反馈范围与部署](feedback.md)。

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
| 官方登录与回执 | `aiui_platform_status` | 登录、统一绑定、上传及提审回执；`reconcile: true` 只读回查未知结果 |
| 官网应用列表 | `aiui_platform_agents` | 当前账号的图标、资料、媒体、草稿／审核／已上架版本，只读 |
| 上传新草稿 | `aiui_platform_upload` | AIX 与一致的代码 ZIP 上传、官方摘要核对，不提审 |
| 保存提审材料 | `aiui_platform_review_prepare` | 文案、图标、预览和权限用途保存为提审草稿，不提审 |
| 请求本人确认 | `aiui_platform_review_request` | `awaiting-user` 草稿与 `requiresUserConfirmation: true`，不提交审核 |

`aiui_preview_test` 和 `aiui_project_build` 默认等待最多 45 秒；完成时直接返回 `status` 和 `result`。只有返回 `status: "running"` 才需用任务 `id` 调用 `aiui_job_wait`。`waitMs: 0` 可立即返回任务；通过 `aiui_job_cancel` 取消。MCP 中失败任务返回 `isError: true`，仍保留结构化诊断、报告和可用的截图。CLI 中失败任务输出同一份 JSON，并返回非零退出码。

## Skill 更新和常用流程

`aiui_context_get` 先检查磁盘上的工坊管理副本，再处理 `existingSkills`。已加载的同名 Skill 不会造成重复安装，也不再跳过全局/继承副本的版本检查。未修改的管理副本连同参考文件一起更新；完整内容与已知官方原版一致的副本可纳入管理；用户改动和符号链接保留。项目官方规范仍使用绑定版本，全局官方副本跟随当前官方资料。

成功读取过的用户/项目范围会保存在工坊中，在下次启动和官方资料同步后再次检查已有管理副本，不另行安装缺失副本。客户端可能缓存已加载的 Skill，因此当前调用直接返回最新入口规范；参考文件可按需用 `aiui_skill_read` 读取，无须重复拉取完整上下文。常用场景包含镜腿输入、3DoF、相机、录制、失败恢复和临时 AI 验证。

## 仅供 AI 自动化的模型接管

普通用户在模拟器中使用识图、问答等 AI 功能时，界面提示到真机测试。工坊不启动独立 AI 进程，不唤醒空闲聊天。独立模型后端需要自行配置和维护，属于备选集成方案，当前没有配置界面，不推荐作为默认路径。

AI 正在自动验证应用时，可临时接管实际 `LanguageModel` 请求：

```text
aiui_ai_configure（如实声明 supportsImages）
→ 触发应用，或 aiui_preview_test(waitMs=0)
→ aiui_ai_wait（本地阻塞等待新请求）
→ 当前 AI 查看问题/图片并推理 → aiui_ai_reply
→ 检查应用行为/继续原测试 → aiui_ai_configure(enabled=false)
```

图片通过 MCP 原生附件提供，正文只保留附件编号，避免重复 Base64。AI 没有图片多模态能力或无法确认时必须声明 false；图片请求返回 `device-required`，AI 必须主动提示用户去真机测试，不得伪造识图通过。完整步骤按需读取 `aiui_skill_read(path="references/simulator-ai.md")`。

默认接管有效期 3 分钟、最多 6 个请求，每次输入 12,000 字符、输出 2,000 字符；最多 2 张图片，每张 1 MB、最长边 1024 像素。空闲等待只返回简短 `idle`，AI 随即停止监听，不循环轮询。关闭、重载、源码变化、超时和额度耗尽会取消旧请求，一次性回填凭据不能用于新会话。`promptStreaming` 接收最终答案的一次增量，未模拟模型逐 token 生成的延迟。语音与设备服务链路仍在真机验收。

`npm run qa:simulator-ai` 用真实 Ink SDK、HTTP 和 stdio MCP 验证接管传输；默认回答是明确标记的固定测试数据。设置 `AIUI_AI_QA_MANUAL=1` 可由当前 AI 实际查看返回图片后回填，不能将固定数据测试称作真实识图。证据在 `output/qa/simulator-ai/`。

## 一次完成模拟

模拟器右侧「交互」提供「长按镜腿」，可选择 0.5–5 秒，默认 1.5 秒。点击画面使其获得焦点后，也可按住键盘 Enter。MCP/CLI 的 `aiui_preview_action`、`aiui_preview_test` 和 `scenario` 支持 `action: "longpress", parameters: { "durationMs": 1500 }`：按下 Enter，保持指定实际时长，再抬起一次。长按业务由应用自己的按键处理判断；长滑重复事件测试仍是独立操作。

先用 `aiui_project_import` 或 `aiui_project_create` 获取项目 ID。导入支持项目根目录或 `agent/` 子目录；直接导入 `agent/` 时，工坊也会读取并监听同级的 `assets/`、`branding/`、`icons/` 图标，遵循 `current.json` 选定的版本。导入目录仍是项目绑定和删除的范围，品牌素材不会加入应用源码包。未提供图标的项目显示默认应用图标。

再调用：

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

## 草稿上传与用户确认提审

首次登录由用户在桌面“构建与上传 → 登录官方平台”完成；使用 Web / CLI / MCP 时也保持桌面运行，复用其有效加密会话。用户在工坊界面把本地应用绑定到一个正式名称和官网 Agent ID，构建、上传及提审共用此绑定。MCP 只能读取绑定，不能更改或从本地 UUID 推断官方身份。

```text
aiui_platform_status / aiui_platform_agents → 用户在工坊设置官方绑定
→ aiui_project_build → aiui_platform_upload
→ aiui_platform_review_prepare → aiui_platform_review_request
→ 用户在桌面核对，并在原生窗口确认提交审核
```

上传和准备材料返回任务；只有 `status: running` 时才继续 `aiui_job_wait`。材料任务成功后，使用 **`job.result.id`** 作为后续 `draftId`，不要使用 `job.id`。例如：

```json
{"name":"aiui_platform_review_request","arguments":{"projectId":"<projectId>","draftId":"<reviewPrepareJob.result.id>"}}
```

此调用直接返回草稿，`stage: awaiting-user` 只表示等待用户确认。MCP 没有正式提审、发布或云端删除工具；传入 `confirm: true` 不会取得原生确认授权。用户确认时应确保版本和材料可公开发布，审核通过后的上架规则以官方平台为准。

`aiui_platform_agents` 和工坊“官网应用”标签页只读已有官方记录。MCP 仍可通过上传工具创建新草稿、准备材料并请求本人确认。删除只能由用户在官网操作；清理本机任务日志不删除云端记录。

上传或保存结果不明时，不自动重试，先调用：

```json
{"name":"aiui_platform_status","arguments":{"projectId":"<projectId>","reconcile":true}}
```

显式恢复同一次上传需保持账号、项目、绑定、包和资料不变，并传原回执 `id` 为 `resumeUploadId`；确认提审后结果不明时去官网核对，不再次提交。

CLI 的参数文件只放对应工具的参数对象；不包含 Cookie、账号令牌或 `name` / `arguments` 外壳：

```sh
node web/cli.mjs tools aiui_platform_upload
node web/cli.mjs call aiui_platform_upload --args-file /absolute/upload.json
node web/cli.mjs call aiui_platform_review_prepare --args-file /absolute/materials.json
node web/cli.mjs call aiui_platform_review_request --args-file /absolute/request.json
```

完整参数示例、材料限制、状态解释与当前真实验证范围见 [平台草稿与提审](platform-uploads.md) / [English guide](platform-uploads.en.md)。官方接口仍为实验集成，草稿上传成功不表示审核通过或已经上架。

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

`aiui_project_build` 遇到官方检查失败会停止打包，返回诊断；检查与打包期间源码/SDK 变化也会失败。构建结果的 `uploaded`、`submittedForReview` 为 `false`。后续用 `aiui_platform_upload` 上传并核对云端草稿，用 `aiui_platform_review_prepare` 上传材料并保存提审草稿，`aiui_platform_review_request` 请求用户在工坊确认。MCP 不能代替用户确认或发布，详见 [草稿上传与提审](platform-uploads.md)。

## 复验

```sh
npm test
npm run qa:mcp-workflows
```

验收脚本使用隔离数据目录、真实 stdio MCP、工坊 CLI、Electron、官方 Ink 和真实 AIX 打包。覆盖长滑、重复方向别名、停顿后第二滑、反向、翻页返回、姿态断流、照片、权限拒绝、失败断言、错误日志、源码变化和取消。能力页同时检查中文、英文、复制参数和窗口宽度。浏览器独立运行的验收将系统打开操作定向到隔离 Chrome，不使用用户浏览器资料。证据位于 `output/qa/mcp-workflows/`。
