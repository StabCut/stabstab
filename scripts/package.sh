#!/usr/bin/env bash
# ============================================================
# StabStab —— Ubuntu / Linux 一键打包脚本
# 在当前目录的上级（项目根目录）执行。产物输出至 release/：
#   1) stabstab-<版本>-amd64.deb          —— deb 安装包
#   2) StabStab-linux-x64.tar.gz      —— 便携目录（内含终端启动 .sh 脚本）
# 使用说明见项目 README.md。
# ============================================================
set -e
cd "$(dirname "$0")/.."

APP_NAME="StabStab"

echo "==> 检查 Node.js 环境"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js >= 18（推荐 20+）。"
  exit 1
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> 安装依赖（已存在则跳过）"
if [ ! -d node_modules/electron ]; then
  npm install --no-audit --no-fund
else
  echo "    node_modules 已存在，跳过安装"
fi

echo "==> 生成/更新 Logo（需要 ImageMagick，可跳过）"
if command -v convert >/dev/null 2>&1; then
  node scripts/gen-logo.js || echo "    Logo 生成失败，沿用现有图标"
else
  echo "    未检测到 ImageMagick（convert），跳过 Logo 生成，沿用现有图标"
fi

echo "==> 构建渲染进程（Vite）"
npm run build

echo "==> electron-builder 打包（deb + dir）"
npx electron-builder --linux deb dir

VER="$(node -p "require('./package.json').version")"
UNPACKED="release/linux-unpacked"

if [ ! -d "$UNPACKED" ]; then
  echo "错误：未生成 $UNPACKED"
  exit 1
fi

echo "==> 生成终端启动脚本 ${APP_NAME}.sh"
# electron-builder 生成的可执行文件名可能为 stabstab 或 ${APP_NAME}，启动时自动探测
cat > "$UNPACKED/${APP_NAME}.sh" <<'LAUNCHER'
#!/usr/bin/env bash
# StabStab 终端启动脚本：在解压目录内执行 ./StabStab.sh 即可运行
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for BIN in "stabstab" "StabStab"; do
  if [ -x "$DIR/$BIN" ]; then
    exec "$DIR/$BIN" "$@"
  fi
done
echo "未找到可执行文件（stabstab）" >&2
exit 1
LAUNCHER
chmod +x "$UNPACKED/${APP_NAME}.sh"

echo "==> 打包便携版 tar.gz"
TAR="release/${APP_NAME}-linux-x64.tar.gz"
rm -f "$TAR"
tar -czf "$TAR" -C release linux-unpacked

echo ""
echo "✅ 打包完成，产物："
ls -lh release/*.deb "$TAR" 2>/dev/null || true
echo ""
echo "使用方式："
echo "  [deb 安装]   sudo dpkg -i release/stabstab-${VER}-amd64.deb"
echo "  [便携运行]   解压 ${TAR}，进入 linux-unpacked 目录执行: ./${APP_NAME}.sh"
