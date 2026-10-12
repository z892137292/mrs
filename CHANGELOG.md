# 1.0.3-rc1（未正式发布）

- 已识别的登录验证、锁定/验证码等状态写 STOP 并立即退出 78；容器登录不调用 disableFido。
- 明确 HTTP 403/429 改为立即退出，避免被上游捕获后继续业务。
- 风险恢复要求 resume --reviewed；保留全局保守暂停。
- 调度器先停止接收调度，再停止活动任务。
- 增加真实非 root Chromium 循环、实际浏览器进程清理和容器测试脚本。
- 发布一次构建的已测试镜像；普通提交不发布，手动发布有时长/分支/版本门槛。
- Compose 指定 amd64；增加 OCI 版本信息。
- 实际镜像/Actions/Chromium 仍未验证，详见 RELEASE_STATUS.zh-CN.md。

# v1.0.2 独立审计修复

- 风控暂停不可关闭；明确风控与 HTTP 403/429 在摘要完成前持久暂停并停止当前尝试。
- 容器任务强制 headless 与单进程，警告后不继续其他账号。
- 仅可信部分失败摘要允许按失败账号重试；未知退出、超时和不一致摘要停止重试。
- RUN_ACCOUNT_FILTER 含未知账号时整体拒绝，摘要验证收紧。
- Cookie 整行、代理 URL 凭证与 Telegram URL Token 脱敏。
- 备份状态查询失败时拒绝，备份目录限制权限；恢复拒绝特殊文件与无校验的损坏归档。
- 修复 ShellCheck CI 问题；冒烟容器使用 network none。
- 依赖 adm-zip 0.6.0 -> 0.6.1，通过最小 overrides + 锁文件补丁固定。
- 暂停期间仍按保留期清理日志；拒绝零监视间隔和零秒超时。
- Docker / NAS / GitHub Actions / 非 root Chromium / 长期运行尚未验证。详见独立审计报告。

# CHANGELOG

## v1.0.1 — local safety/reliability fixes

- Risk warnings default to STOP_ON_BOT_WARNING=true. Halt further attempts as soon as the current bot attempt reports a warning, set a persistent STOP file and return exit code 78. Do not retry that run.
- Merge per-attempt account results across the entire run, keeping earlier successes and summing points; retry only failed accounts. Treat missing/invalid summaries as errors rather than silently accepting success.
- Tighten file creation permissions via `umask 077` and top-level data-directory mode 0700. Redact common password, Token, Cookie and Authorization patterns in the logs in addition to optional e-mail masking. **Best effort, not a guarantee.**
- Restore Asia/Shanghai and 09:15 schedule. Include the original proxy URL and five original task toggles in `.env.example`; defaults to `RUN_ON_START=false` for safer new deployments.
- Disable error diagnostic captures by default via `.env.example`.
- Update CI to publish only linux/amd64 and test backup/restore scripts.
- Add offline `scripts/backup-data.sh` and `scripts/restore-data.sh`, never overwriting live files and omitting `.env` by default.
- Expand shell runner test coverage from 38 to 50 assertions and add backup/restore verification.
- No claimed Docker image build or Microsoft account/Chromium runtime validation in this environment. API_MODE remains unsupported.
