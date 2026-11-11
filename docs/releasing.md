# 签名、公证与发布

源码和桌面包分别发布：Git 只保存可复现源码、公开示例、文档和来源清单；大体积二进制放 GitHub Releases。npm 发布是另一项操作，当前没有执行。

## 发布前检查

```sh
npm ci
npm run prepare:tools
npm test
npm run qa:screenshots
npm run check:public
```

确认 `package.json` 与 lockfile 版本一致，提交源码，记录 commit。更新 `CHANGELOG.md`。文档截图仅使用 `examples/`，不使用个人业务项目或日常账号会话。

## macOS：Developer ID 与公证

正式 macOS 包在 macOS 上制作。签名证书放系统钥匙串；凭据通过环境变量或本地 `.env.packaging` 传入，参考根目录 `.env.packaging.example`。不要把真实证书、密钥或密码加入 Git。

```sh
export MACOS_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'
npm run package:mac:release
```

签名脚本使用 `@electron/osx-sign` 逐层签署应用、Electron helper、ADB 与 scrcpy，开启 hardened runtime。Electron 保留 JIT 和主动相机访问所需 entitlement。随后执行严格签名验证；Windows 不使用这一步。

推荐先用 Apple 的 `notarytool store-credentials` 将账号授权存为本机钥匙串 profile，再运行：

```sh
export APPLE_NOTARY_KEYCHAIN_PROFILE='aiui-workbench'
npm run notarize:mac
```

也支持既有 Apple API key：在本机环境设置 `APPLE_API_KEY`（`.p8` 文件路径）、`APPLE_API_KEY_ID` 和适用的 `APPLE_API_ISSUER`。脚本不会输出密钥内容。复用其他项目的私有凭据前，应由凭据持有者明确授权。

`notarize:mac` 验证实际 bundle 的版本、架构和签名，提交 Apple 并保存可续接回执。只有 Apple 返回 `Accepted` 后才装订票据、复验签名、执行 Gatekeeper 检查并重建最终 ZIP。报告为 `output/release/macos-verification-arm64.json`。Apple 仍在处理时重新执行可继续查询。

自定义现成 app：

```sh
node scripts/notarize-mac.mjs --app '/path/AIUI Workshop.app' --out output/release
```

## Windows：未签名便携包

```sh
npm run build
node scripts/package.mjs --platform win32 --arch x64 --out output/release
```

产物是完整 ZIP，无需另装 Node、ADB 或 npm。当前不配置 Windows 代码签名，发行说明必须写明未签名。macOS 上的结构检查不能代替 Windows 原生启动验证；CI 的 Windows job 会执行打包和原生验收，PATH 只保留 Windows 系统目录，不含 Node、npm、Android SDK 或 ADB。

## 本机独立包验收

```sh
AIUI_QA_EXECUTABLE='/path/AIUI Workshop.app/Contents/MacOS/AIUI Workshop' npm run qa:portable
```

macOS 公证后的 app 应同时通过：

```sh
codesign --verify --deep --strict '/path/AIUI Workshop.app'
xcrun stapler validate '/path/AIUI Workshop.app'
spctl --assess --type execute --verbose=4 '/path/AIUI Workshop.app'
```

## 合并清单并发布

**公证装订会改变 macOS 包的内容，必须在最终 ZIP 生成后重新计算清单和 SHA256。**

```sh
npm run release:manifest --   --file darwin:arm64:output/release/AIUI-Workbench-0.3.1-darwin-arm64.zip   --file win32:x64:output/release/AIUI-Workbench-0.3.1-win32-x64.zip   --base-url https://github.com/syjstc/aiui-workbench/releases/download/v0.3.1/   --release-url https://github.com/syjstc/aiui-workbench/releases/tag/v0.3.1   --notes-file CHANGELOG.md   --out output/release/workbench-update.json
```

创建指向已验证 commit 的 `v0.3.1` tag 和 GitHub Release，上传两个 ZIP、`workbench-update.json`、`SHA256SUMS.txt` 和公开验证结果。校验附件字节数、摘要和 tag/清单版本一致后再完成发布。公开报告不包含本机路径、设备序列号、账号或凭据。

公证完成后运行 `node scripts/create-dmg.mjs --app '/path/AIUI Workshop.app' --out output/release` 生成 DMG。DMG 内包含应用和“应用程序”快捷方式；同一版本的 ZIP 仍用于应用内升级。更新清单每个平台只列一个安装包，DMG 作为额外的手动安装附件提供，不与 ZIP 重复登记同一个平台。

桌面内置 GitHub 更新源为 `syjstc/aiui-workbench`，用户可修改并恢复默认。0.4.0 起左下角提供持续提醒；macOS 由用户点击发起下载、校验、替换和重启，失败时恢复原应用。Windows 下载后手动安装。用户的自动检查偏好保持不变。

参考：[Electron 代码签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[Apple 公证流程](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)、[electron/osx-sign](https://github.com/electron/osx-sign)。
