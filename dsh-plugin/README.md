# dsh-windows-paste-path (DSH 插件)

DSH Web 插件，把「复制文件/文件夹」的粘贴动作转换为纯文本绝对路径。

## 组成

- `lib/index.js` — **Host 半**（Node，随插件加载）。注册两条经
  `connection.fetch.register` 的路由，继承 Harness 的 Host/Origin 信任围栏与
  浏览器鉴权：
  - `GET /api/clipboard/paths`：读 `%LOCALAPPDATA%\DshClipboardHook\clipboard-paths.json`，
    校验每个条目（`kind`/`path` 合法、控制字符拒绝、mediaType 格式正则），再用
    `fs.stat` 做 **1.5s 预算、单条 400ms、并发 16** 的存在性复核（文件系统判定
    `kind` 优先于快照记录）。缺失/不可达/超时的一律丢弃。映射盘超时更宽一些。
  - `GET /api/clipboard/media-types`：把 `ctx.attachments.imageLimits.mediaTypes`
    透传给浏览器，作为「哪些图像类型被支持」的权威来源。
- `lib/client.js` — **Client 半**（浏览器，经 `window.__ModuleLoader__.load` 加载）。
  捕获阶段拦截 `paste`：文件/目录数据、`file://` HTML、或纯文本 Windows 绝对路径，
  且**不含受支持的图像**时，向 Host 取真实路径，用 `document.execCommand('insertText')`
  插入。不派发合成 `ClipboardEvent`，避免 Chromium 把系统剪贴板里的 HTML（含
  `&#x20;`）再贴一遍。

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

## 已知行为 / 边界

- **仅 Windows 生效**：`index.js` 在非 `win32` 平台返回 `supported:false`。
- **映射盘**：资源管理器复制 `Y:` 等网络盘时，浏览器经常没有 `File` 对象，只有
  `file://` HTML。Client 会识别这类粘贴，插入 Host 快照里的 `Y:\...` 原始路径。
- **Host 快照为准**：浏览器 `File` 列表会漏掉目录，条数可能和 Hook 不一致，因此
  不再用条数匹配来放弃拦截。
- **混合批次不拦截**：粘贴同时含受支持图像和路径时，整批交给 DSH 原生图像流程。
- **图像不转路径**：受支持的图像类型仍按图像粘贴。
- **陈旧路径**：不做新鲜度校验。Hook 退出后，若快照里的路径仍然存在，会照常插入。
- **容量上限**：状态文件最多 256 条、约 1MB；单路径 UTF-8 上限 32KB。
- **安全**：状态目录带显式 ACL；Host 严格校验路径；状态文件路径由 `LOCALAPPDATA`
  固定，路由不接受任意路径参数。

## 卸载

```bat
dsh plugin --profile web remove dsh-windows-paste-path
```

然后结束 Hook 进程。可选：删除 `%LOCALAPPDATA%\DshClipboardHook\`。
