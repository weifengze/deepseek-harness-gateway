#!/usr/bin/env bash
# Linux 预检：只读检查，不安装、不修改任何东西。
# 用法： bash linux-preflight.sh
# 目的：在真正部署 dsh-api-gateway 之前，确认这台机器能不能跑。

set -u
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "1. 系统"
printf '  %s\n' "$(uname -srm)"
if [ -r /etc/os-release ]; then . /etc/os-release; printf '  %s %s\n' "$PRETTY_NAME" "$VERSION_ID"; fi
printf '  CPU=%s  MEM=%s\n' "$(nproc)" "$(free -h 2>/dev/null | awk '/^Mem:/{print $2}')"
printf '  DISK(/) %s\n' "$(df -h / | awk 'NR==2{print $4" 可用 / "$2" 总"}')"

head_ "2. Node（要求 >= 22.19）"
if command -v node >/dev/null 2>&1; then
  NV="$(node -v)"; printf '  node %s\n' "$NV"
  MAJ="$(printf '%s' "$NV" | sed 's/^v//' | cut -d. -f1)"
  MIN="$(printf '%s' "$NV" | sed 's/^v//' | cut -d. -f2)"
  if [ "$MAJ" -gt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 19 ]; }; then
    ok "版本满足（网关与 dsh 都要求 >=22.19）"
  else
    bad "版本过低，需要 Node 22.19+ 或 24+"
  fi
  node -e 'console.log("  fetch:", typeof fetch, "| WebSocket:", typeof WebSocket)' 2>/dev/null || true
else
  bad "未安装 node"
fi
command -v npm  >/dev/null 2>&1 && printf '  npm %s\n' "$(npm -v)"  || warn "未安装 npm"
command -v pnpm >/dev/null 2>&1 && printf '  pnpm %s\n' "$(pnpm -v)" || warn "未安装 pnpm（安装 dsh 插件时需要）"

head_ "3. 沙箱前提（DSH 的 bash / 写文件工具靠它）"
# 3.1 bubblewrap
if command -v bwrap >/dev/null 2>&1; then
  printf '  bwrap %s\n' "$(bwrap --version 2>/dev/null)"
  if bwrap --ro-bind / / --dev /dev --proc /proc true 2>/dev/null; then
    ok "bwrap 可用"
  else
    bad "bwrap 存在但无法建立只读沙箱（多半是 user namespace 被禁用）"
  fi
else
  warn "未安装 bubblewrap（Ubuntu 上 apt install bubblewrap）"
fi

# 3.2 Ubuntu 23.10+ 对非特权 user namespace 的 AppArmor 限制
if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  V="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
  if [ "$V" = "1" ]; then
    warn "apparmor_restrict_unprivileged_userns=1：bwrap 可能被拦，需要给 bwrap 加 AppArmor profile 或临时置 0"
  else
    ok "未限制非特权 userns"
  fi
fi
if [ -r /proc/sys/user/max_user_namespaces ]; then
  printf '  max_user_namespaces=%s\n' "$(cat /proc/sys/user/max_user_namespaces)"
fi

# 3.3 Landlock（bwrap 不可用时的第二道保险）
if [ -r /sys/kernel/security/lsm ]; then
  if grep -q landlock /sys/kernel/security/lsm; then ok "内核已启用 Landlock"; else warn "内核未启用 Landlock"; fi
else
  warn "读不到 /sys/kernel/security/lsm（securityfs 未挂载或容器限制）"
fi

head_ "4. 端口"
for P in 8787 3080; do
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$P\$"; then warn "$P 已被占用"; else ok "$P 空闲"; fi
  fi
done

head_ "5. 部署目标目录"
for D in /srv/dsh /srv/dsh/tenants; do
  if [ -d "$D" ]; then
    printf '  %s -> %s\n' "$D" "$(stat -c '%U:%G %a' "$D" 2>/dev/null)"
  else
    warn "$D 不存在（部署时要创建）"
  fi
done
printf '  当前用户 %s (uid=%s)\n' "$(id -un)" "$(id -u)"

head_ "6. 已有安装"
command -v dsh >/dev/null 2>&1 && printf '  dsh %s\n' "$(command -v dsh)" || warn "未安装 dsh"
[ -d "$HOME/.dsh" ] && printf '  ~/.dsh 存在：%s\n' "$(ls "$HOME/.dsh" | tr '\n' ' ')" || warn "~/.dsh 不存在（尚未初始化）"
command -v nginx >/dev/null 2>&1 && printf '  nginx %s\n' "$(nginx -v 2>&1)" || warn "未安装 nginx"

printf '\n完成。把整段输出贴回来即可。\n'
