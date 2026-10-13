# rc.4 账号配置与无损升级

继续现有 feature/web-admin-notifications；不修改稳定1.0.3、旧候选标签或正在运行的NAS。

## Web账号操作

登录管理员后进入账号管理。新增填写邮箱、密码（允许原有会话/无密码模式）、必要的TOTP/恢复邮箱、地区、语言及代理。现有上游不提供通用Cookie导入接口，本版不接受原始Cookie/Session上传；沿用原私有sessions目录，不能把管理员登录当微软登录。

查询接口只返回脱敏账号标识及凭证已配置标志。编辑邮箱留空保留；密码/TOTP/恢复邮箱/代理凭证留空保留，清除TOTP或代理凭证需要勾选明确选项。禁用不执行该账号；删除仅从配置移除，不删除其浏览器会话和历史。代理凭证必须成对，SOCKS认证沿用上游不支持的限制。每次修改带配置revision，旧页面并发编辑被拒绝。

账号首次修改会原子接管当前容器的全部ACCOUNT_N配置，保留未编辑账号。私有accounts.json保存在rewards的control-data卷，目录0700/文件0600；Web没有该卷挂载和Docker Socket。实际生产验证用固定上游Validator，坏配置在写入前拒绝。原子临时文件+fsync+rename，失败保留旧配置；断网发生在已保存但回复之前时，不能声称回滚或重复点击，先刷新revision确认。

进入持久化配置模式后，以Web配置为准，不再让旧环境变量重新引入禁用/删除账号。保留.env作为原始兼容配置及灾难恢复凭据，不能通过删除accounts.json“恢复”，否则可能重新启用旧环境账号。应用根目录存在额外.env时，为避免优先级混乱，新模式拒绝启动任务，需人工迁出冲突文件并私下备份。Compose正常只注入env_file，没有挂载应用根.env。

## 生效与登录状态

- 已添加/保存，待下次任务加载：原子持久化成功，无需删除或重建容器。
- 本次任务已加载：新任务在原flock锁内，适配器把配置投影到现有ACCOUNT_N环境，实际执行固定上游loadAccounts/Validator，记录私有revision回执，然后启动原dist/index.js。重试仍使用同一锁，运行期间修改拒绝。
- 登录未验证：没有明确证据；账号存在、管理员登录、配置加载及任务摘要ok都不会单独标记微软登录成功。
- 最近登录成功/失败、人工验证、账号受限：只识别原上游实际LOGIN日志，成功消息需要明确Successfully logged in。同邮箱前缀的多个账号无法无歧义关联时显示未验证；日志过滤/格式变化也显示未知。成功是最近程序识别结果，不是当前会话仍有效的证明；任务失败可能是登录后业务失败。
- 风控、登录验证或限制：继续沿用全局保守STOP，编辑、启用或删除账号都不清除STOP。恢复仍需人工核查、管理员密码与二次确认；无验证码或限制绕过。

普通配置保存不能探测真实微软账号，不自动运行积分任务。状态验证需要用户自己在安全条件下观察实际结果；本次开发只测试离线夹具及真实容器/浏览器启动。

## 无损升级现有候选环境

不新建替代项目，不删除原环境。以下只操作用户明确选择的候选Compose项目，生产NAS本次不自动执行。

1. 记录现有容器的镜像digest、Compose项目名、所有bind路径和control-data/web-data真实卷名。保存现有Compose及.env，权限0600，不发GitHub/聊天。
2. 在Web暂停并安全停止任务，确认没有rewards-run或Chromium业务进程；`docker compose -f compose.web.yaml stop rewards web`。停止后，私下完整备份config/sessions/state/logs/diagnostics数据根，以及control-data（含accounts.json/events.sqlite/WAL/SHM）和web-data（含管理员/通知/会话/WAL/SHM）；另存.env、Compose和匹配镜像digest。tar归档权限0600，SHA256校验；恢复先在新目录/新卷验证。
3. **保留同一项目名、原bind路径、原命名卷**。只把REWARDS_IMAGE和WEB_IMAGE替换为新候选已经发布的不可变digest；`docker compose -f compose.web.yaml config --quiet`，再`pull`。
4. `docker compose -f compose.web.yaml up -d --no-deps rewards web`。这只替换相应服务，原卷继续挂载；绝不执行down -v或删除卷。若原部署只有1.0.3，先按NAS教程建立独立候选测试，不能直接接入在线生产sessions。
5. 检查服务健康、版本/commit、管理员登录、账号配置来源及revision、私有目录权限、原sessions仍在。先不触发真实任务；新增/编辑离线测试账号观察保存状态，在隔离测试确认动态加载。普通账号后续编辑不需要上述容器替换。

CRON_SCHEDULE/TZ/PUID/PGID/CONFIG_*、端口、Web Origin/Cookie及服务级网络代理仍是启动配置。修改.env后用`up -d --no-deps`安全重建受影响服务（Web专有配置只重建web），保持卷与项目；不是`restart`读取新.env，也不用删数据。

## 回滚

保存失败/参数无效/锁冲突不会提交新revision；刷新查看现有配置。若已成功保存错误但有效的值，重新编辑提交新revision；不得删除整个环境或会话。

版本回滚先停止候选两服务，使用旧Compose与旧digest，并将**匹配旧版本的停机备份**恢复到新目录/新卷后验证。不能让rc.3或1.0.3接着读rc.4账号文件：旧版不识别managed账号，可能恢复旧.env中的账号。保留安全STOP或人工暂停，再确认账号与计划后启动。没有实际执行NAS或跨版本会话回滚，不能宣称已验收。

本轮测试范围及Actions链接以最终交付报告为准。外部Telegram/SMTP、真实微软登录/积分及NAS权限/代理仍需现场验收；开发不会代替人工验证。
