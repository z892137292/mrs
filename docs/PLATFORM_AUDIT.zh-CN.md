# rc.5 平台源码审计及验收边界

基于 PR #4 commit 7f29f70e77cea4bcc5a6b556d99d57b66bc118fa，继续原两个镜像和原后台。原 PR 的 Actions 38350530914、38350530954 已成功；其中旧 Core workflow 包含 3600 秒离线 Chromium soak。不把旧 commit 的成功套用于新 commit。

## 定点修改与发现

|问题/缺口|位置|处理|
|---|---|---|
|超过 500 条浏览器历史缺失；背压直接关闭使重放失败|admin/src/live-events.mjs|分批重放及等待 drain，本地 799 条真实 HTTP 重放回归|
|游标与事件分开落盘可能跳过记录|同上|SQLite 原子事务；Core reset/gap 重建及重新读快照|
|SSE 缺少连接上限、会话持续验证和静默重连|同上|32 连接、5 秒认证核查、45 秒 Core 看门狗及释放计时器|
|没有同一 Core 浏览器人工交互|interactive.mjs/login-worker.mjs/server.mjs|固定 CDP 输入、owner 隔离、原 Browser/SessionStore、同 flock、STOP 常驻；真实 Chromium CI 门禁|
|保存日志不是实时会话有效证据|login-worker.mjs|官方同 Cookie getuserinfo 实时核验；历史记录明确需重新核验|
|上游不提供邮箱归属证据|固定上游 UserStatus/getuserinfo|首次明确人工核对；后续 opaque 身份 HMAC 拒绝错绑，不能宣称机器验证邮箱|
|单次搜索没有原子、幂等执行凭证|上游 BrowserSearchOnBing/SearchProgress/PointsTracker|拒绝搜索级自动续跑，部分/不明步骤标记 suspect|
|阶段返回被误当完成的风险|ledger.cjs/new patch 0004|quota=0 才记额度完成；返回保留真实额度，未确认记 suspect|
|没有可信恢复记录|ledger.cjs/agent.mjs|run/阶段持久化，配置及会话内容签名、一次预留、仅未开始账号恢复|

原 patches 0001、0002、0003、固定上游 commit、Chromium 启动参数和核心搜索算法不变；0004 仅在真实执行点写证据。原有账号 CRUD、配置 revision、通知、备份、风险恢复与管理员会话保留。

## 数据兼容及回滚

Core events.sqlite 增加 runs/run_evidence 两表，不删旧表、不改旧列；Web live_events 为已有表，原子写游标使用原 kv。verified-sessions.json 在已有独立 control-data，mode 0600，保存 HMAC 与观测摘要，不公开原 Cookie。原会话仍使用 sessions/sessions.db。升级不迁移、不覆盖账号数据库。

先通过后台暂停、等待任务与登录浏览器退出，再离线备份完整 Rewards 持久化目录及 Web /data（SQLite WAL/SHM 一并保留或停止服务后复制）；私密备份应加密、0600、不得上传 GitHub。只更换两个镜像引用，compose up -d，不执行 down -v。回滚使用旧配对 digest；增量表可保留但旧版不理解新记录，因此维持 STOP 并人工核查，必要时恢复到**新的空目录**而不是覆盖生产数据。原 backups 默认排除凭证，不可误作含会话完整私密备份。

## 发布门禁

当前 feature 分支新版本 rc.5，旧 rc.4/1.0.3 标签不触碰。Web workflow 执行原 wrapper/重复触发/备份、固定补丁 typecheck+ESLint+Prettier+单元、两个 amd64 实际 build、3600 秒 Core Chromium soak、双容器接口/浏览器 UI/登录交互/账号 loader/重启/备份恢复。旧 CI 原测试也保留。发布仅在全部此 workflow 门禁通过后，两个目标标签均不存在才推送**已测试的同一 image ID**。不部署 NAS。

## 尚不能宣称完成的实机验收

场景 A/B：真实微软人工登录、验证码、Authenticator、账号限制与首次邮箱人工绑定；场景 C/D：微软真实业务阶段、积分以及中断；场景 E：实际 NAS 重启和资源曲线。CI 的离线 fixture 仅验证真实 Chromium 的输入、截图、Cookie 和原生会话 DB 流程，不能冒充微软线上验证。PC/Mobile 内部及单次搜索安全自动恢复不具备原子证据，明确不实现；硬件密钥/WebAuthn 未验证。

最终 commit、CI 链接、digest 和实测计数应见对应 CI artifacts/交付报告，不在构建前标记成功。
