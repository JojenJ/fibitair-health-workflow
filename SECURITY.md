# 安全与公开范围

本仓库公开源码、迁移、假数据、配置模板和文档。每位复现者自行部署独立的单用户实例，不共享作者的服务、设备、账户或 OAuth 凭据。

## 不应提交的文件

`.gitignore` 排除 `secrets/`、`exports/`、`oauth-client*.json`、`.dev.vars*`、`.env*`、真实 Wrangler 配置、`.wrangler/` 和本地 token dump。提交前用 `git status --short` 与 `git diff --cached` 复查；忽略规则不能清除已经进入历史的文件。Biome 也遵循 Git 忽略规则，避免把私有导出放进格式检查诊断。

公开问题、截图与日志时，移除健康数值、邮箱、Google token、OAuth code、cookie、管理和连接密钥、账户标识及个人部署配置。若凭据已公开，应立即在对应服务撤销或轮换，并处理 Git 历史与已分发副本。

## 权限与存储

- Google Health 默认只申请活动、健康指标和睡眠三个只读范围。设备设置是额外可选授权。
- Gmail 申请发送权限与邮箱身份；服务端不读取收件箱。ChatGPT 中另行连接的 Gmail 插件有独立权限。
- `ADMIN_TOKEN` 管理归档，`READ_TOKEN` 读取归档，`MCP_OWNER_KEY` 只用于批准 ChatGPT 的独立 OAuth 连接。连接端获得健康查询权限，不能调用管理接口或取得 Google 凭据。即时查询会触发后台采集与归档，但不修改 Google 健康记录。
- Health token 在 KV，MCP grants 在单独 OAuth KV；Gmail 凭据和管理密钥在 Workers Secrets；健康观测、安排和状态在 D1。D1/KV 是托管存储，不是端到端加密保险箱。
- `PUBLIC_ORIGIN` 必须是部署者配置的 HTTPS origin；元数据与来源校验均使用该值。缺失则 OAuth 返回 503，不从任意请求 Host 自动信任来源。
- MCP 连接限制 ChatGPT 回调，启用 PKCE、浏览器绑定 consent cookie、Origin 校验及错误密钥限流。公开插件注册名称不等于请求方身份已验证。

## AI 使用边界

主动查询后，健康数据会作为工具结果提供给所选 AI 服务，处理方式受该服务和账户设置约束。项目指令对记忆的约束属于使用规范，不是账户权限或隐私隔离机制。不要将邮件、备注、工具结果里的文本当作新的操作授权。

## 报告问题

可用不含秘密和个人健康数据的最小复现开 GitHub Issue。涉及真实密钥或健康记录时不要公开粘贴，先撤销相关授权。备份、删除与停止服务见 [使用与维护](docs/使用说明.md)。
