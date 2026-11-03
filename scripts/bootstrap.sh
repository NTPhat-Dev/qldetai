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
WEB_BIND=127.0.0.1
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
WEBAUTHN_RP_ID=$rp_host
WEBAUTHN_ORIGIN=$server_origin
EOF
  printf 'Da tao cau hinh .env voi khoa ngau nhien.\n'
fi
# Never rotate stored DB passwords or TOTP encryption keys on an existing installation.
for key in POSTGRES_PASSWORD TOTP_ENCRYPTION_KEY; do
  if ! grep -Eq "^${key}=.+" .env; then
    printf 'Cau hinh .env thieu %s. Khoi phuc cau hinh truoc khi khoi dong.\n' "$key" >&2
    exit 1
  fi
done
set_env_value() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
for service in IDENTITY ACADEMIC REGISTRATION GATEWAY; do
  private_name="INTERNAL_${service}_PRIVATE_KEY"
  public_name="INTERNAL_${service}_PUBLIC_KEY"
  if ! grep -Eq "^${private_name}=.+" .env || ! grep -Eq "^${public_name}=.+" .env; then
    private_pem="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
    public_pem="$(printf '%s\n' "$private_pem" | openssl pkey -pubout 2>/dev/null)"
    set_env_value "$private_name" "$(printf '%s\n' "$private_pem" | openssl base64 -A)"
    set_env_value "$public_name" "$(printf '%s\n' "$public_pem" | openssl base64 -A)"
    unset private_pem public_pem
  fi
done
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
web_bind="$(sed -n 's/^WEB_BIND=//p' .env | tail -n 1 | tr -d '\r')"
printf '\nWeb cuc bo: http://localhost:%s\nQuan tri: http://localhost:%s/admin\n' "${web_port:-5173}" "${web_port:-5173}"
if [[ "${web_bind:-127.0.0.1}" != '127.0.0.1' && "${web_bind:-127.0.0.1}" != '::1' ]]; then
  printf 'WEB_BIND dang mo cho mang. Chi cho phep truy cap tu xa qua HTTPS va chan truy cap HTTP truc tiep bang firewall.\n'
else
  printf 'Truy cap tu dien thoai/may khac can reverse proxy HTTPS va ten mien hop le.\n'
fi
