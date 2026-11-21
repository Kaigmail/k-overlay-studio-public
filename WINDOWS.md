# Windows 预览版快速开始

## 1. 解压和安装依赖

完整解压 Windows x64 ZIP 到有写权限的英文路径，例如 `D:\KOverlayDemo`。保留目录结构。Windows 预览包提供编译好的桌面启动器。

本机需要 64 位 Windows、.NET Framework 4.6.2 或更新版本、[WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)、[Node.js](https://nodejs.org/)（22.12 或以上）以及带有 `ffmpeg` 和 `ffprobe` 的 [FFmpeg](https://ffmpeg.org/download.html)。

在解压出来的项目根目录打开 PowerShell，依次执行。首次安装依赖和下载渲染浏览器需要联网。

```powershell
node --version
ffmpeg -version
ffprobe -version
node extra/restore-assets.mjs
cd motion-playground
npm.cmd ci
npx.cmd puppeteer browsers install chrome
```

双击 `motion-playground\desktop\bin\K-Overlay-Studio.exe` 启动编辑台。导出需要可写的成品目录和充足的磁盘空间。中文字体由本机提供，推荐安装思源黑体。

## 2. 从字幕试一遍

1. 在准备页点「选择 SRT 文件」，打开 `release-demo\demo.srt`，保持竖屏 9:16。
2. 点「复制给 Agent」，把指令交给能读取本机文件的 Codex、Claude Code 等 Agent。等它按指令写出候选 JSON，点「读取编排结果」，再点「应用到时间轴」。也可以点「选择 JSON 文件」，打开随包提供的 `release-demo\demo-candidate.json` 直接试用。
3. 在时间轴选择一张卡，拖动画布里的卡片。点「导出编排 JSON」可以保存手调后的编排。
4. 点「导出透明动效」，选 `720p · 24 fps` 后点「开始导出」。默认成品目录是字幕所在目录。完成后取用界面显示的透明 MOV，透明 WebM 会随同生成。

桌面版在本机渲染。接受 Agent 指令的服务如何处理字幕，取决于你选择的 Agent。字幕演示不需要源视频。

如果下载 Chrome 遇到网络问题且本机有可用的 Edge，可以在同一个 PowerShell 窗口临时指定 Edge。若 `npm.cmd ci` 因下载浏览器失败，先执行 `$env:PUPPETEER_SKIP_DOWNLOAD = 'true'`，重新运行 `npm.cmd ci`，再从项目根目录执行下面两行。请换成自己的实际 Edge 安装路径。

```powershell
$env:PUPPETEER_EXECUTABLE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
Start-Process .\motion-playground\desktop\bin\K-Overlay-Studio.exe
```
