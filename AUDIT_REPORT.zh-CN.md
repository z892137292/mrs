# mrs-custom v1.0.1 独立代码审计与 v1.0.2 修复报告

审计日期：2026-10-12（Asia/Shanghai）。审计范围：原 ZIP 全部运行脚本、TypeScript 补丁、Dockerfile、Compose、CI、备份恢复脚本、已有测试，以及固定上游与生产依赖。只修改本地审计副本。

## 明确结论

**暂未达到 NAS 测试部署准入标准。** 源码、静态检查和下述离线测试已通过，确定问题已修复；真实 linux/amd64 Docker 镜像没有构建成功，GitHub Actions 没有执行，非 root Chromium、NAS 权限与网络、长期容器运行和镜像回滚仍未验证。不能把本包称为“Docker 构建通过版”。

未推送 GitHub、未发布镜像、未修改 NAS 或远程仓库；未使用真实微软账号、Cookie、Token、密码或会话。测试只使用本地产生的测试数据和 example.invalid/example.com 占位账号，不进行微软积分任务实测。未上传配置、会话、备份或真实账号数据。

## 审计对象和来源

- 原包：mrs-custom-v1.0.1-fixed.zip，52,835 字节。
- 原包 SHA-256：9373d4d25c0acf74d7324b05521e1520e218156b8c607b0fb18e5232ba5efede，与用户附件校验文件一致。
- 原包是构建包装项目，未内置完整上游源码；交付保持这一架构，仍在构建时拉取固定上游并应用补丁。
- 上游：TheNetsky/Microsoft-Rewards-Script。
- 固定 commit：d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e，已实际拉取并核对 HEAD。
- 环境：Ubuntu 24.04、x86_64、Node v24.19.0、Bash、jq、git；另取得 ShellCheck 0.11.0 和 Hadolint 2.14.0。
- 没有可用 Docker CLI、daemon/socket。用户命名空间创建也受限，不能在此运行可用的嵌套 Docker 环境。

## 确定问题与修复

严重程度按本项目中的数据暴露、重复执行与风险停止影响评估；依赖项严重程度另按 npm/GitHub 公告标识。上游路径指固定源码应用修复补丁后的文件，不是原 ZIP 内独立存在的源码文件。

| 编号 | 程度 | 文件位置 | 原因及影响 | 本次修复 / 验证 |
|---|---|---|---|---|
| F01 | 高 | docker/rewards-run.sh 风控分支；.env.example | STOP_ON_BOT_WARNING=false 可关闭风险暂停。 | 取消关闭路径，风险优先于成功/重试；覆盖配置为 false 的回归测试通过。 |
| F02 | 高 | 上游 src/index.ts initialize、风险检测、runTasks；patches/0001… | 上游风险状态默认只跳过当前账号；其他账号/并行 worker 仍可继续，包装器等整个尝试结束后才看到摘要。 | 容器任务强制 clusters=1、contintueOnBotWarning=false；检测时先写风险标记及 STOP，监视器可在摘要完成前终止进程组。警告结果不继续下个账号。写标记失败直接退出 78。源码编译、标记测试和提前停止回归通过；真实风险页未验证。 |
| F03 | 高 | 上游 src/util/Http.ts send() | 429 被当成可重试错误，收到限制响应后仍自动发请求。 | 容器任务 HTTP 403/429 立即写暂停标记并抛出，不重试。用真实本地 HTTP 服务分别返回 403/429，验证每次只有 1 个请求。403 不一定是微软风控；本版选择保守暂停。 |
| F04 | 高 | docker/rewards-run.sh 重试分支 | 致命错误、超时、无摘要等未知退出可能重试原过滤集合，重复已经完成的操作。 | 只允许“非超时 + 有效摘要 + 退出码 2 + 非空失败账号列表”按失败账号重试；其他退出停止。有效摘要存在时依然按失败账号重试，原功能保留。 |
| F05 | 中 | docker/rewards-run.sh merge_attempt_summary / success 分支 | 退出 0 搭配含失败账号的摘要仍可能判成功；摘要未限制账号状态、重复项及积分字段类型。 | 拒绝不一致成功，要求非空账号、有效状态、数字积分、唯一账号及列表一致。相关回归通过。 |
| F06 | 中 | 上游 src/util/Load.ts applyAccountFilter | 过滤条件部分匹配时静默忽略未知账号，可能漏跑却报告成功。 | 任意未知账号使整个过滤失败；大小写兼容。单元测试通过。 |
| F07 | 高 | docker/lib.sh redact_stream；上游 src/logging/Logger.ts、src/util/RunSummary.ts | Cookie 原规则只遮盖第一段；代理 URL userinfo、Telegram URL Token 可残留。上游通知日志在 shell 脱敏前发送，摘要 error 原样落盘。 | Cookie 整行、常见凭证字段、代理 URL、Telegram URL 脱敏；在上游日志发送前及摘要 error 保存前处理。合成敏感串回归通过。不能承诺识别所有未知格式；原始 diagnostics 和 sessions 仍为敏感资料。 |
| F08 | 中 | 上游 config.example.json / src/index.ts initialize | 固定上游 headless=false，镜像没有显示服务；默认任务浏览器启动条件不匹配。 | 容器包装任务强制 headless=true。源码与编译验证通过；真实 Chromium 启动仍未验证。 |
| F09 | 中 | scripts/backup-data.sh；tests/backup-restore.test.sh | mkdir -p -m 的权限表达触发 ShellCheck SC2174；测试中单独使用 ! pipeline 会跳过 errexit，触发 SC2251，且排除 .env 的断言可能失败却继续。 | 明确 mkdir 后 chmod；将排除断言改为 if 检查。ShellCheck 0.11.0 实际通过。 |
| F10 | 中 | scripts/backup-data.sh Docker 状态检查 | Docker compose ps 的错误被吞掉，无法判断运行状态时仍备份，可能保存不一致 SQLite/WAL/会话。 | 状态查询失败拒绝备份；没有 Docker 状态时要求显式确认数据离线。测试仅针对独立离线夹具。未实机验证 NAS Docker 停止查询。 |
| F11 | 中 | scripts/restore-data.sh | 只拒绝软/硬链接，仍可接受 FIFO 等特殊文件；进程替换中的 tar 列表失败未可靠阻止创建恢复目录。 | 先完整检查两份列表及 tar 返回值，只允许普通文件/目录，再创建新目标。FIFO、损坏归档、校验不匹配及覆盖已有目录均拒绝，真实 tar 测试通过。 |
| F12 | 高（依赖公告） | 上游 package.json / package-lock.json；patches/0002-adm-zip-security.patch | fingerprint-generator → generative-bayesian-network → adm-zip 0.6.0 落在多个已公布漏洞的受影响范围内。 | 添加精确 overrides=0.6.1，并只更新该锁文件条目，保留其他依赖的 libc 元数据。重新 npm ci、编译及生产依赖审计通过，审计计数降至 0。未做漏洞利用测试，不能推断攻击已发生。 |
| F13 | 中 | .github/workflows/ci.yml 两项冒烟测试 | 测试容器未隔离网络，且定时计划可能在测试窗口触发占位账号任务。 | 两项 docker run 加 --network none；监督器测试计划改到年度低频时点，RUN_ON_START=false。修改后的 workflow 仅静态验证，Actions 未执行。 |
| F14 | 低 | README.md / VERIFICATION.md / CHANGELOG.md | 原文测试通过声明与未验证清单不一致；迁移描述容易被理解为可直接共享旧数据。 | 重写当前结果和限制，测试部署要求独立目录及副本，禁止共享正在运行的数据。 |
| F15 | 中 | docker/rewards-run.sh 暂停分支及日志清理 | 暂停状态提前退出，绕过日志保留清理；长期暂停仍每次创建日志，可持续积累。 | 将保留期清理移到暂停判断前。过期日志在暂停触发时删除的回归通过。仍不提供单次日志容量上限。 |
| F16 | 中 | docker/rewards-run.sh 参数校验 | WATCH_INTERVAL_SECONDS=0 允许无间隔监视循环，RUN_TIMEOUT_SECONDS=0 导致立即终止；与有效监视/超时配置不符。 | 两项要求大于 0；零值拒绝回归通过。 |

补丁后的关键上游位置：src/index.ts initialize / 风险检测；src/util/Http.ts send；src/logging/Logger.ts baseLog；src/util/RunSummary.ts 风险标记与脱敏。完整差异见两份 patches/*.patch。

## 实际构建和测试结果

| 检查 | 结果 | 证据 / 限制 |
|---|---|---|
| 原 ZIP SHA-256 | 通过 | 与附件一致 |
| 原补丁应用到固定 commit | 通过 | git fetch、HEAD 核对、git apply --check / git apply |
| 修复后的两份补丁干净应用 | 通过 | 最终 clean-room 检查，日志 cleanroom-delivery.log |
| npm ci / Node 24 TypeScript 构建 | 通过 | 实际安装并执行 npm run build，不是 Docker 构建 |
| ESLint / Prettier | 通过 | 实际命令执行；最终 clean-room 再次检查 |
| 补丁测试 | 13 通过、0 失败 | patch-unit-after.log；包括本地真实 HTTP 403/429，不含微软连接 |
| 包装器行为测试 | 46 通过、0 失败；2 组跳过 | wrapper-after.log；使用 fake-bot 测试包装器，不代替真实 Docker/Chromium |
| 停止控制及 kill-9 孤儿扫描 | 未验证 | 两组依赖 /proc 的测试因 PID 命名空间不匹配跳过；原测试在此环境停止控制阶段曾卡住，终止后加了明确跳过提示 |
| 超时进程组清理 | 通过（离线夹具） | TERM→KILL、测试子进程结束；不是 Chromium 进程实测 |
| 短期重复/并发触发 | 通过 | 20 次连续运行 + 10 个并发触发，共 25 秒；并发只执行 1 个 bot；本轮 PID、PGID、临时风险/摘要文件清理 |
| 备份恢复 | 通过（离线夹具） | 真 tar/sha256sum/cmp；权限、.env 排除、校验、损坏、FIFO、目标覆盖检查；无真实会话 |
| Bash 语法 | 通过 | 所有 docker/scripts/tests Shell 文件 |
| ShellCheck 0.11.0 | 通过 | shellcheck.log 无诊断，退出 0 |
| Hadolint 2.14.0 | 通过 | hadolint.log 无诊断，退出 0 |
| YAML 解析 | 通过 | Compose 与 workflow 语法；不是 docker compose config |
| GitHub Actions 固定引用 | 6 个 commit 可拉取 | action-pins.json；不等于 Action 已运行或发布成功 |
| supercronic amd64 下载校验 | 通过 | v0.2.49 实际下载，SHA-256 与 Dockerfile 匹配 |
| 生产依赖 npm audit | 修复前 1 高危 → 修复后 0 | npm-audit.json、npm-audit-after.json；只代表当时 npm 数据库覆盖范围，不包含 OS 包扫描 |
| linux/amd64 Docker 构建 | 未验证：环境阻塞 | 实际尝试 docker build --platform linux/amd64，命令退出 127：docker: command not found；没有镜像产物 |
| GitHub Actions build/test/publish | 未执行 | 未触发远程 workflow，未推送代码/镜像 |
| 非 root Chromium / 完整镜像 selftest | 未验证 | 没有可运行的目标镜像 |
| NAS Compose config / 启停 / 重启 / 调度 | 未验证 | 未接触 NAS |
| 24/72 小时资源泄漏、Chromium 孤儿进程 | 未验证 | 25 秒的包装器重复运行不能证明长期稳定 |
| 镜像版本回滚 | 未验证 | 无旧/新镜像 digest 和 Docker 引擎；只提供下方操作原则 |

## 十项重点检查的覆盖与边界

1. **TypeScript 与固定 commit**：已确认补丁精确应用、编译、lint、format 和自定义测试通过。不能据此证明所有真实页面行为兼容。
2. **Dockerfile**：检查多阶段 source/builder/runtime、固定 SHA、依赖安装、Chromium 路径、tini、工具、数据挂载与降权流程；Hadolint 通过。真实层执行、Debian 包解析、patchright 安装及最终启动未验证。
3. **GitHub Actions**：检查 lint→patch→image 的依赖、PR 不推送、镜像元数据、GHCR 权限、固定 action SHA。所有 SHA 可拉取。远程权限、runner、GHCR、构建缓存和最终发布仍未验证。
4. **互斥/重试/积分/熔断/超时**：离线测试覆盖锁冲突、按失败列表重试、多轮积分汇总、失败计数、STOP、信号/超时路径。积分汇总只累加上游已经报告的数据；若任务中途崩溃、账号未报告已获得积分，不能凭本地摘要恢复真实积分账。失败账号重试也不能证明账号内部每个任务完全幂等。
5. **风险停止**：明确 bot-score 和 403/429 强制暂停，不引入验证码绕过、认证注入或账号限制绕过。没有验证所有验证码、未知限制页和登录异常都能被识别；上游的认证/活动实现未整体重写。已知 HTTP 风险只覆盖通过被修改 HttpClient 的请求，浏览器导航或其他网络库的响应不能自动视为全覆盖。
6. **敏感数据**：原包没有真实 .env/config/sessions/备份；构建 .dockerignore 仅放行 Dockerfile、patches、docker。日志为尽力脱敏；config、sessions.db/WAL、diagnostics、状态中的账号标识、备份仍须保密。配置与数据目录默认 owner-only，不提供备份加密；.env 不在备份内，需另外安全保存。启动时只修改数据文件所有权，不能保证旧文件历史权限已全部收紧。
7. **非 root Chromium**：entrypoint root 阶段创建/调整目录后 setpriv 降权；PUID=0 拒绝。实际非 root 启动、浏览器安装目录访问、sandbox、seccomp 和 no-new-privileges 组合未验证。headless 修复不等于浏览器 sandbox 已验证。用户在 Compose 额外指定 user 时会跳过 root 权限修正，必须自行确保挂载可写。
8. **NAS Compose**：本项目为调度+CLI，不暴露端口，API_MODE 明确拒绝；并非漏配 Web 端口。相对挂载目录、shm_size=1gb、60s stop_grace、cap_drop/add、日志轮转和 TZ=Asia/Shanghai 已静态检查。示例代理 192.168.0.202:17890 未验证可达；HTTP_PROXY/HTTPS_PROXY 不等于账号 Chromium/Impit 代理，需逐账号配置。运行时 env_file 的代理也不会自动配置 Docker daemon 的拉取代理。UID/GID 1000 只是示例，不代表实际 NAS 用户。只有一个容器可使用一套数据。
9. **备份/恢复/回滚**：独立数据副本备份/恢复执行通过；脚本只向全新目录解压。没有执行真实 NAS 备份、迁移或镜像回滚。旧代码读取新会话数据库的兼容性未知，不能只切 IMAGE 并继续使用新数据。
10. **长时间与孤儿进程**：有限重复/并发测试通过；tini、setsid、flock、组清理有保护。逃离进程组的子进程、真实浏览器内存增长、异常掉电和多日文件系统增长没有实测。LOG_RETENTION_DAYS 是按天清理，不是每次运行日志的容量上限；高输出任务仍可能耗尽磁盘。镜像浮动基础标签未按 digest 固定，构建可重现性有边界。

## 仍须完成的部署准入检查

这些是未执行的验证步骤，不是已经成功的结果：

1. 在有 Docker 的独立测试主机执行 linux/amd64 构建及 docker compose config，保存构建日志和镜像 digest。
2. 无网络、无真实账号运行镜像 selftest，验证非 root Chromium；验证实际 UID/GID、数据文件权限和 SIGTERM 清理。
3. 独立测试目录运行监督器，RUN_ON_START=false，使用占位账号和受控计划；验证调度、锁、容器重启、宕机恢复及 STOP 持久化。不得挂载旧容器数据。
4. 完成 GitHub Actions 本次版本完整 workflow，核对 lint/patch/image 三项及两项冒烟，再经用户确认发布。
5. 用合成数据与离线本地测试负载进行 24/72 小时容器观察，记录 RSS、FD、进程数、磁盘增长及残留 Chromium；不把假 bot 结果当浏览器稳定性结果。
6. 回滚演练：保留旧镜像 digest、旧 Compose/.env 私有副本和停止状态下的数据备份；恢复到全新目录并匹配旧镜像，用独立测试项目启动和无网络自检。确认可读后再规划切换；不要覆盖实时数据，不使用 docker compose down -v。无已验证 digest 时，不应编造回滚命令中的镜像值。

## 交付与复核

- 修复版本：v1.0.2，mrs-custom-v1.0.2-audited.zip；保持原项目结构，增加第二份最小依赖安全补丁和有限重复测试，没有添加业务功能。
- 本报告、VERIFICATION.md、CHANGELOG.md 已纳入项目。
- 测试证据单独打包，只含上述离线日志、依赖审计结果、固定引用和二进制校验结果，不含任何配置、会话或备份。
- ZIP SHA-256 另附；原上传文件保持不变。
- 审计结果是“已修复并通过源码/离线检查，等待真实容器验证”，不是部署许可或无风险证明。

依赖公告来源：
- [GHSA-7q85-xj36-vmfc](https://github.com/advisories/GHSA-7q85-xj36-vmfc)（adm-zip <0.6.1，修复版 0.6.1）
- [GHSA-rcw4-f5rp-g42v](https://github.com/advisories/GHSA-rcw4-f5rp-g42v)
- 完整 npm 告警记录见测试证据中的 npm-audit.json。

