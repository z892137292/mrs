# Microsoft Rewards Custom · 中文 Web 管理候选版

继续现有项目，成功基线为 v1.0.3，commit `b903b83773304f97347bbcdd54f68946d9ead212`。稳定镜像 `ghcr.io/z892137292/microsoft-rewards-custom:1.0.3` 不覆盖。本分支 `feature/web-admin-notifications` 开发 1.1.0-rc.2；实际构建、测试及镜像发布结果以本分支 Actions 和最终交付报告为准，不能把本文当作成功记录。

## 新增内容

- 独立 Express 5 Web 容器：中文、自适应控制台、账号脱敏、任务、日志、系统只读设置、通知与审计。
- rewards 容器内可选非 root 控制服务，只允许固定 rewards-ctl 操作；Web 不挂 Docker Socket，不挂账号/会话/日志原始目录。
- 所有任务沿用原 flock、supercronic、超时/失败重试/熔断与风险停止。Web 故障不停止调度器，没有第二套调度器。
- 初始化令牌保护首位管理员；scrypt 密码哈希、SQLite 持久化服务端会话、HttpOnly/SameSite Strict、CSRF/Origin、登录限速及审计。
- Telegram 与 SMTP 独立开关、事件选择、凭证保存与测试队列。SQLite 持久化队列最多 500 个待发项，每项最多尝试 3 次，风险事件优先，通知不执行/重试核心任务。

## 运行与安全边界

后台数据来自真实状态和上游运行摘要，不提供演示数据。当前余额没有已核验来源时显示未知；collectedPoints 只称“上游报告变化”，不能当作独立核验余额或搜索次数换算。普通恢复不能解除风险；人工核查需要重新输入密码和一次性二次确认。系统设置只读，不通过 Web 改核心配置。

三份固定上游补丁未修改。没有新增反检测、验证码绕过、自动解除限制或 coreBundle.js 修改。

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
docker build --platform linux/amd64 --build-arg APP_VERSION=1.1.0-rc.2 -t mrs-custom:web-ci .
docker build --platform linux/amd64 -f admin/Dockerfile -t mrs-web:ci .
SOAK_SECONDS=120 bash tests/container.test.sh mrs-custom:web-ci test-results/core
bash tests/web-container.test.sh mrs-custom:web-ci mrs-web:ci test-results/web
```

CI 必须执行实际 linux/amd64 Docker 构建及真实非 root Chromium 浏览器测试；不使用模拟 Docker 代替。API 测试使用真实本地 HTTP 与 SMTP 协议夹具，不能当作 Telegram 公网或真实邮箱投递验证。没有真实微软账号任务。多日运行、NAS 实机和版本会话回滚必须在未执行时标为未验证。

候选 CI 将在完整关键检查后直接推送同一被测镜像，拒绝覆盖已有版本，未知 registry 错误拒绝发布；不会自动合并 PR，也不会自动部署 NAS。两个 registry 推送不是原子操作；若第二个失败，必须按记录判断成对发布是否完成，不能声称完整成功。

原项目审计文件保留为历史记录；当前状态以本分支实际 Actions、最终报告为准。
