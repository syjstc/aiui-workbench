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

在“构建与上传”中执行源码检查、生成 AIX，并核对源码摘要、SDK 版本和 SHA256。若继续向官方平台导入，需要在官方窗口完成登录和操作；工坊不会把本地打包结果当成已上传。

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
