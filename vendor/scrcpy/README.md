# 内置真机投屏

客户端使用 Genymobile 官方 scrcpy 5.0.1 的完整静态发行包，程序、视频运行库和 Android 服务端随客户端提供。运行时不查找系统 scrcpy、Homebrew 或 PATH，也不下载组件。ADB 始终通过绝对路径使用工坊 `vendor/adb/` 中的版本。

发行源：https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1

`manifest.json` 固定各平台官方归档的 SHA256 与字节数。`scripts/prepare-scrcpy.mjs` 在打包阶段验证下载，保留上游 LICENSE、图标和说明，移除归档中重复的 ADB，生成逐文件校验记录 `bundle.json`。macOS 提供 arm64 和 x64；Windows 与 Linux 提供 x64。桌面包只保留自身平台。

macOS 静态程序只链接系统框架和 `/usr/lib`，不链接 `/opt/homebrew` 或 `/usr/local`。Windows 所需的非系统 DLL 随上游归档一并内置。Linux 仍需要正常的图形桌面环境；Windows/Linux 尚未在本机完成真机验收。

默认禁用音频转发、自动剪贴板同步及键盘自动重复。用户点击“打开真机投屏”才会启动独立窗口；默认支持鼠标点击、拖动及键盘操作。关闭窗口或点击“停止投屏”只结束相应投屏进程，不结束 ADB 服务或眼镜应用。
