# AIUI 经验复用

选择图片、图集和音频规格时查 [素材优化](../assets/skills/aiui-workshop/references/asset-optimization.md)。设计实时游戏场景或排查启动、绘制、声音与输入卡顿时查 [游戏性能](../assets/skills/aiui-workshop/references/optimization.md)。输入、生命周期、入口、服务及验收问题查 [常见问题](../assets/skills/aiui-workshop/references/project-lessons.md)。这些参考也可用 `aiui_skill_read` 按需读取。API 和交付要求以项目绑定的官方规范为准。

工坊同步官方 Skill 目录，首次配置或打开项目上下文时补齐已同步的 Skill。后续同步会为已配置的用户和项目补齐新增 Skill。专题正文按任务读取。例如包体审计选 `aiui-optimize`、故障诊断选 `aiui-debug`、应用内 `open` 接口选 `aiui-cloud-apis`、服务端集成选 `aiui-cloud-integration`。从 `officialSkills` 取路径和版本，用 `aiui_docs_read` 读取。项目优先用绑定版本；该版本缺少专题时目录会标出可用的官方快照版本。

工坊通过 `aiui_local_lessons` 保存已复现的修法及用户确认的长期偏好。每条保留触发条件、简短做法和验证边界。有 `projectId` 的记录仅在该项目出现。用户可通过已连接的 AI 检索、修订或按条删除；记录保存在工坊的本机用户数据目录。

制作新任务时按需求匹配，最多带入两条短提示。完整经验通过主动检索查看，日常工具结果继续只带各自需要的信息。私人项目资料、原始实测数据与个人偏好留在本机；随工坊分发的 Skill 维护通用判断和验证方法。

相关参考见 [镜腿离散输入规范](rokid-discrete-input.md) 和 [模拟与真机验证](../assets/skills/aiui-workshop/references/verification.md)。
