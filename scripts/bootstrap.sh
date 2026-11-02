#!/usr/bin/env bash
# Ubuntu/Linux server entry point. Existing database volumes are never removed.
set -euo pipefail
umask 077
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

for dependency in docker openssl; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'Thieu %s. Cai Docker Engine/Compose va OpenSSL truoc khi chay.\n' "$dependency" >&2
    exit 1
  fi
done
docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    docker_command=(sudo docker)
  else
    printf 'Chua ket noi duoc Docker. Kiem tra: sudo systemctl start docker\n' >&2
    exit 1
  fi
fi
"${docker_command[@]}" compose version >/dev/null

if [[ ! -f .env ]]; then
  server_origin="${APP_ORIGIN:-http://localhost:5173}"
  if [[ ! "$server_origin" =~ ^https?://[a-zA-Z0-9.:-]+$ ]]; then
    printf 'APP_ORIGIN phai la dia chi http(s) hop le, khong co duong dan.\n' >&2
    exit 1
  fi
  rp_host="${server_origin#*://}"
  rp_host="${rp_host%%:*}"
  cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
WEB_PORT=5173
JWT_SECRET=$(openssl rand -hex 48)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
INTERNAL_SERVICE_SECRET=$(openssl rand -hex 48)
WEBAUTHN_RP_ID=$rp_host
WEBAUTHN_ORIGIN=$server_origin
EOF
  printf 'Da tao cau hinh .env voi khoa ngau nhien.\n'
fi
# Never rotate stored DB passwords or TOTP encryption keys on an existing installation.
for key in POSTGRES_PASSWORD JWT_SECRET TOTP_ENCRYPTION_KEY; do
  if ! grep -Eq "^${key}=.+" .env; then
    printf 'Cau hinh .env thieu %s. Khoi phuc cau hinh truoc khi khoi dong.\n' "$key" >&2
    exit 1
  fi
done
if ! grep -Eq '^INTERNAL_SERVICE_SECRET=.+' .env; then
  printf '\nINTERNAL_SERVICE_SECRET=%s\n' "$(openssl rand -hex 48)" >> .env
fi
chmod 600 .env

printf 'Dang dung va khoi dong cac dich vu...\n'
"${docker_command[@]}" compose --profile soa up -d --build --wait --wait-timeout 180

temporary_password="$(openssl rand -hex 16)"
admin_result="$(printf '{"username":"admin.demo","name":"Quan tri vien","temporaryPassword":"%s"}\n' "$temporary_password" |
  "${docker_command[@]}" compose --profile soa exec -T identity-service node scripts/create-admin.js)"
if [[ "$admin_result" == *'"created":true'* ]]; then
  printf '\nTai khoan quan tri: admin.demo\nMat khau tam (chi hien lan nay): %s\n' "$temporary_password"
  printf 'Luu mat khau va doi ngay khi dang nhap lan dau.\n'
else
  printf 'Da co tai khoan quan tri; giu nguyen tai khoan va du lieu.\n'
fi
unset temporary_password admin_result
web_port="$(sed -n 's/^WEB_PORT=//p' .env | tail -n 1 | tr -d '\r')"
printf '\nWeb: http://<IP-server>:%s\nQuan tri: http://<IP-server>:%s/admin\n' "${web_port:-5173}" "${web_port:-5173}"
printf 'Qua NAT VirtualBox: dung IP may Windows va Host Port da cau hinh (vi du 5174).\n'
