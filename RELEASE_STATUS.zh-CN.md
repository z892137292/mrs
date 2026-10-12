# 当前远程验证状态

专用仓库已确定为 z892137292/mrs，正在通过 candidate/v1.0.3-rc1 分支验证真实 Docker 构建与断网容器测试。尚未发布正式镜像。以下报告记录提交前的本地验证状态；其中“缺少仓库地址”的阻塞已经解除，其他测试结果须以当前 GitHub Actions run 为准。

---

# Microsoft Rewards Custom 1.0.3-rc1 执行报告

日期：2026-10-12（Asia/Shanghai）。基线：已交付的 v1.0.2。固定上游 commit 仍为 d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e。

## 当前交付状态

本次已经修改可执行代码、完成源码编译与可运行的本地自动化测试，并编写实际 Docker 容器测试入口和发布流水线。**尚未完成用户要求的正式镜像交付，不能标为稳定正式版。**

具体阻塞：
- 本执行环境没有可用的 Docker CLI、daemon/socket；实际 docker build 尝试退出 127，容器测试入口明确返回 127，不会退回模拟成功。
- 当前进程没有所需 capabilities，用户命名空间初始化失败（Operation not permitted），无法在这里启动可用的嵌套 Docker 引擎。
- GitHub 连接已经可用；当前可访问的仓库列表中没有此 Rewards 项目。用户选择提供专用仓库，但尚未提供 owner/repo 或具体链接。没有向无关仓库写入文件、没有创建虚构的 Actions 记录。
- 未取得真实镜像 ID、registry digest、Actions run URL、镜像归档或真实 Chromium 容器运行报告。正式发布未执行。

交付包因此使用 **1.0.3-rc1**。原 v1.0.2 文件保持不变，不覆盖原有 NAS 容器，不连接真实微软账号执行测试。

## 已完成的代码变更

### 登录验证与限制：在自动处理前停止

新增第三份最小补丁 patches/0003-login-verification-stop.patch：
- src/util/LoginSafety.ts 对已识别的账号锁定、登录错误、邮件/恢复邮箱验证、TOTP、OTP、Authenticator、Passkey、验证码、要求选择替代验证方式等状态进行检查。
- src/browser/auth/Login.ts 在 handleState 自动执行之前检查；并在“按域名假定已登录”的捷径之前检查可见验证/限制元素。
- 容器自动化路径不再调用 disableFido 隐藏 FIDO 验证界面。
- 写入风险标记与 STOP 后直接退出 78，避免上游把错误变成普通账号失败并继续下一账号。
- HttpClient 的明确 HTTP 403/429 也改为立即退出 78。原“写标记后抛出错误”的路径仍可能被上游捕获，本版不依赖监视器轮询来阻止后续业务。
- 不添加浏览器反检测伪装、不解决验证码、不绕过账号限制。保持原稳定依赖和现有 Chromium 安装方式，不修改 coreBundle.js。

延续保守的全局 STOP：一个账号遇到这些状态时暂停全部自动化。它比只暂停该账号更严格；并不是实现了按账号独立恢复。未知页面和未来变化的微软 DOM 不可能仅凭这些离线检查保证全部识别。

### 人工恢复确认

docker/rewards-ctl.sh：
- 普通 resume 不解除风险/验证暂停，返回 78，并保留 STOP。
- 操作者完成实际检查后才执行 rewards-ctl resume --reviewed。
- --reviewed 只是明确的操作者确认，不会代替微软验证，也不证明限制已经解除。
- 一般手动维护暂停/失败熔断的恢复方式保留。

### 调度退出及身份检查

- docker/rewards-supervisor.sh 在停止当前任务之前先通知 scheduler 停止接收新调度，避免退出过程中出现新任务。
- docker/rewards-selftest.sh 增加非 root 身份断言。
- Compose 明确指定 linux/amd64，候选镜像标签为 1.0.3-rc1。
- Dockerfile 增加 APP_VERSION 和 OCI 版本 label，没有更换来源不明的浏览器补丁。

### 已编写真实容器测试

tests/container.test.sh 要求真实 Docker 引擎和已经构建的 amd64 镜像：
1. 核对镜像架构和 ID，执行 docker compose config。
2. 启动独立、唯一命名的测试容器，完全断网，复用 Compose 的 capability/no-new-privileges 约束；不挂载真实账号数据。
3. 实际启动非 root Chromium 自检。
4. 在容器内执行包装器、并发/重复、备份恢复测试；CI 环境不允许静默跳过 PID/proc 测试。
5. 通过 tests/chromium-runtime.mjs 反复实际启动 Chromium、载入本地 HTML、关闭浏览器，默认循环 3600 秒；记录 RSS、可读取 FD 总数和进程数，设定增长阈值。FD 统计仅覆盖可读取的 /proc 条目，不是特权级全进程审计。
6. tests/chromium-child.mjs 启动真实浏览器并故意抵抗 TERM，用于验证运行锁返回 75、wrapper 停止/升级 KILL 和浏览器残留清理。
7. 再次启动实际浏览器任务，执行 docker stop，检查监督器退出、耗时和 Bye 日志。
8. 只清理本测试创建的容器与临时目录，不操作原 NAS 容器。

上述容器脚本已通过语法/静态检查，**尚未实际执行到 Docker/Chromium 阶段**。不能把浏览器测试代码已经写好等同于浏览器测试通过。

### GitHub 发布门槛

.github/workflows/ci.yml：
- lint、补丁干净应用/编译测试通过后，仅构建一次 linux/amd64 镜像。
- 真实容器测试失败时不导出正式镜像、不执行发布。
- 容器测试成功后保存被测试镜像 ID、docker save 归档和校验值。
- 发布直接 docker tag/push 同一镜像，避免第二次构建产生不同产物。
- 普通 push/PR 不发布。手动 publish 需要 main 分支、明确版本号、至少 3600 秒 Chromium 循环；发现目标版本 tag 已存在时拒绝覆盖。
- 记录镜像和测试结果作为 Actions artifact。新增 upload-artifact 固定 commit 已通过上游 tag 查询取得。
- 1 小时循环只是所写发布流程的最低门槛，不是 24/72 小时稳定性的证明。多日长期运行仍须在可持续运行的独立测试 Docker 主机验证。

没有运行该 workflow，没有 GHCR 发布日志。

## 实际执行结果

| 项目 | 本次结果 | 证据与范围 |
|---|---|---|
| 三份补丁应用 | 通过 | 将独立源码工作目录重置到固定 commit，再逐份 git apply --check / git apply |
| npm ci / TypeScript | 通过 | 实际重新安装、编译；不是 Docker 层构建 |
| ESLint / Prettier | 通过 | 实际检查完整 src |
| 补丁测试 | 14 通过，0 失败 | 包括真实本地 HTTP 403/429 只请求一次并退出 78；验证策略检查及 STOP；没有请求微软 |
| 包装器断言 | 48 通过，0 失败 | 增加风险恢复确认拒绝/显式确认测试 |
| 依赖 /proc 的控制停止、孤儿扫描 | 2 组跳过 | 沙箱 PID 命名空间与 /proc 不一致；真实容器 CI 要求不跳过 |
| 有限重复/并发 | 通过 | 20 次离线包装器运行 + 10 个并发触发，实际本轮 77 秒；并发只执行 1 次测试 bot |
| 备份恢复 | 通过 | 真 tar、SHA-256、cmp；离线合成数据；包括特殊文件、损坏和覆盖保护 |
| ShellCheck 0.11.0 | 通过 | 覆盖 docker、scripts、tests Shell 文件 |
| Hadolint 2.14.0 | 通过 | 修订 Dockerfile |
| Bash / JS 语法、YAML | 通过 | 新增真实浏览器脚本、容器入口、workflow 和 Compose |
| linux/amd64 Docker 构建 | 未验证，环境阻塞 | docker: command not found，退出 127；没有镜像 |
| 非 root Chromium 启动 | 未验证 | 容器测试未执行 |
| 容器停止 / 真实浏览器进程清理 | 未验证 | 容器测试未执行；离线 fake bot 的组清理不能代替此项 |
| 1 小时及多日 Chromium 循环 | 未验证 | 没有可运行 Docker |
| GitHub Actions | 未执行 | 缺少专用仓库地址；无 run URL 或成功记录 |
| 正式镜像发布 | 未执行 | 关键真实测试不满足，不发布 |

测试过程中曾有一次子进程在原 5 秒预算内未能完成启动，返回超时。将测试子进程启动上限改为 30 秒并对最终补丁重新运行，最终 14 项通过；业务风险仍立即退出 78，没有改变为延迟停止。

## 积分、重复执行及稳定性边界

保留 v1.0.2 的锁、失败账号限定重试、熔断、摘要验证和累计逻辑。本轮不是完整重构。

积分统计只能累计上游实际报告的数字；中途崩溃而未报告的积分仍未知，不能当作真实积分余额的完整账本。没有真实账号余额核对。互斥测试证明的是并发运行不会重复启动同一测试任务，不保证外部微软活动在所有异常下具备业务级幂等性。

真实容器进程组、非 root 权限、Chrome sandbox、额外脱离进程组的子进程和持续内存增长都等待实际测试。浮动基础镜像、NAS 代理可达性、UID/GID 和数据权限仍有上次报告所述限制。

## 可以执行的入口

在新建的独立 Docker 测试主机/目录中：

```bash
docker build --platform linux/amd64 -t mrs-custom:1.0.3-rc1 .
SOAK_SECONDS=3600 bash tests/container.test.sh mrs-custom:1.0.3-rc1 ./test-results
```

当前开发沙箱无法执行到这些真实步骤。不得在原 NAS 容器上替换测试，不得把原账号目录挂载到测试容器。

实际 Actions 所需的下一项输入：**专用 GitHub 仓库地址（owner/repo 或完整链接）**。当前可访问列表里没有 Rewards 项目；不会擅自选用其他业务仓库。收到地址后才能确定独立构建分支、上传经过测试的代码并取得真实 run 记录。

## 交付文件

- mrs-custom-v1.0.3-rc1.zip：完整候选包装项目，含第三份补丁、真实容器与浏览器测试、发布门槛和 Compose。
- compose-v1.0.3-rc1.yaml：同一 Compose 副本；运行时应放回项目根目录，配套 Dockerfile 与私有 .env。
- 本执行报告、校验文件及本轮测试证据。
- 原 v1.0.2 审计报告留作历史记录，不代表本轮容器验证已完成。

**正式镜像、真实 Docker 验证和 Actions 记录仍未交付。当前完成的是可执行候选代码与源码/离线测试，不是已验证的长期稳定正式版。**

