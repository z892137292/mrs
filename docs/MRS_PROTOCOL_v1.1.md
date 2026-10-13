# MRS 接口协议 v1.1：真实证据与人工交互

本增量继续协议基线 v1，不改变 Rewards 搜索算法、固定上游 commit、已有任务锁或风控停止。候选版本 1.1.0-rc.5；是否通过构建以 Actions 记录为准。

## 实时传输的明确偏差

Core → Web → 浏览器均采用 SSE，不宣称实现 WebSocket。实时通知单向传输，人工输入使用 CSRF 保护的 POST，因此不需要第二个双向调度通道。Core Bearer 认证，浏览器 HttpOnly/SameSite 会话认证；浏览器流每 5 秒重新检查会话，退出后断开。重连支持 Last-Event-ID；Web SQLite 原子保存事件和游标，重复 ID 不重复持久化。Core/Web 各最多 32 个连接，持久化保留 2000 条；历史丢失发 gap，UI 重新读取真实运行快照，不伪造缺失步骤。超过 500 条历史通过分批、背压等待返回。Core 静默超过 45 秒重连。

截图**不进入持久化事件**，避免保存验证码、邮件、个人页面或凭证。截图只通过已认证且归属匹配的 POST `/api/login-interaction` 返回，Cache-Control: no-store。事件只记录 screenshot.ready、阶段和不含邮箱的 accountId。

## 私有 Core 接口

`GET /events/stream`、`GET /tasks`、`GET /sessions` 均要求 CONTROL_API_TOKEN。

`POST /login`：固定 action=start/state/frame/input/verify/close；accountId 和管理会话私有 owner 双重绑定。不接受 CDP 命令、URL、Shell、JavaScript 或 evaluate。输入仅坐标点击、文字、有限按键及滚动。

`POST /tasks/recovery`：id、execute、confirmation。只有“未开始账号”粒度通过验证才允许执行；输入不能指定任意账号过滤器。普通页面操作不能解除 STOP。风险恢复沿用密码、一次性 nonce、二次确认和审计记录。

## 真实登录语义

人工登录 worker 使用 Core 实际编译的 Browser 工厂、代理及 SessionStore，并持有同一个 state/run.lock；CDP 使用进程内 Playwright 管道，不暴露调试端口。默认保存 Mobile 会话，正是 Core 账号任务首先使用的会话类型。

人工等待只发生在独立的登录模式，不运行积分任务、不自动填写验证码、不调用上游自动登录流程。既有任务中的 process.exit(78) 不变。登录开始即持久化 STOP；成功核验也不自动恢复任务。

核验必须使用同一浏览器 Cookie 发起官方 getuserinfo 实时请求，拒绝重定向、非 200、没有 Rewards userStatus/ePuid/有限余额、风险标记及与既有绑定不同的 ePuid。官方接口未返回邮箱：首次归属必须由管理员核对实际页面并明确确认，系统只保存 keyed HMAC，不能宣称自动证明邮箱归属。仅历史登录日志、保存时间或账号存在均不代表当前会话有效。

等待空闲 10 分钟或总计 30 分钟结束；管理会话退出、Core 停止及异常断链均清理自己的浏览器进程组。截图/输入不入日志，核验后禁止再次返回页面截图。

## 可信恢复边界

run ID、账号开始/结果、PC/Mobile 阶段开始和服务端 quota 观测写入现有 Core events.sqlite 的增量表。remaining=0 只能证明服务端额度状态，不证明某个搜索请求领取了积分；UI 标注数据来源，绝不以搜索次数代替积分。

BrowserSearch 的远程搜索与随后 PointsTracker.measure 不是原子事务，且异常可被上游转换为部分统计。因此**不实现单次搜索自动断点续跑，也不按 completed_at 跳过 PC/Mobile 阶段**。返回而没有额度完成证据、浏览器丢失、未清理运行中阶段均标记 suspect，等待人工核查。

恢复仅继续没有 account.started 证据的账号，并要求配置/账号/版本签名一致、无 STOP、无 suspect、每个待运行账号 5 分钟内重新核验且 native 会话内容 HMAC 一致。旧记录通过 SQLite 条件更新一次性预留，执行仍进入原 rewards-ctl/flock；重复请求拒绝。恢复不是自动重试，也不会执行已经开始的账号。

## 验证范围

本地单元测试与离线 HTTP fixture 不等于微软线上验收。真实 Docker 非 root Chromium/CDP、原生会话保存恢复、容器生命周期和构建由 CI 实际运行。微软登录、Authenticator/验证码实际交互、NAS 环境及多日稳定性一律需实机人工验收。硬件安全密钥/WebAuthn 能力受原 Browser 工厂现有参数约束，未验证；不为此新增反检测或解除风控参数。

官方 CDP 参考：https://chromedevtools.github.io/devtools-protocol/tot/Input/ 和 https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot 。
