# dsh-windows-paste-path (DSH 插件)

DSH Web 插件，把「复制文件/文件夹」的粘贴动作转换为纯文本绝对路径。

## 组成

- `lib/index.js` — **Host 半**（Node，随插件加载）。注册两条经
  `connection.fetch.register` 的路由，继承 Harness 的 Host/Origin 信任围栏与
  浏览器鉴权：
  - `GET /api/clipboard/paths`：读 `%LOCALAPPDATA%\DshClipboardHook\clipboard-paths.json`，
    校验每个条目（`kind`/`path` 合法、控制字符拒绝、mediaType 格式正则），然后直接
    返回 Hook 已分类的快照。Host 不再重复 `fs.stat`，避免映射盘/UNC 路径让每次粘贴
    再产生一轮网络文件系统等待。
  - `GET /api/clipboard/media-types`：把 `ctx.attachments.imageLimits.mediaTypes`
    透传给浏览器，作为「哪些图像类型被支持」的权威来源。
- `lib/client.js` — **Client 半**（浏览器，经 `window.__ModuleLoader__.load` 加载）。只监听输入框的 Alt+V，从 Hook/Host 快照读取路径，再用 `document.execCommand('insertText')` 插入。没有 paste 监听，不读取浏览器剪贴板、不拦截 Ctrl+V，也不查询图像类型。Ctrl+V 的支持范围和错误提示完全由 DSH 原生逻辑决定。

> 两份入口声明：
> - `exports["./client"]` + `dsh.client: { platform: "web", immediately: true }`
> - `dsh.bundle: { patch: "./cordis.patch.yml" }` —— `dsh plugin add` 会把 Host 半
>   登记为 profile 的 bundle 层。`ctx.effect` 必须返回 disposer（`() => () => cleanup`），
>   否则 paste 监听会在加载当下被卸掉。

## 安装（开发/本地）

1. 运行剪贴板 Hook（见 `../windows-clipboard-hook/README.md`，推荐 Python 版）。
2. 把本目录加入 `web` profile：

   ```bat
   dsh plugin --profile web add link:%CD%\dsh-plugin
   ```

   或绝对路径：

   ```bat
   dsh plugin --profile web add link:C:\path\to\dsh-windows-paste-path\dsh-plugin
   ```

3. **重启 DSH Web**，然后硬刷新页面（`Ctrl+F5`）。首次加入 bundle 层必须重启；
   之后改 `client.js` 硬刷新即可，改 `index.js` 仍需重启 profile。

## 网络文件夹安全粘贴：Alt+V

在资源管理器复制文件/文件夹后，把焦点放到 DSH 消息输入框，按 **Alt+V**。插件直接读取 Hook 路径快照，不调用浏览器剪贴板 API，也不触发原生 paste；UNC / 映射盘文件夹优先使用此方式。普通 Ctrl+V 保持原行为，文字和截图照常粘贴。Alt+V 是显式的路径操作，图片文件也只插入路径。

Hook 必须正在运行。快捷键使用最后写出的快照，不保证它与当前系统剪贴板同步；Hook 停止或忙于网络路径分类时可能得到旧路径或空结果。插入后请核对路径。空结果或接口失败不插入，也不会回退到可能卡住的原生粘贴。等待期间焦点离开原输入框或插件卸载，会放弃插入。

Client 的 `lib/client.js` 就是直接发布的入口，无需额外编译。本次仅改 Client，刷新当前 DSH 页面加载新版即可，不需要重启服务。

## 已知行为 / 边界

- **仅 Windows 生效**：`index.js` 在非 `win32` 平台返回 `supported:false`。
- **Ctrl+V 完全原生**：插件对文字、图片、文件、目录和混合批次均不介入。DSH 已有不支持文件格式的提示；若浏览器不给出可处理的文件对象，或在发出 paste 事件前卡住，则不保证出现提示。
- **映射盘 / UNC**：Chromium 可能在原生粘贴期间处理网络文件夹而卡住。需要路径时由用户主动按 Alt+V，插件不会自动回退或替换 Ctrl+V。
- **Alt+V 以 Host 快照为准**：不接触浏览器 File 列表，图片文件也会作为路径文本插入。
- **陈旧路径**：不做新鲜度校验。Hook 退出后，若快照里的路径仍然存在，会照常插入。
- **容量上限**：状态文件最多 256 条、约 1MB；单路径 UTF-8 上限 32KB。
- **安全**：状态目录带显式 ACL；Host 严格校验路径；状态文件路径由 `LOCALAPPDATA`
  固定，路由不接受任意路径参数。

## 卸载

```bat
dsh plugin --profile web remove dsh-windows-paste-path
```

然后结束 Hook 进程。可选：删除 `%LOCALAPPDATA%\DshClipboardHook\`。
