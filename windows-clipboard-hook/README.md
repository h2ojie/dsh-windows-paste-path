# DshClipboardHook

Win32 剪贴板监听器，为 DSH 插件提供「当前复制了哪些文件/文件夹」的快照。

## 两种实现

| 实现 | 文件 | 编译 | 状态 |
| --- | --- | --- | --- |
| **Python（推荐，无需编译）** | `dsh_clipboard_hook.py` | 无需，标准库 `ctypes` | 已实机验证 |
| C++（可选） | `src/*.cpp` + `CMakeLists.txt` | 需 Visual Studio 2022 + CMake | 未在本机编译 |

两者行为完全一致：监听 `WM_CLIPBOARDUPDATE` → 在剪贴板锁内只复制 `CF_HDROP`
路径字符串 → **立即释放剪贴板锁** → 文件/目录分类 → 写 JSON 快照到
`%LOCALAPPDATA%\DshClipboardHook\clipboard-paths.json`（带显式 ACL 的目录 + 原子替换）。
把可能阻塞的网络路径属性查询放到锁外，避免一条失联 UNC/映射盘路径卡住整个系统的粘贴。
没有 C++ 编译环境时直接用 Python 版即可。

---

## Python 版（推荐）

### 运行

仅需 Windows 上的 Python 3.8+（标准库自带 `ctypes`，**无第三方依赖**）：

```bat
python dsh_clipboard_hook.py
```

- 它是一个**常驻进程**：创建仅消息窗口、注册 `WM_CLIPBOARDUPDATE`、进入消息泵。
- 想开机静默运行、不弹控制台窗口：把文件改名为 `dsh_clipboard_hook.pyw`，
  或在「启动」文件夹放一个快捷方式指向 `pythonw dsh_clipboard_hook.pyw`。
- 命名 Mutex `Local\DshClipboardHook.SingleInstance` 保证单实例；重复启动直接退出。
- 关机时 `WM_QUERYENDSESSION` 正常退出，清理监听器与 Mutex。

### 验证情况

- `python -m py_compile dsh_clipboard_hook.py` 通过。
- 纯逻辑单元测试通过：mediaType 图像 hint 映射、JSON 快照构建、条目数 256 上限、
  控制字符/坏 mediaType 拒绝、空快照清空。
- **实机往返测试通过**：用代码向剪贴板写入真实 `CF_HDROP`（一个文件 + 一个目录），
  调用 `refresh_clipboard_paths`，确认 `DragQueryFileW` 枚举、`GetFileAttributesW`
  分类、`MoveFileExW` 原子写快照全部正确（文件→`file`、目录→`directory`）。
- 未自动覆盖的仅剩 `WM_CLIPBOARDUPDATE` 经消息泵投递这一环（标准 `GetMessageW`
  循环，已验证窗口类/窗口/监听器均可正常初始化）。

---

## C++ 版（可选，需要 MSVC）

仅当想得到一个独立 `.exe`（无需装 Python）时采用。

```bat
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

产物：`build\bin\Release\DshClipboardHook.exe`（静态运行时 `/MT`，无需 VC Redist）。

> 本机无 MSVC/CMake，**C++ 版未编译验证**，编译需在你装有 Visual Studio 2022 的
> Windows 上完成。逻辑与 Python 版一一对应。

---

## 状态文件 schema（两种实现相同）

```json
{
  "version": 1,
  "truncated": false,
  "items": [
    { "kind": "file", "path": "C:\\work\\a.pdf", "mediaType": "image/jpeg" },
    { "kind": "directory", "path": "C:\\work\\images" }
  ]
}
```

- `kind`：`"file"` 或 `"directory"`。
- `path`：Windows 报告的原始绝对路径（含反斜杠、UNC 前缀均原样保留）。
- `mediaType`：仅对图片文件给出 hint，且**仅供参考**，最终以 DSH 的
  `attachments.imageLimits.mediaTypes` 为准；缺省表示未知。
- `truncated`：条目数或体积超限时被截断。

## 运维要点

- **剪贴板锁必须尽快释放**：`refresh_clipboard_paths` 在锁内只复制 `CF_HDROP`
  路径，并用 `try/finally` 保证 `CloseClipboard` 一定执行；`GetFileAttributesW`
  分类严格在锁外进行。否则失联网络路径可能让本进程长期占锁，卡住整桌所有粘贴。
- 非文件类复制（纯文本、图像等）会**清空**快照，避免后续粘贴插入陈旧路径。
- 状态目录用显式 SDDL ACL 创建（`D:PAI` + `BA/SY/CO`），避免继承到父目录可能过宽
  的权限而泄露路径。
- 状态文件路径由 `LOCALAPPDATA` 固定决定，不可配置，避免被请求诱导去读取任意位置。

## 卸载

1. 结束进程 `dsh_clipboard_hook.py` / `DshClipboardHook.exe`（任务管理器，或注销/关机）。
2. 删除启动项快捷方式（如有）。
3. 可选：删除状态目录 `%LOCALAPPDATA%\DshClipboardHook\`。
