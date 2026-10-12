# 升级、备份和回滚

旧 v1.0.3 镜像和原 NAS 始终保留。候选镜像使用独立 1.1.0-rc.1 标签，不能改 old/latest。禁止自动覆盖旧 Git 标签、合并 main 或替换旧容器。

首次候选部署只用新项目和新数据。升级候选项目时先暂停并安全停止 rewards，停止 Web 后备份 Web SQLite 所在整个 web-data 和 control-data 卷（连同 WAL/SHM，在停机状态下），连同版本 digest 和私有 .env。原 scripts/backup-data.sh 只备份旧的业务目录，不包括新增 Web/控制卷，也不包含 .env；不要误以为它已保存通知凭证和管理员数据。

```bash
# 只操作新候选项目，不操作旧 NAS 项目
docker compose -f compose.web.yaml exec rewards rewards-ctl pause maintenance
docker compose -f compose.web.yaml exec rewards rewards-ctl stop
docker compose -f compose.web.yaml stop
```

按原脚本 `--help` 在停止状态执行业务目录备份/恢复；恢复只能到全新目录。新命名卷的停机备份可使用 Docker 本地 tar 工具镜像将整卷归档到私有目录；须确认源卷的实际项目名，不写死旧容器路径，压缩包权限0600。不得把管理员/通知备份上传 GitHub。没有备份加密功能。

回滚使用保留的旧镜像 digest + 匹配旧版本的停止数据副本，恢复到全新目录并启动独立项目；不要让旧代码直接读取新数据、不要共享正在运行的 sessions/state。旧1.0.3没有Web，回滚核心时同时停止新Web控制服务，或完整回到匹配的一对候选镜像及对应新卷。禁止 docker compose down -v。

真实 NAS 的旧/新镜像会话回滚未在本任务自动执行。合成业务数据的实际备份恢复和新Web重启持久化是不同验证，不冒充真实账号升级回滚成功。
