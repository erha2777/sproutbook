; ===========================================================================
;  Sproutbook - 自定义 NSIS 安装脚本
; ===========================================================================
;
;  为什么要额外创建一个快捷方式：
;
;  在某些受限环境下（低完整性进程、受限作业对象、部分安全软件）Chromium 的进程
;  沙箱无法初始化，Electron 会在原生启动阶段直接崩溃（异常码 0x80000003），
;  双击普通快捷方式表现为「毫无反应」。
;
;  这种崩溃发生在应用代码之前，应用内部无法自救（已实测确认），
;  --no-sandbox 必须出现在命令行上。所以安装时额外放一个把该参数烘焙进参数里的
;  快捷方式，保证用户装完就有一个能用的入口。
;
;  不需要的用户直接删掉这个图标即可；它不会影响主程序的行为。
;
;  注意：本文件请保持纯 ASCII，避免 NSIS 在不同代码页下解析出错。
; ===========================================================================

!macro customInstall
  CreateShortCut "$DESKTOP\${PRODUCT_NAME} (compat).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME} (compat).lnk"
!macroend
