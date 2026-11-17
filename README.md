# 小克音乐下载器 · Claude-Music-Downloader

<img src="icon.png" width="128" align="right" alt="icon">

[EchoMusic](https://github.com/hoowhoami/EchoMusic) 插件：现在可以下载当前在听的歌啦~
配合「小克音量均衡器」还可以下载音量均衡版哦！

## 功能

- 右键歌曲「下载歌曲」，或点播放栏的下载按钮
- 顶栏「下载队列」页面：查看进度、取消下载、查看 / 删除 / 清空下载记录、打开保存文件夹
- 音质可选（跟随播放 / 128 / 320 / FLAC / Hi-Res），不可用时自动降一级
- 文件命名：歌名 - 歌手（默认）/ 歌手 - 歌名 / 仅歌名
- 设置实时保存

## 账号安全

插件只调用和播放器本身相同的接口，尽量不给账号添麻烦：

- 下载正在播放的歌时直接复用播放地址，不额外请求
- 串行下载，每次请求之间随机间隔 3–5 秒
- 每首歌最多请求 2 次地址；遇到安全验证交给 EchoMusic 处理，只重试一次
- 每日上限（默认 150 首），队列最多 20 首，不提供整张歌单批量下载

再怎么小心也不能保证 100% 安全，请适度使用。

## 安装

要求 EchoMusic ≥ 2.3.2，需要有对应音质权限的酷狗账号。

1. 把本仓库放到 `%APPDATA%\echo-music\plugins\Claude-Music-Downloader\`
2. 「打开保存文件夹」和均衡版合并文件要用到 `bin\open-folder.exe`。它就是系统的 `cmd.exe`，版权属于微软，所以仓库里没有放。在 PowerShell 里运行下面的命令复制一份：

   ```powershell
   $d = "$env:APPDATA\echo-music\plugins\Claude-Music-Downloader\bin"; New-Item -ItemType Directory -Force $d | Out-Null; Copy-Item "$env:SystemRoot\System32\cmd.exe" "$d\open-folder.exe"
   ```

3. 重启 EchoMusic，在插件管理里启用。第一次打开文件夹时，EchoMusic 会问是否允许运行 `open-folder.exe`，点确认即可。

## 作者

- **Arqiu-owo**
- **Claude**（Anthropic）

## 许可证

- 代码：[LGPL-3.0](LICENSE)
- 图标 `icon.png`：CC BY-NC-SA 4.0
