# ============================================================================
# StabStab 安装器自定义片段（electron-builder 的 nsis.include → build/installer.nsh）
#
# 为什么需要它：NSIS「覆盖安装」时会先调用旧版卸载器，而旧版卸载器里有 `RMDir /r $INSTDIR`
# （见 node_modules/app-builder-lib/templates/nsis/uninstaller.nsh）。本功能之前的版本把数据
# 放在 exe 同级，也就是 $INSTDIR\stabstab-data —— 不在卸载器动手之前搬走，就一定会被删干净。
# 新版已把数据改到用户目录（electron/src/paths.js：<userData>\stabstab-data，Windows 即
# %APPDATA%\StabStab\stabstab-data），所以这里只要把旧数据拷到那个位置，新版启动即可读到。
#
# 时机：customInit 在 .onInit 里、initMultiUser 之后、安装段（installSection.nsh 的
# uninstallOldVersion）之前执行 —— 那时 $INSTDIR 还是「上一次的安装目录」，数据也还在。
# 用 customInstall 就太晚了：旧卸载器已经把 $INSTDIR 删掉了。
#
# 兜底：这里即便失败也不影响安装；新版首次启动还会自己做一次旧数据迁移（paths.js
# 的 migrateLegacyData，只拷不删），两道保险。
# ============================================================================

# Electron 的 userData 目录名取自 package.json 的 productName。electron-builder 只在
# APP_FILENAME 与 productName 不同时才定义 APP_PRODUCT_FILENAME，这里兜一下底。
!ifndef APP_PRODUCT_FILENAME
  !define APP_PRODUCT_FILENAME "${APP_FILENAME}"
!endif

!macro customInit
  # 旧版数据：exe 同级 stabstab-data（有配置文件才算数，空目录不碰）
  ${if} ${FileExists} "$INSTDIR\stabstab-data\settings.json"
  ${orIf} ${FileExists} "$INSTDIR\stabstab-data\conversations.json"

    # 新位置已经有配置就什么都不做 —— 绝不拿旧数据盖掉新数据
    ${ifNot} ${FileExists} "$APPDATA\${APP_PRODUCT_FILENAME}\stabstab-data\settings.json"
    ${andIfNot} ${FileExists} "$APPDATA\${APP_PRODUCT_FILENAME}\stabstab-data\conversations.json"

      # electron 用的是「当前用户」的 AppData；per-machine 安装时 $APPDATA 指向 ProgramData，先切回来
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}

      DetailPrint "StabStab: 正在迁移旧版数据（含历史图片，可能较慢，请稍候）…"
      DetailPrint "  $INSTDIR\stabstab-data → $APPDATA\${APP_PRODUCT_FILENAME}\stabstab-data"
      nsExec::ExecToLog '"$SYSDIR\xcopy.exe" /E /I /Q /Y /H "$INSTDIR\stabstab-data" "$APPDATA\${APP_PRODUCT_FILENAME}\stabstab-data"'
      Pop $0
      ${if} $0 != 0
        DetailPrint "StabStab: 数据迁移返回码 $0（安装继续；应用首次启动会再尝试迁移）"
      ${else}
        DetailPrint "StabStab: 旧版数据已迁移到 $APPDATA\${APP_PRODUCT_FILENAME}\stabstab-data"
      ${endif}

      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}

    ${endif}
  ${endif}
!macroend
