# NAS Web 候选版独立安装

这是新增独立测试项目，不替换旧容器。先保存旧镜像 digest、旧 Compose、私有 .env 和停止状态下的备份；不要把旧数据直接挂进候选项目。

1. 建立新目录，例如 /vol1/docker/mrs-web-candidate，下载功能分支完整项目。检查 NAS 为 amd64，内存至少足够 Chromium 和新增 Node 服务。
2. 复制 `.env.web.example` 为 `.env`，`chmod 600 .env`。分别执行两次 `openssl rand -hex 32`，填 CONTROL_API_TOKEN 和 WEB_BOOTSTRAP_TOKEN；不要贴到聊天/GitHub。
3. PUID/PGID 对应新数据目录所有者。Web 容器固定 UID/GID 1000，Docker 新建 web-data 命名卷继承其可写权限。rewards 的 control-data 使用新命名卷；Web 只挂自己的 /data。
4. 访问本机用默认绑定 127.0.0.1；手机/电脑 LAN 访问时把 WEB_BIND_IP 改成 NAS 的具体可信管理 IP，例如 192.168.9.20，把 ADMIN_PUBLIC_URL 改成 `http://192.168.9.20:8088`。它用于严格 Origin 校验，必须与浏览器实际地址（协议、主机、端口）一致。不要设 0.0.0.0 或直接公网映射。
5. 初次隔离自检只使用 ci@example.invalid、不填真实密码，会话目录全新。默认 RUN_ON_START=false、年度计划。若要完全断网，可另写测试 override 将两个服务的 egress 网络改为 internal；正式使用需要通知和业务网络可达，但本次不执行真实账号自动任务。
6. 只有候选 Actions 实际发布后填最终镜像 digest；否则自行真实构建不能称为已经测试的 registry 镜像。拉取私有 GHCR 包时在 NAS 本地登录，不上传凭证。

```bash
docker compose -f compose.web.yaml config --quiet
docker compose -f compose.web.yaml pull
docker compose -f compose.web.yaml up -d
docker compose -f compose.web.yaml exec rewards rewards-ctl selftest
docker compose -f compose.web.yaml ps
```

登录地址 `http://<NAS管理IP>:8088/`。首次页面输入初始化令牌、3–32 位用户名和至少 12 位密码。创建后登录；初始化令牌不再允许创建第二个管理员，可在保留新管理员 DB 的前提下轮换该环境令牌。不要删除 web-data 来“重置”管理员或密码，否则会丢失审计、会话、通知配置。当前版本没有密码找回页面。

Web 健康检查独立；rewards 健康检查仍以原调度器为准。Web 不依赖 scheduler 健康才能启动，它在核心不可达时显示错误而不自动跑任务。容器引擎状态不可读取时明确显示控制服务可达，不把它伪装成 Docker Engine 检查。

HTTP 的 Cookie 使用 HttpOnly/SameSite=Strict，但没有 Secure 标志；HTTP 只适用于隔离可信管理网络。HTTPS 反向代理时设置 ADMIN_PUBLIC_URL=https://你的管理域名、WEB_COOKIE_SECURE=true；仅连接可信单层代理时 WEB_TRUST_PROXY=true。代理必须清洗转发头，NAS 防火墙只允许代理/管理网访问该绑定端口。严格 Secure Cookie 会拒绝 HTTP 登录。

端口：Web 8088 → 8080；控制 API 8090 只在私有网络，不发布宿主端口。没有 Docker Socket。Chromium 与调度仍在 rewards，Web 退出不会清除 STOP 或触发任务。

代理：HTTP_PROXY/HTTPS_PROXY 不等于 Chromium/Impit 每账号代理；沿用每账号 ACCOUNT_N_PROXY_* 配置。Web 的 Telegram 出网需要管理网络可访问 api.telegram.org，SMTP 需允许所配主机端口；本版不从 Web 配置任意 HTTP 代理，不把 NAS 拉取代理当通知代理。
