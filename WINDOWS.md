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

## 2. 做出第一段透明动效

1. 在准备页点「选择 SRT 文件」，打开 `release-demo/demo.srt`。保持 9:16，选「选择 JSON 文件」打开同目录的 `demo-candidate.json`，再点「应用到时间轴」。
2. 在左侧选中章节条，参数面板的「章节表」改为 `安排动效 0 | 画布微调 3`，按 Enter。在时间轴点「循环所选时段」，可以反复看两段标题如何切换，点「退出循环」继续。
3. 点「导出编排 JSON」保留手调版本。回到准备页后，「恢复上次草稿」可取回本机保存的编排。
4. 点「导出透明 MOV」，选 720p、24 fps，再点「开始导出」。打开成品目录。
5. 在剪映新建 9:16 项目，把包里的 `release-demo/voice-demo.mp4` 放在主轨，将刚导出的 MOV 放到它上方，两条素材的开始对齐。开头应同时看见米色原片和「安排动效」标题，3 秒后进入「画布微调」。

底片使用本项目制作的示意画面和合成中文旁白。源视频只在合成时放到主轨，透明 MOV 单独保存动效层。

如果下载 Chrome 遇到网络问题且本机有可用的 Edge，可以在同一个 PowerShell 窗口临时指定 Edge。若 `npm.cmd ci` 因下载浏览器失败，先执行 `$env:PUPPETEER_SKIP_DOWNLOAD = 'true'`，重新运行 `npm.cmd ci`，再从项目根目录执行下面两行。请换成自己的实际 Edge 安装路径。

```powershell
$env:PUPPETEER_EXECUTABLE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
Start-Process .\motion-playground\desktop\bin\K-Overlay-Studio.exe
```

## 换自己的 Agent 试一遍

回到[首页的 Agent 示例](README.md#让自己的-agent-配卡)，复制指令即可生成另一份编排。
