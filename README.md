# Microsoft Rewards Custom 1.0.3-rc1

**候选版，尚未完成真实 Docker/Chromium/GitHub Actions 验证，禁止称为正式稳定版。** 当前状态见 RELEASE_STATUS.zh-CN.md。

基于 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)（v4 分支）的自维护 Docker 镜像。
上游代码不做 fork 修改：构建时按 `upstream.env` 中固定的 commit 拉取源码、校验 SHA，再应用 `patches/` 中的最小补丁。积分业务逻辑沿用上游；本版额外强制风险暂停、无界面单进程执行，并锁定安全依赖版本。

## 与上游 `:4` 镜像的区别

| 方面 | 上游 | 本镜像 |
|---|---|---|
| 失败感知 | 程序总是 `exit 0` | 补丁：0 成功 / 2 部分账号失败 / 1 致命错误，并写入运行摘要 |
| 重试 | 无 | 仅可信摘要 + 退出码 2 时重试失败账号；未知失败/超时不自动重试 |
| 任务互斥 | PID 文件锁（有竞态） | `flock`，进程死亡即释放；被 `kill -9` 后的孤儿进程组会在下次运行前清理 |
| 卡死处理 | 只杀脚本 PID | 超时后按进程组 TERM→KILL，Chromium 一并清理 |
| 异常停止 | 无 | 连续失败 `MAX_CONSECUTIVE_FAILED_RUNS` 次后熔断暂停；本次尝试结束并报告风控警告时**强制暂停后续运行** |
| `docker stop` | 正在运行的任务被硬杀 | 先优雅停止 bot 和浏览器再退出 |
| 日志 | 仅 docker stdout | 另存 `./logs/run-*.log`，按天清理，邮箱和常见敏感字段脱敏（尽力而为） |
| 持久化 | config、sessions | 另加 state、logs、diagnostics |
| 运行用户 | root | 降权到 `PUID:PGID`，调度器为 supercronic |

## 快速开始

```bash
cp .env.example .env && chmod 600 .env   # 填写 IMAGE、TZ、账号
mkdir -p config sessions state logs diagnostics
docker compose up -d
docker compose logs -f
```

测试部署只使用独立目录与数据副本，禁止挂载正在运行的旧容器目录。容器内路径与上游一致，但不代表已验证迁移兼容性。

## 日常操作

```bash
docker compose exec rewards rewards-ctl status     # 上次结果、是否暂停、是否运行中
docker compose exec rewards rewards-ctl run        # 立即运行（有任务在跑则返回 75）
docker compose exec rewards rewards-ctl stop       # 停止当前任务（含 Chromium）
docker compose exec rewards rewards-ctl pause 维护  # 暂停定时任务
docker compose exec rewards rewards-ctl resume --reviewed # 解除暂停/熔断并清零失败计数
docker compose exec rewards rewards-ctl logs -f    # 查看最新一次运行日志
docker compose exec rewards rewards-ctl selftest   # 镜像自检（不连接微软）
```

状态文件位于 `./state`：`status.json` 记录上次运行结果，`last-summary.json` 是 bot 输出的运行摘要，`STOP` 文件存在即表示已暂停（内容为暂停原因），`consecutive-failures` 是连续失败计数。

## 目录结构

```
upstream.env        固定的上游仓库与 commit
patches/            对上游的最小 TypeScript 补丁
docker/             运行时层（entrypoint、supervisor、rewards-run、rewards-ctl、自检、健康检查）
tests/              运行器行为测试、补丁检查、单元测试
Dockerfile          多阶段构建
compose.yaml / .env.example
.github/workflows/ci.yml
```

## 安全备份与恢复（先停止新容器）

```bash
docker compose stop rewards
bash scripts/backup-data.sh            # 备份到 ./backups，包含 config/sessions/state
tar -tzf backups/mrs-data-*.tar.gz | head
bash scripts/restore-data.sh backups/<实际文件名>.tar.gz ./restore-check
```

恢复脚本**只解压到全新的目录**，不会覆盖原有运行目录，也不会自动启动容器。备份以 `0600` 权限生成，并配有 SHA-256 完整性校验；但 **SHA-256 不是加密**。备份包含登录会话和敏感个人数据，请不要上传公开 GitHub、第三方中转站或工单。`.env` 不纳入备份，需另外通过安全方式保存或重新填写。切勿备份运行中的容器，以免得到不一致的会话文件。

## 安全与已知限制

- 容器任务收到明确的 `Fraud_UserWarning_BotScore_UX` 或 HTTP 403/429 时先写风险标记与 STOP，监视器停止进程组；即使摘要尚未生成也不重试。`STOP_ON_BOT_WARNING=false` 无法关闭保护，`contintueOnBotWarning` 在容器任务中强制关闭。未知验证码/限制页面仍可能无法被识别，不能承诺全覆盖。解除暂停必须先人工检查。
- `LOG_REDACT_EMAILS=true` 默认为开启；日志管道还会遮盖常见密码/Token/Cookie 字段，但**不能保证任意第三方输出都不泄露敏感信息**。分享日志前必须人工检查；`config`、`sessions`、`state`、`diagnostics` 目录绝对不要直接公开。
- `CONFIG_ERROR_DIAGNOSTICS=false` 示例配置默认关闭浏览器错误诊断以减少敏感内容持久化。根据需要谨慎开启。
- 运行时设置 `umask 077`，并限制顶层私有数据目录权限。请检查旧 NAS 挂载目录的文件所有权，别把含凭证的目录放在共享公开目录下。
- 这套维护版提升的是可靠性和停止保护，**不能保证自动搜索不被识别或避免账号限制**。自动化可能与 Microsoft Rewards 的使用条款不符。
- Dockerfile 使用浮动的 `node:24-bookworm-slim` 基础镜像标签，**尚未按 digest 锁定**；首次构建及后续升级都需要单独审查供应链依赖。

## 升级上游

1. 修改 `upstream.env` 中的 `UPSTREAM_REF`，同时更新 `Dockerfile` 里两处 `ARG UPSTREAM_REF` 的默认值（CI 构建时会通过 build-arg 自动传入）。
2. 运行 `bash tests/patch-check.sh`（需要 Node 24）。如果补丁冲突，在上游新版本上重新做相同改动，然后用 `git diff` 重新生成补丁。
3. 提交后由 CI 构建并推送镜像。

## CI / 发布

当前以文件 .github/workflows/ci.yml 为准：源码检查 → 一次 amd64 构建 → 真实断网容器测试与 Chromium 循环 → 导出镜像与测试记录 → 手动请求且全部通过后发布同一镜像。没有实际 Actions run 记录时不得标为构建通过。

## 本地测试

```bash
bash tests/run-wrapper.test.sh    # 需要 bash、jq、util-linux；不需要 Docker 或 Node
bash tests/backup-restore.test.sh # 需要 tar、sha256sum；不需要真实账号
bash tests/patch-check.sh         # 需要 git、Node 24、网络
```

## 本次独立审计状态

详见 `AUDIT_REPORT.zh-CN.md` 和 `VERIFICATION.md`。本地源码构建、补丁检查及离线测试通过，不代表 Docker 镜像已构建。真实 Docker、非 root Chromium、GitHub Actions、NAS 和长时间容器运行均未验证；目前未达到 NAS 测试部署准入标准。

## 已知限制

- 不支持 `API_MODE`：上游 API 的进程管理器会绕过运行锁，开启后容器会拒绝启动。
- 同一套数据目录只能由一个容器使用。
- 本项目与上游一样采用 GPL-3.0-or-later 许可。自动化操作可能违反 Microsoft Rewards 服务条款，账号风险需自行承担。

离线环境无法查询 Docker 状态时，备份默认拒绝执行。仅对已人工确认无人写入的数据副本，可使用 `BACKUP_CONFIRMED_OFFLINE=1 bash scripts/backup-data.sh`。实际容器应先停止且成功查询状态。

容器运行固定为 `headless=true`、`clusters=1`，配置的并行数量不会生效，这是风险停止保护的必要限制。HTTP_PROXY/HTTPS_PROXY 不等于上游账号代理配置；每个账号的浏览器/Impit 代理需配置 ACCOUNT_N_PROXY_HTTP、ACCOUNT_N_PROXY_URL、ACCOUNT_N_PROXY_PORT。NAS 地址与可达性未实机验证。

## 当前候选版的构建与测试入口

```bash
docker build --platform linux/amd64 -t mrs-custom:1.0.3-rc1 .
SOAK_SECONDS=3600 bash tests/container.test.sh mrs-custom:1.0.3-rc1 ./test-results
```

容器测试默认完全断网，只用占位账号、本地 HTML 和合成备份；真实 Chromium 必须由非 root 启动。测试验证实际浏览器进程的 TERM/KILL 清理、锁冲突、容器停止和资源循环。该入口要求真实 Docker 引擎，缺少引擎会失败，不能自动改为模拟成功。

登录验证、锁定、限制、验证码等已识别状态会沿用全局 STOP 保护：当前账号及其他账号全部暂停；完成实际人工检查后，显式执行 `rewards-ctl resume --reviewed`。这个参数只是操作者确认，不会自动完成微软验证，也不能证明账号限制已解除。未知页面仍可能无法识别。

当前 workflow 对普通提交和 PR 只构建测试，不发布。手动运行时可显式选择 publish，必须来自 main、有明确版本号且 soak_seconds >= 3600；所有测试通过后直接发布被测试的镜像，避免第二次构建产生不同产物。已有版本标签拒绝覆盖。1 小时循环仅是发布最低门槛，不是多日稳定性的证明。

本地源码测试可执行 `bash tests/patch-check.sh`、`bash tests/run-wrapper.test.sh`、`bash tests/repeat-wrapper.test.sh` 和 `bash tests/backup-restore.test.sh`。真实 Docker 结果和 Actions run URL 未取得之前，请保留候选标签。
