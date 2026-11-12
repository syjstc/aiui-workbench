# Web 版与桌面客户端更新

## Web 启动

源码目录需要 Node.js 22.22 或以上版本，首次执行 `npm ci`，之后一条命令即可构建界面、自动连接或启动本地服务、打开浏览器：

```sh
npm run web
npm run web -- --port 3100 --no-open
```

端口默认由系统分配，避免冲突。显式指定的端口占用时会报错，不会偷偷切换。CLI 不接受公开监听地址，只监听 `127.0.0.1`。控制台中的完整链接包含随机会话口令，不应分享；浏览器完成握手后会从地址栏去掉口令，改用 HttpOnly / SameSite=Strict 会话 Cookie。

Ctrl+C 关闭 Web 入口。共享本地服务继续运行，桌面客户端和 MCP 不会因此断开。同一 `AIUI_WORKBENCH_HOME` 下的项目、预览、SDK、任务和 MCP 配置是同一份数据。Web 界面和预览运行时使用不同的来源，服务的控制口令不会下发到浏览器。

升级后会核对驻留服务的实际版本。经过身份核实且空闲的旧服务会自动退出，由当前版本重新启动；旧版界面、预览或任务仍在使用时会明确提示先结束旧版工作，不启动两个版本同时写同一数据目录，也不会自动降级较新的后台服务。

Web 的目录选择器浏览**服务所在电脑**的目录，也可输入绝对路径。照片从浏览器文件选择器导入本机数据目录，最大 10 MB。显示文件会打开本机文件管理器。

Web 的“登录官方平台／打开官方平台”会在系统浏览器打开官网，使用浏览器自己的会话；这个浏览器登录不会同步为工坊授权。工坊的上传、材料准备、官方列表读取以及 MCP / CLI 共用**桌面官方窗口**的加密会话，需要先在桌面登录并保持桌面运行。正式提审的原生确认与“退出官方账号”在桌面完成。操作和权限边界见 [草稿上传与提审](platform-uploads.md)。

已经准备好 npm `bin` 与包含构建产物的发布包。**当前尚未发布到 npm**；正式发布并确认包名归属后，用户可运行：

```sh
npx aiui-workbench@latest
# 或安装后直接启动
npm install -g aiui-workbench
aiui-workbench --port 3100
```

`npm pack` 在发布前构建界面，包内不包含用户数据、开发截图或 Electron 二进制。运行时按 Node 的模块解析规则找到依赖，支持 npm/npx 将依赖提升到包外的安装布局。

## 桌面客户端设置

侧栏“设置”中可以选择 GitHub、CNB、Gitee、自定义 HTTPS 源，分别保留地址，启用或关闭启动自动检查，选择每天或每周的后台检查频率。每次启动都会检查一次；之后按设定频率检查。未填写发布源时显示未配置，不联网，也不显示“已是最新版”。

GitHub 源读取公开仓库的 `/repos/{owner}/{repo}/releases/latest`，要求最新稳定发行版附件中有 `workbench-update.json`，并验证清单版本与 Tag 一致。私有仓库和需要登录的附件未接入。

CNB、Gitee、自定义源读取发布者提供的**公开、可直接下载的 HTTPS JSON 清单地址**，不猜测平台 API 或网页地址，也不绕过登录与验证码。平台附件地址会随版本变化时，可把稳定清单放在公开原始文件地址、对象存储或自己的 HTTPS 域名下，清单内指向当前安装包。只变更安装包托管平台时，修改清单即可；清单入口变化时，用户在设置中修改地址。

切换来源或修改配置会清除旧源的结果与下载记录，防止旧版本信息跨源沿用。网络失败、404、错误清单与缺少当前平台安装包都会单独显示。稳定版本使用 semver 比较，不提供降级或预发布版。

0.4.0 起，左下角持续显示新版本提醒，可暂时收起，后续新版本会重新提示。开启自动检查后，启动时会检查，回到应用时最多每五分钟补查一次，后台继续按设置的频率检查。

macOS 点击“下载并重启升级”后，会下载并验证 SHA256、大小、应用身份、版本、处理器架构、Developer ID 签名与 Gatekeeper 状态，再准备替换。运行中的任务或录制会阻止升级；替换失败会恢复原应用。项目和工作记录保存在独立数据目录中。安装目录必须可写；从只读 DMG 运行时，请将应用拖入“应用程序”后再使用。

Windows 提供下载与手动安装入口，尚不自动覆盖便携目录；维护者也尚未完成 Windows 实体机器的完整体验验证。macOS 的签名、公证与 DMG 制作按 [发布流程](releasing.md) 执行。

## 发布文件

`assets/updates.json` 是随应用携带的初始来源设置。正式发行前可填写自己的仓库和国内镜像地址；用户本地设置保存在数据目录的 `app-updates.json`。

```sh
npm run package
```

生成当前平台应用、带版本与架构的压缩包，以及同目录的 `workbench-update.json`。上传安装包后再上传清单。GitHub Release 中附件名必须保持 `workbench-update.json`。相对安装包链接以发布者的清单入口地址为基准解析，不以临时 CDN 跳转地址为基准；使用不保留附件目录结构的平台或跨站托管时，通过下面的 `--base-url` 生成绝对安装包地址。

跨平台包合并为一个清单：

```sh
npm run release:manifest -- \
  --file darwin:arm64:/path/AIUI-Workbench-0.3.1-darwin-arm64.zip \
  --file win32:x64:/path/AIUI-Workbench-0.3.1-win32-x64.zip \
  --base-url https://your-host.example/releases/v0.3.1/ \
  --release-url https://your-host.example/releases/v0.3.1 \
  --out output/desktop/workbench-update.json
```

`--notes-file` 可附加更新说明。版本默认取 `package.json`；可通过 `--version` 明确指定。

```json
{
  "schemaVersion": 1,
  "version": "0.3.1",
  "notes": "Web 入口与可选择的桌面更新源",
  "files": [
    {
      "platform": "darwin",
      "arch": "arm64",
      "url": "https://your-host.example/AIUI-Workbench-0.3.1-darwin-arm64.zip",
      "sha256": "填写安装包的64位SHA256十六进制摘要",
      "size": 123456789
    }
  ]
}
```

平台值为 `darwin`、`win32`、`linux`，架构使用 Node 的 `process.arch` 值。脚本会从真实文件计算摘要与字节数；每个平台与架构组合只能有一个包。更新清单与安装包需要由可信发布者通过 HTTPS 提供，SHA256 用于核对传输内容，不代替系统代码签名。

## 托管平台依据

- [GitHub Releases 官方 API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)：公开资源可不携带访问令牌读取。
- [CNB Release 官方文档](https://docs.cnb.cool/zh/build/internal-steps/git/release.html)：支持发行版，附件可通过官方 attachments 插件上传。
- [Gitee 官方发行版说明](https://help.gitee.com/repository/release/create)：当前普通项目单附件上限 100 MB，GVP 为 200 MB，完整桌面包需先确认是否满足限额。
- [Electron autoUpdater 官方文档](https://www.electronjs.org/docs/latest/api/auto-updater/)：macOS 自动安装更新需要应用签名。

GitHub 源码仓库与正式桌面附件按 [发布流程](releasing.md) 管理；npm 包尚未发布。

## 验证

```sh
npm test
npm run qa:web-updates
```

自动化使用隔离数据目录和明确标注的模拟发行源，验证浏览器工作流、MCP 共享、真实 Electron 的更新设置、启动检查、下载校验、来源切换与持久化。不会替换当前应用或向眼镜安装软件。
