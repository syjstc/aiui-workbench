# GitHub 真实升级验收

`release-update.yml` 在 GitHub Release 发布后自动触发 macOS 与 Windows 验收，也可从 Actions 手动触发。此检查使用真实公开 GitHub API 和附件，不模拟发行源。

```sh
npm run qa:github-upgrade
```

默认目标版本取当前 `package.json`，上一版为同一版本线的前一个 patch。可指定：

```sh
AIUI_UPDATE_FROM_VERSION=0.3.1 AIUI_UPDATE_TARGET_VERSION=0.3.2 npm run qa:github-upgrade
```

两版 Release 都必须已经公开，并且包含匹配系统架构的 ZIP 和 `workbench-update.json`。macOS 使用 Apple Silicon；Windows 使用 x64。

## 实际验证范围

1. 从上一版 GitHub Release 下载清单和客户端，核对 SHA256 和字节数。
2. 使用隔离数据目录及公开示例启动真实旧版客户端，让它在启动时自动检查 GitHub 源，发现新版本。
3. 由旧版客户端下载真实安装包，再独立核对摘要与大小。
4. 关闭该隔离客户端和它的服务，解压新包。在 macOS 复验签名、公证票据和 Gatekeeper。
5. 使用同一个隔离数据目录启动新版，确认版本更新、项目 ID 和源码保留、同版不再提示更新。
6. 在下载到的新版本中实际验证解绑和系统废纸篓／回收站删除，包含两步确认及错误名称的阻止行为。

测试以解压并启动新客户端完成安装验收，不覆盖正在运行的日常应用，也不修改个人业务项目。产品更新仍是自动检测、用户下载、用户安装的流程。

报告和截图位于 `output/qa/github-upgrade/<platform>-<arch>/`；Actions 会保留同名验证附件。测试只移动自己创建的公开示例副本到系统废纸篓／回收站。
