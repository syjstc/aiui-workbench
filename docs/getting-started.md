# 从示例开始

本指南使用仓库里的 Hello AIUI 和 Motion Lab。截图来自电脑上的真实 Ink 运行时，输入由模拟器发送。

## 1. 安装并导入示例

从 [GitHub Releases](https://github.com/syjstc/aiui-workbench/releases/latest) 下载与你系统匹配的 ZIP，并核对同页 SHA256。macOS 解压后把应用放入“应用程序”；Windows 完整解压后启动 `AIUI Workshop.exe`，保留同目录的资源与 DLL。

在“项目库”点击“导入项目”，选择本仓库的 `examples/hello-aiui`。再导入 `examples/motion-lab`。也可以直接点击“新建项目”，生成官方 Page 模板。

![只导入公开示例的项目库](screenshots/projects-zh.png)

项目源码仍保存在你选择的目录。用编辑器或 AI 工具修改后，工坊会监听变化并刷新预览。

## 2. 运行、滑动和返回

点击 Hello AIUI 的项目卡片。方向键在三个选项间切换，Enter 进入分页状态，Backspace 返回；菜单下再次返回会退出至模拟器桌面。

右侧“交互”面板可以发送普通滑动、8 条重复别名事件和约 1.5 秒的长滑。一次同方向连发应只移动一项；停顿后再次滑动移动下一项。示例使用 [离散输入模块](../examples/hello-aiui/lib/temple-navigation.js)，详情见 [输入规范](rokid-discrete-input.md)。

![Hello AIUI 的实际模拟画面](screenshots/simulator-zh.png)

## 3. 调节头部姿态

运行 Motion Lab。鼠标移入画面后移动即可调节转头与俯仰，Shift + 移动调节侧倾。也可以操作头模、三轴滑条，或在“演示”面板循环播放动作。

画面中的四元数来自应用订阅的官方 `AbsoluteOrientationSensor`。隐藏和退出页面会停止订阅。关闭“模拟姿态流”可以检查断流时的行为。

![Motion Lab 与头部模型共享姿态](screenshots/motion-zh.png)

## 4. 让 AI 与工坊协作

打开“连接 AI 工具”，复制当前客户端生成的 MCP 配置。将其添加到支持 stdio MCP 的工具，然后让 AI 先调用 `aiui_context_get`。不需要把整个项目复制进另一套环境。

![MCP 连接配置与任务示例](screenshots/mcp-zh.png)

可以给 AI 这样的任务：

> 读取项目官方规范，修改这个 Page；用 aiui_preview_test 验证长滑、重复方向事件、停顿后第二滑、反向、分页与返回，通过后用 aiui_project_build 检查并生成 AIX。明确区分模拟与佩戴验证。

工具名、参数和 CLI 用法见 [AI 工具工作流](ai-tool-workflows.md)。工坊本身不内置模型；使用哪个 AI 服务由你选择。

## 5. 查资料、构建和连接眼镜

“官方资料”可离线搜索、阅读开发指南和 API；正文的官方文档链接会在工坊内打开。“查看原文”访问上游来源。

![可搜索的官方离线资料](screenshots/docs-zh.png)

“构建与上传”按三个步骤引导：

1. **在工坊检查并打包**：选择应用，点击“检查并打包 AIX”。检查通过后生成本地 `application.aix`；点击“定位 AIX 文件”打开所在文件夹，或复制文件路径。“构建详情”中可以核对代码指纹、引擎要求和 SHA256。代码或 SDK 变化后需要重新打包。
2. **上传为云端草稿**：点击“登录官方平台”完成首次登录，后续复用系统加密的会话。在工坊选择已有智能体，核对正式名称和 Agent ID，点击“上传为草稿”。工坊回读云端版本和包摘要后才显示已核对。新应用先在官方平台创建身份。云端版本与本地游戏版本分别保留。
3. **准备材料并确认提审**：AI 可通过 MCP 上传图标、图片、视频和文案，保存为提审草稿。用户在工坊核对资料，并在原生确认窗口提交审核。上传或保存材料本身不会提审；发布仍由用户另行确认。

登录、安全边界与 MCP 示例见 [草稿上传与提审](platform-uploads.md)。审核结果及上架状态以官方平台为准；材料要求见 [官方提审规范](https://github.com/yodaos-project/AIUI/blob/main/documentation/0-guide/bundle/publish.md)。

连接眼镜请按“新手指南”执行：使用对应机型的专用数据调试线，在手机 Rokid AI App 中开启眼镜 ADB 调试，并授权电脑。多台设备时必须先选目标，再安装或启动。投屏和文件工具位于独立的“眼镜工具”页。

## 常见问题

| 情况 | 处理 |
| --- | --- |
| Windows 解压后打不开 | 确认解压了完整 ZIP，EXE 的 DLL 和 resources 均在原目录；核对来源与 SHA256，查看系统提示 |
| 没有发现眼镜 | 检查数据调试线、手机端 ADB 开关和设备授权；Windows 检查驱动；展开连接诊断 |
| 相机没有画面 | 先在模拟器“相机”页选择照片或主动选择电脑摄像头，再让应用请求取景 |
| AI 与桌面项目列表不同 | 使用当前工坊生成的配置，确认双方的 `AIUI_WORKBENCH_HOME` 一致 |
| SDK 更新后行为变化 | 先执行兼容性检查，逐项目切换；需要时回退项目绑定的版本，再做模拟和真机复测 |

模拟输入通过只能说明对应的模拟链路和断言通过。佩戴手势、相机光学、舒适度、性能和平台上架仍需各自验收。
