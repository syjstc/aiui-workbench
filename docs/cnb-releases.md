# CNB 最新版分发

GitHub 保留正式发布历史；独立的 CNB 公开下载仓库只维护一个 `stable` Release。不要为每次镜像重新构建安装包：直接复用 GitHub Release 中完成签名、公证及平台验收的 ZIP / DMG，保持字节与 SHA256 一致。

## 公开入口

固定清单地址：

```text
https://cnb.cool/<组织>/<仓库>/-/releases/download/stable/workbench-update.json
```

固定的手动下载地址使用 `latest` 文件名，例如：

```text
https://cnb.cool/<组织>/<仓库>/-/releases/download/stable/AIUI-Workbench-latest-darwin-arm64.dmg
https://cnb.cool/<组织>/<仓库>/-/releases/download/stable/AIUI-Workbench-latest-win32-x64.zip
```

`stable` 是真实的固定标签，不依赖平台对 `latest` 的特殊解释。分享 CNB 附件入口，不要分享跳转后的临时对象存储 URL。公开仓库的用户下载无需 CNB 账号或发布令牌。

## 首次配置

1. 在 CNB 登录自己的账号，创建一个专用的公开下载仓库，初始化 `main` 分支。不要复用已有其他 Release 的仓库。
2. 创建仅可操作该仓库 Release 的访问令牌；当前 OpenAPI 所需权限是 `repo-release:rw`。令牌只供发布使用，不写进应用、清单或 Git。
3. 在 GitHub 仓库的 Actions Variables 设置 `CNB_REPOSITORY=<组织>/<仓库>`，Secrets 设置 `CNB_TOKEN`。由账号持有者完成凭据创建及授权；不要在聊天或日志里贴令牌。
4. 首次同步并验证公开下载和更新清单后，将清单地址填入 `assets/updates.json` 的 `sources.cnb.manifestUrl`，随下一次客户端发布生效。已发布客户端也可在 CNB 选项中手动填写这个地址。

## 同步现有最新版本

只读预演会校验本地文件与 GitHub 正式版的版本、大小和摘要，并输出计划中的公开链接，不访问 CNB 写接口：

```sh
npm run release:cnb -- --repo '<组织>/<仓库>' --local-dir output/release-0611-final --dry-run
```

正式执行时通过环境提供 `CNB_TOKEN`；可选 `GITHUB_TOKEN` 仅发送给 GitHub API，用于避免匿名访问限额：

```sh
npm run release:cnb -- --repo '<组织>/<仓库>' --local-dir output/release-0611-final
```

不传 `--local-dir` 时从 GitHub 下载正式发布附件。该目录缺少的文件也会从 GitHub 获取。临时文件使用系统临时目录，结束后自动清理。

## 自动发布与一致性

`.github/workflows/cnb-release.yml` 在正式 Release 发布后同步，也支持手动执行。草稿与预发布不会进入国内稳定更新源；并发发布串行执行，发布清单前再次核对 GitHub 的当前最新版，拒绝降级或用同版本的不同内容覆盖。

重复执行时先核对公开清单、全部附件的服务端 SHA256、大小与数量；内容完全一致则直接完成，避免再次下载和上传整套安装包。

同步顺序：

1. 准备并校验所有 ZIP 和可选 DMG。
2. 在同一个 `stable` Release 中上传带真实版本号的附件，并通过匿名公开下载核对大小和 SHA256。
3. 上传并校验固定文件名的手动下载副本，上传校验和。
4. 最后替换固定的更新清单，再核对公开清单、更新 Release 标题与说明。
5. 成功后仅删除本脚本管理且已被取代的安装包附件。保留当前版本、固定下载副本及未知的用户文件；不删除其他 Release。

当前版本附件与固定下载副本同时存在，是为了让更新清单始终指向带真实版本号的文件，避免读到旧清单后下载到新 ZIP。发布清单前失败会保留先前的更新清单和旧包，重跑即可恢复；手动下载的固定副本按文件依次更新。旧客户端若恰好在清理前读取旧清单，可重新检查更新，或由自动模式从 GitHub 下载摘要一致的旧目标版本。

## 更新来源

自动模式只检查内置官方源；用户自定义的 GitHub 仓库、CNB 清单、Gitee 或自定义 HTTPS 地址由手动模式使用。新安装默认自动；已有用户的明确选择不变。应用内下载完成后记录实际来源，下次自动模式在同版本间优先使用它。首次从浏览器手动安装的来源不作猜测。

自动模式的反馈仓库仍是官方 GitHub 仓库，国内安装包托管不会改变反馈接收方。手动指定其他源时沿用原有反馈目标规则。

接口依据：[CNB OpenAPI](https://api.cnb.cool/)、[Release 内置任务](https://docs.cnb.cool/zh/build/internal-steps/git/release.html)、[官方附件插件](https://cnb.cool/cnb/plugins/cnbcool/attachments)、[公开下载权限](https://docs.cnb.cool/zh/guide/role-permissions.html)。
