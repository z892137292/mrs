# Microsoft Rewards Custom · 中文 Web 管理候选版

继续现有项目，成功基线为 v1.0.3，commit `b903b83773304f97347bbcdd54f68946d9ead212`。稳定镜像及已发布 rc.4 均不覆盖。本分支 `feature/web-phase1-event-stream` 继续 PR #4，开发 1.1.0-rc.5；实际构建、测试及镜像发布结果以对应 commit 的 Actions 和最终交付报告为准，不能把本文当作成功记录。

## 新增内容

- 独立 Express 5 Web 容器：中文、自适应控制台、账号管理（增删改/禁用/脱敏）、任务、日志、系统只读设置、通知与审计。
- rewards 容器内可选非 root 控制服务，只允许固定 rewards-ctl 操作；Web 不挂 Docker Socket，不挂账号/会话/日志原始目录。
- 所有任务沿用原 flock、supercronic、超时/失败重试/熔断与风险停止。Web 故障不停止调度器，没有第二套调度器。
- 初始化令牌保护首位管理员；scrypt 密码哈希、SQLite 持久化服务端会话、HttpOnly/SameSite Strict、CSRF/Origin、登录限速及审计。
- Telegram 与 SMTP 独立开关、事件选择、凭证保存与测试队列。SQLite 持久化队列最多 500 个待发项，每项最多尝试 3 次，风险事件优先，通知不执行/重试核心任务。

## 运行与安全边界

后台数据来自真实状态和上游运行摘要，不提供演示数据。当前余额没有已核验来源时显示未知；collectedPoints 只称“上游报告变化”，不能当作独立核验余额或搜索次数换算。普通恢复不能解除风险；人工核查需要重新输入密码和一次性二次确认。账号配置支持Web私有持久化并由下一次任务动态加载；系统调度设置仍只读，环境配置需无损重建对应服务。

三份固定上游补丁未修改。没有新增反检测、验证码绕过、自动解除限制或 coreBundle.js 修改。

## 一站式操作增量（rc.5）

新增真实持久化事件、登录交互、运行证据/异常/历史和受限恢复入口。人工登录画面来自 Core 真正使用的 Chromium，并保存到原生会话数据库；不会打开另一个普通浏览器冒充 NAS 会话。核验成功需要同 Cookie 的官方接口实时响应；首次邮箱归属还须人工确认。登录期间保留 STOP，成功后不会自动解除风险暂停。

恢复只继续“尚未开始账号”，要求配置、版本与会话重新核验一致。不具备可信执行证据的 PC/Mobile 内部、单次搜索标记 suspect，不能自动跳过。实时传输保留认证 SSE（非 WebSocket），人工输入使用 CSRF POST；截图仅内存转发，不进历史数据库。

[接口协议 v1.1](docs/MRS_PROTOCOL_v1.1.md) · [源码审计及验收边界](docs/PLATFORM_AUDIT.zh-CN.md)。真实微软登录、验证码/Authenticator、NAS 会话重启以及多日稳定性必须人工实机验收；CI 离线 fixture 不是线上成功证明。

[中文 NAS 安装](docs/NAS_WEB.zh-CN.md) · [通知配置](docs/NOTIFICATIONS.zh-CN.md) · [升级与回滚](docs/UPGRADE_ROLLBACK.zh-CN.md) · [架构与验证](docs/WEB_SECURITY.zh-CN.md)

### 独立部署入口

`compose.web.yaml` 与 `.env.web.example` 是新项目入口。默认端口绑定 127.0.0.1:8088，不直接公网暴露；需 LAN 浏览器访问时显式设置 NAS 管理 IP 和同一 ADMIN_PUBLIC_URL。新数据目录为 web-candidate-data；首次安装不要指向原有数据。rewards 主程序仍可使用原 compose.yaml，CONTROL_API_ENABLED 默认关闭。

**新候选标签只有 Actions 成功实际推送后才可使用。不要替换现有 NAS 容器。** 固定 digest 参见最终报告。GHCR 包可能需要所有者登录，匿名拉取未必开放。

## 本地和真实 CI 验证入口

```bash
cd admin
npm ci --ignore-scripts
npm test
# 返回项目根目录后（需要真实 Docker）
docker build --platform linux/amd64 --build-arg APP_VERSION=1.1.0-rc.4 -t mrs-custom:web-ci .
docker build --platform linux/amd64 -f admin/Dockerfile -t mrs-web:ci .
SOAK_SECONDS=120 bash tests/container.test.sh mrs-custom:web-ci test-results/core
bash tests/web-container.test.sh mrs-custom:web-ci mrs-web:ci test-results/web
```

CI 必须执行实际 linux/amd64 Docker 构建及真实非 root Chromium 浏览器测试；不使用模拟 Docker 代替。API 测试使用真实本地 HTTP 与 SMTP 协议夹具，不能当作 Telegram 公网或真实邮箱投递验证。没有真实微软账号任务。多日运行、NAS 实机和版本会话回滚必须在未执行时标为未验证。

候选 CI 将在完整关键检查后直接推送同一被测镜像，拒绝覆盖已有版本，未知 registry 错误拒绝发布；不会自动合并 PR，也不会自动部署 NAS。两个 registry 推送不是原子操作；若第二个失败，必须按记录判断成对发布是否完成，不能声称完整成功。

原项目审计文件保留为历史记录；当前状态以本分支实际 Actions、最终报告为准。

## rc.4 账号动态配置

[账号管理与无损升级说明](docs/ACCOUNT_MANAGEMENT.zh-CN.md)。账号添加不等于微软登录成功。账号普通修改不用删环境、不用重建容器；保存后显示“待下次任务加载”，加载回执来自固定上游loadAccounts校验。运行中与配置修改共用原flock，修改被拒绝。风控STOP不会因编辑/启用/删除账号被清除。
