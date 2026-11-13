# 工坊问题与功能建议

左下角「反馈与建议」接受工坊自身的问题和用户主动提出的建议。填写内容后生成预览，核对公开内容和目标仓库后直接点击提交，无需验证码。统一机器人创建 GitHub issue，返回可打开的编号和链接，普通用户不需要 GitHub 账号。

此反馈功能不调用 AI 模型，也不需要模型 API Key。这里的「机器人」是执行固定提交流程的 GitHub App。用户可以直接填写表单，工坊本机用固定代码规则处理内容；Cloudflare 服务负责内容校验、限频和调用 GitHub 创建 issue。

目标取自设置中**当前选中且已保存的更新源仓库**，不会根据项目的 Git remote 选择目标。当前支持 GitHub；切换到其他来源时停用 issue 提交，不回退到原 GitHub 仓库。更换仓库后，既有未提交预览失效，必须重新生成。机器人也必须已获该仓库授权，服务端不会向任意仓库转发。

## 反馈范围

- 工坊界面、MCP、模拟器宿主、内置工具或更新功能自身的可复现问题。
- 用户主动提出的工坊功能或体验建议。
- 应用源码错误、预期的权限拒绝、未连接眼镜及暂时断网先在原项目处理，不自动发 issue。

如果用户已经在 Codex、WorkBuddy 等外部 AI 工具中连接了工坊 MCP，该外部助手可调用 `aiui_feedback_prepare`，传入标题、描述和选定的诊断 ID；工坊执行与表单相同的本地规则并保存预览。调用由外部助手发起，工坊不会启动或调用该 AI。这是可选入口，手动反馈无需连接 AI。`aiui_feedback_status` 读取草稿和回执。MCP / CLI 没有 issue 发布工具；也没有后台自动把全部诊断上传的开关。

## 公开内容和提交保护

预览包含用户填写的内容、基础版本信息，以及主动选择的最多五条工坊公共环境诊断摘要。不会附加项目源码、照片、完整日志或其他项目的诊断。「脱敏」指本机用字符串匹配和替换规则，把能识别的本地路径、凭据、邮箱、设备标识等换成占位文字，并处理外部提及；不经过 AI 审阅，仍应在提交前核对预览。

标题至少 5 个字符，详细描述至少 20 个字符；点击生成预览时，长度不足会在对应输入框下方提示并定位，不会无提示地禁用按钮。

客户端每分钟最多一次、滚动 24 小时最多三次。无需 GitHub 账号、验证码或第三方验证页面。Cloudflare 服务执行仓库白名单、内容校验、来源频率限制及全局每日十次上限；相同内容使用指纹关联已有 issue。在调用 GitHub 前先持久化占用限额，上游失败也计入，避免反复请求消耗 GitHub 接口。IP 只以加密散列参与限频，不保存原值。报告不会触发批量外部提及或嵌入远程图片。

提交前持久化请求身份和状态。请求结果丢失或进程中断时显示「结果待核对」，仅查询原回执和 issue 标记，不自动重放写请求。草稿与 issue 记录在本机保存，阅读诊断或提交反馈不表示原问题已修复。

未提交的草稿及明确提交失败的反馈，可从预览下方或「反馈记录」右侧点击「删除草稿」，确认后从列表移除，并可立即「撤销删除」。删除仅影响本机草稿，不删除 GitHub issue；已提交回执、正在提交及结果待核对的记录保留。删除不会清除限频记录，切换更新源或离线时也可清理旧草稿。

## 维护者部署

服务位于 `services/feedback/`，使用 Cloudflare Worker 和 SQLite Durable Object。`assets/feedback.json` 只包含公开服务 URL；GitHub 凭证和限频散列密钥只放在 Worker Secret。

1. 用 Wrangler 登录 Cloudflare，需要账号读取和 Workers Scripts Write。无需为本功能启用付费计划。
2. 运行 `node scripts/setup-feedback-github.mjs`，打开返回的本机核对页，创建私有 GitHub App。权限仅为 Issues 写入及必需的 Metadata 读取；仅安装到目标更新仓库。私钥通过本机回调直接写入权限为 0600 的临时文件，不显示到聊天或进入 Git。
3. 安装范围核验通过后运行 `node scripts/deploy-feedback.mjs`。脚本部署 Worker、直接写入 Worker Secret，核对健康、仓库与无效请求拒绝行为后，才更新客户端服务 URL。
4. 首次部署完成后移除临时明文密钥文件。后续运维通过 Cloudflare Secret 管理；需要更换机器人或仓库时重新核验权限，不扩大旧机器人的默认授权。

部署脚本优先使用 GitHub App 短期安装令牌；Worker 每次只按仓库白名单调用 GitHub。服务也支持单独的 `GITHUB_TOKEN` Secret 供维护者已有专用机器人使用，不能把个人宽权限 token 放入客户端。

运行环境经验：Cloudflare Worker 不支持 Node Fetch 可用的 `redirect: 'error'`。带凭据的请求使用 `manual` 并拒绝非成功响应，避免跟随重定向转发凭据。部署不能只看健康检查；还须在真实 Worker 内签发受限 GitHub App 令牌并只读核对目标仓库，Node 模拟测试无法证明边缘运行时兼容性。参见 [Workers Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。

验证命令：`npm test`、`npm run qa:feedback`。界面验收使用隔离服务、模拟机器人，不向公开仓库创建测试 issue；报告在 `output/qa/feedback/`。真实部署和真实反馈分别记录。

接口依据：[GitHub Issues API](https://docs.github.com/en/rest/issues/issues#create-an-issue)、[GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)、[Durable Object 存储](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)。
