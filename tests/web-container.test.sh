#!/usr/bin/env bash
# Real Docker integration, isolated network/data, no Microsoft traffic.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
REWARDS_IMAGE="${1:-mrs-custom:web-ci}"
WEB_IMAGE="${2:-mrs-web:ci}"
OUT="${3:-$ROOT/test-results/web}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
docker info >/dev/null
NAME="mrs-web-check-$(date +%s)-$$"
NETWORK="$NAME-net"
WEB="$NAME-web"
REWARDS="$NAME-rewards"
VOLUME="$NAME-data"
RESTORE_VOLUME="$NAME-restored-data"
RESTORED="$NAME-restored-web"
WORK="$(mktemp -d)"
cleanup() {
    docker logs "$REWARDS" >"$OUT/rewards-service.log" 2>&1 || true
    docker logs "$WEB" >"$OUT/web-service.log" 2>&1 || true
    docker rm -fv "$WEB" "$REWARDS" "$RESTORED" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    docker volume rm "$RESTORE_VOLUME" >/dev/null 2>&1 || true
    rm -rf -- "$WORK"
}
trap cleanup EXIT
CONTROL_TOKEN="$(openssl rand -hex 32)"
BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
cp "$ROOT/compose.web.yaml" "$WORK/compose.web.yaml"
printf 'CONTROL_API_TOKEN=%s\nWEB_BOOTSTRAP_TOKEN=%s\nREWARDS_IMAGE=%s\nWEB_IMAGE=%s\n' \
    "$CONTROL_TOKEN" "$BOOTSTRAP_TOKEN" "$REWARDS_IMAGE" "$WEB_IMAGE" >"$WORK/.env"
docker compose -f "$WORK/compose.web.yaml" --project-directory "$WORK" config --quiet
printf 'PASS: actual docker compose config\n' >"$OUT/compose-validation.txt"
for image in "$REWARDS_IMAGE" "$WEB_IMAGE"; do
    test "$(docker image inspect --format '{{.Architecture}}' "$image")" = amd64
done
docker network create --internal "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$REWARDS" --network "$NETWORK" --network-alias rewards --shm-size=1g \
    --security-opt no-new-privileges:true --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL \
    -e CONTROL_API_ENABLED=true -e CONTROL_API_TOKEN="$CONTROL_TOKEN" \
    -e WEB_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" -e ACCOUNT_1_EMAIL=ci@example.invalid \
    -e ACCOUNT_1_PASSWORD=NEVER_EXPOSE -e RUN_ON_START=false -e CRON_SCHEDULE='0 0 1 1 *' \
    -v "$ROOT:/audit-project:ro" "$REWARDS_IMAGE" >/dev/null
docker run -d --name "$WEB" --network "$NETWORK" --network-alias web \
    --security-opt no-new-privileges:true --cap-drop ALL --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -e CONTROL_API_TOKEN="$CONTROL_TOKEN" -e WEB_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
    -e CONTROL_URL=http://rewards:8090 -e ADMIN_PUBLIC_URL=http://web:8080 \
    -v "$VOLUME:/data" "$WEB_IMAGE" >/dev/null
for ((i=0;i<30;i++)); do
    if docker exec -u 1000:1000 "$REWARDS" node -e 'fetch("http://web:8080/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi
    sleep 1
done
test "$(docker exec "$WEB" id -u)" = 1000
test "$(docker exec "$REWARDS" rewards-ctl selftest | tail -n 1)" = 'selftest: all checks passed'
docker exec -u 1000:1000 "$REWARDS" node /audit-project/admin/test/browser-smoke.mjs >"$OUT/browser-ui.log" 2>&1
docker cp "$REWARDS:/tmp/mrs-admin-mobile.png" "$OUT/mobile.png" >/dev/null
docker cp "$REWARDS:/tmp/mrs-admin-desktop.png" "$OUT/desktop.png" >/dev/null
docker stop -t 20 "$WEB" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$WEB")" = 0
docker exec "$REWARDS" rewards-healthcheck
# Actual offline Web database backup/restore into a NEW volume. Never export it as an artifact.
docker run --rm --network none --user 1000:1000 -v "$VOLUME:/data:ro" "$WEB_IMAGE" \
    tar -C /data -cf - . >"$WORK/web-private-backup.tar"
chmod 600 "$WORK/web-private-backup.tar"
sha256sum "$WORK/web-private-backup.tar" >"$WORK/web-private-backup.sha256"
sha256sum -c "$WORK/web-private-backup.sha256" >/dev/null
docker volume create "$RESTORE_VOLUME" >/dev/null
docker run --rm -i --network none --user 1000:1000 -v "$RESTORE_VOLUME:/data" "$WEB_IMAGE" \
    tar -C /data -xf - <"$WORK/web-private-backup.tar"
docker run -d --name "$RESTORED" --network "$NETWORK" --network-alias restored-web \
    --security-opt no-new-privileges:true --cap-drop ALL --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -e CONTROL_API_TOKEN="$CONTROL_TOKEN" -e WEB_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
    -e CONTROL_URL=http://rewards:8090 -e ADMIN_PUBLIC_URL=http://web:8080 \
    -v "$RESTORE_VOLUME:/data" "$WEB_IMAGE" >/dev/null
for ((i=0;i<30;i++)); do
    if docker exec -u 1000:1000 "$REWARDS" node -e 'fetch("http://restored-web:8080/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi
    sleep 1
done
docker exec -u 1000:1000 "$REWARDS" node --input-type=module -e '
    import assert from "node:assert/strict";
    const r=await fetch("http://restored-web:8080/api/session");const s=await r.json();assert.equal(s.initialized,true);
    const cookie=r.headers.get("set-cookie").split(";")[0];
    const login=await fetch("http://restored-web:8080/api/login",{method:"POST",headers:{cookie,origin:"http://web:8080","content-type":"application/json","x-csrf-token":s.csrf},body:JSON.stringify({username:"admin",password:"ContainerPassword12345"})});
    assert.equal(login.status,200);console.log("PASS: actual stopped Web tar backup, checksum and new-volume restore/login");' >"$OUT/web-backup-restore.log"
docker stop -t 20 "$RESTORED" >/dev/null
docker start "$WEB" >/dev/null
for ((i=0;i<30;i++)); do
    if docker exec -u 1000:1000 "$REWARDS" node -e 'fetch("http://web:8080/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then break; fi
    sleep 1
done
docker exec -u 1000:1000 "$REWARDS" node --input-type=module -e '
    import assert from "node:assert/strict";
    const r=await fetch("http://web:8080/api/session");const s=await r.json();assert.equal(s.initialized,true);
    const cookie=r.headers.get("set-cookie").split(";")[0];
    const login=await fetch("http://web:8080/api/login",{method:"POST",headers:{cookie,origin:"http://web:8080","content-type":"application/json","x-csrf-token":s.csrf},body:JSON.stringify({username:"admin",password:"ContainerPassword12345"})});
    assert.equal(login.status,200);console.log("PASS: Web restart preserved administrator and SQLite state");' >"$OUT/web-restart.log"
docker stop -t 60 "$REWARDS" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$REWARDS")" = 0
docker start "$REWARDS" >/dev/null
for ((i=0;i<30;i++)); do
    if docker exec "$REWARDS" rewards-healthcheck; then break; fi
    sleep 1
done
docker exec "$REWARDS" rewards-healthcheck
docker exec -u 1000:1000 "$REWARDS" node -e 'fetch("http://rewards:8090/snapshot",{headers:{authorization:"Bearer "+process.env.CONTROL_API_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
printf 'PASS: real amd64 rewards + non-root Web, Chromium UI, Compose, persistence, independent Web stop, rewards stop/restart\n' >"$OUT/result.txt"
