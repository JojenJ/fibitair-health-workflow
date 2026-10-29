function document(title: string, content: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · Personal Health Archive</title><style>body{font:17px/1.75 system-ui,sans-serif;max-width:780px;margin:48px auto;padding:0 24px;color:#172b36;background:#f7faf9}a{color:#126b63}h1,h2{line-height:1.3}h2{margin-top:32px}nav{display:flex;gap:24px;border-bottom:1px solid #cbdad6;padding-bottom:16px}main{background:white;border:1px solid #dfebe7;border-radius:16px;padding:28px;margin-top:24px}footer{font-size:14px;color:#526862;margin:24px 0}</style></head><body><nav><a href="/">Personal Health Archive</a><a href="/privacy">隐私权政策</a></nav><main>${content}</main><footer>个人自用应用 · Personal, single-user application · 更新日期 2026-10-29</footer></body></html>`;
}
export const homePage = document(
  '应用首页',
  `
<h1>Personal Health Archive</h1>
<p>个人健康数据归档与复盘工具。经账户所有者明确授权后，从 Google Health 获取健康观测，保存历史，并准备每周数据包，辅助结合科研、课程与运动安排进行个人复盘。</p>
<h2>功能</h2><ul><li>定时采集活动、睡眠与健康指标，在 Cloudflare D1 中归档。</li><li>汇总有效样本、缺失情况及个人历史基线。</li><li>可选：通过 Gmail API 向授权邮箱本人发送每周数据包。</li><li>支持手动导出与带鉴权的只读 MCP 查询。</li></ul>
<h2>使用范围</h2><p>本应用仅供部署者本人使用，不提供公众注册。此公开页面不显示健康记录。私有接口需要访问令牌，Google 授权通过部署者本地设置工具发起。</p>
<h2>Google 数据权限</h2><p>Google Health：只读活动与健身、健康指标和睡眠。Gmail：发送邮件；另使用 OpenID 邮箱身份信息确认收件人为授权用户本人。本应用不申请读取收件箱权限。</p>
<p>数据用途、存储、保留与删除方法见<a href="/privacy">隐私权政策</a>。本工具不提供医疗诊断，不生成官方恢复评分。</p>`,
);
export const privacyPage = document(
  '隐私权政策',
  `
<h1>隐私权政策</h1><p>本政策适用于 Personal Health Archive 的个人部署实例。部署者也是唯一预期使用者与数据管理者。本应用不提供公众账户服务。</p>
<h2>1. 访问和保存的信息</h2><p>授权后，本应用读取 Google Health 中的步数、总消耗热量、睡眠记录及分期、静息心率、心率变异性、呼吸率与血氧数据，实际可用性取决于设备和账户。保存标准化记录、采集时间和成功或失败状态。用户可自行输入科研、课程、运动、恢复安排及备注。</p><p>启用 Gmail 功能时，读取授权账户的邮箱地址及验证状态，用于确认本人收件地址；仅申请 Gmail 发送权限，不读取收件箱。保存 OAuth 客户端凭据及刷新/访问令牌用于后台访问。</p>
<h2>2. 用途</h2><p>数据仅用于本人健康数据归档、完整性检查、历史统计、周度数据包及本人请求的查询。后台不自动调用 GPT，不进行广告投放、出售数据或使用这些数据训练通用人工智能模型。</p>
<h2>3. 数据处理方和共享</h2><p>Google 提供健康数据、身份授权和 Gmail 邮件服务。Cloudflare Workers 处理采集与查询；D1 保存健康记录与用户安排；KV 保存 Health 令牌；Workers Secrets 保存客户端密钥、Gmail 刷新令牌、邮箱地址和接口令牌。启用周邮件后，数据包会作为邮件内容发送至授权邮箱，并由 Gmail 保存。</p><p>只有用户主动上传导出文件、授权 Gmail 连接或配置 MCP 客户端时，相关内容才可能被其选择的 AI 服务接收；该服务的数据处理受其设置和政策约束。本应用当前不会主动把健康数据发送到 OpenAI。</p>
<h2>4. 保存时间与安全</h2><p>健康历史和日程保留至用户主动删除；同一天同一指标更新时替换旧的标准化记录。接口使用独立的管理和只读 Bearer 令牌。应用不将健康数据或完整 OAuth 错误响应写入业务日志；基础设施服务商可能保留必要的运行与安全日志。请保护本地客户端配置、访问令牌和导出文件。云服务可能在不同地区处理数据，本应用不承诺特定国家或地区的数据驻留。</p>
<h2>5. 撤回授权、导出与删除</h2><p>用户可在 Google 账号的第三方连接设置中撤销本应用授权，停止未来读取；撤销不自动删除已归档内容。可通过部署者提供的本地管理脚本或鉴权导出接口获取历史。</p><p>彻底删除时，先停用 Worker 的定时任务，再由本人在 Cloudflare 删除对应 D1 数据库、KV 命名空间与 Worker/Secrets，并删除本地备份及导出文件。Gmail 邮件和已主动分享给其他服务的副本须分别删除。云服务的备份及恢复保留期遵循各服务商政策。</p>
<h2>6. Google API 数据使用</h2><p>本应用对从 Google API 接收的信息的使用和传输将遵守 Google API Services User Data Policy，包括 Limited Use 要求。只请求功能所需权限，不将这些信息用于广告、数据出售或通用模型训练。</p>
<h2>7. 联系与变更</h2><p>本应用的运营和支持联系邮箱为 Google OAuth 同意页面列出的“用户支持电子邮件地址”，由该 Google Cloud 项目的所有者管理。本人可直接通过项目控制台管理部署、权限及数据。本政策随实际功能更新；新增数据用途或权限前需重新告知并取得相应授权。</p>`,
);
