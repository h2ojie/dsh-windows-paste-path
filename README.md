# DSH Windows Paste-Path

让 DSH Web 在 Windows 上支持「复制文件/文件夹 → 粘贴为绝对路径」。

在资源管理器里复制文件或文件夹后，到 DSH Web 输入框 `Ctrl+V`，会插入一行一个原始绝对路径：

```
C:\work\demo\report.pdf
C:\work\demo\images
Y:\share\logs\dmesg.log
```

目录和文件都支持；多条以换行分隔。受支持的图片仍按图片粘贴。映射盘（`Y:` 这类网络盘）也走同一套路径，不会把 `file://` HTML 或 `&#x20;` 插进输入框。

## 组成

```
dsh-windows-paste-path/
├── README.md
├── LICENSE
├── windows-clipboard-hook/          # 剪贴板 Hook
│   ├── dsh_clipboard_hook.py        # Python 实现（推荐，无需编译）
│   ├── CMakeLists.txt               # 可选 C++ 实现
│   └── src/
└── dsh-plugin/                      # DSH Web 插件
    ├── package.json
    ├── cordis.patch.yml
    └── lib/
        ├── index.js                 # Host 半：/api/clipboard/paths
        └── client.js                # Client 半：拦截 paste，插入纯文本路径
```

- Hook：监听 `WM_CLIPBOARDUPDATE`，把 `CF_HDROP` 快照写到 `%LOCALAPPDATA%\DshClipboardHook\clipboard-paths.json`。
- Host 半：读快照，校验路径，再 `fs.stat` 复核（默认 1.5s 预算，兼顾映射盘）。
- Client 半：捕获阶段拦截文件/目录粘贴，向 Host 取路径，用 `insertText` 插入纯文本。不派发合成 `ClipboardEvent`，避免 Chromium 把系统剪贴板里的 `file://` HTML 再贴一遍。

## 安装

需要：Windows、Python 3.8+、已安装的 `dsh`。

```bat
git clone https://github.com/h2ojie/dsh-windows-paste-path.git
cd dsh-windows-paste-path

REM 1) 常驻 Hook（保持窗口开着，或改用 pythonw / 开机启动）
python windows-clipboard-hook\dsh_clipboard_hook.py

REM 2) 把插件链进 web profile（另开一个终端）
dsh plugin --profile web add link:%CD%\dsh-plugin
```

然后**重启 DSH Web**，浏览器里对 DSH 页面硬刷新一次（`Ctrl+F5`）。

开发期用 `link:`，改 `dsh-plugin/lib/client.js` 后硬刷新即可；Host 半 `index.js` 改完需要重启 `dsh web`。

## 使用

1. 确认 Hook 进程在跑。
2. 在资源管理器复制文件或文件夹（本地盘或映射盘都可以）。
3. 焦点放在 DSH 输入框，`Ctrl+V`。
4. 输入框出现绝对路径；图片文件仍按图片附件处理。

## 卸载

```bat
dsh plugin --profile web remove dsh-windows-paste-path
```

结束 `dsh_clipboard_hook.py` 进程。可选：删除 `%LOCALAPPDATA%\DshClipboardHook\`。

## 文档

- Hook 运行 / C++ 编译：`windows-clipboard-hook/README.md`
- 插件安装与行为边界：`dsh-plugin/README.md`
