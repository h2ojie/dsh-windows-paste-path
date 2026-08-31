# DshClipboardHook — Python implementation (no C++ toolchain required).
#
# Equivalent of the C++ hook in src/, written with ctypes so it runs on stock
# Python for Windows with zero third-party dependencies.
#
# It opens a message-only window, listens for WM_CLIPBOARDUPDATE, enumerates the
# CF_HDROP payload, classifies each entry as file/directory, and persists a JSON
# snapshot under %LOCALAPPDATA%\DshClipboardHook\clipboard-paths.json.
#
# The snapshot schema MUST stay in sync with dsh-plugin/lib/index.js
# (validateItem / readStateFile).

import ctypes
import json
import os
import re
import sys
import time

from ctypes import wintypes

# ---------------------------------------------------------------------------
# Win32 constants
# ---------------------------------------------------------------------------
CF_HDROP = 15
WM_CLIPBOARDUPDATE = 0x031D
WM_DESTROY = 0x0002
WM_QUERYENDSESSION = 0x0011

INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF
FILE_ATTRIBUTE_DIRECTORY = 0x10

ERROR_ALREADY_EXISTS = 183
ERROR_CLASS_ALREADY_EXISTS = 1410

MOVEFILE_REPLACE_EXISTING = 0x1
MOVEFILE_WRITE_THROUGH = 0x2

# Serialization caps (mirror the C++ kMax* constants).
MAX_ITEMS = 256
MAX_PATH_UTF8_BYTES = 32 * 1024
MAX_MEDIA_TYPE_CHARS = 128
MAX_ENCODED_BYTES = 1024 * 1024

MEDIA_TYPE_RE = re.compile(
    r'^[A-Za-z0-9!#$&^_.+-]{1,64}/[A-Za-z0-9!#$&^_.+-]{1,64}$'
)

# Extension -> media-type hint. Only image types are enumerated; anything absent
# is already treated as unsupported, so listing archives or documents would add
# maintenance cost without changing behaviour. DSH makes the final decision
# against its own imageLimits.mediaTypes.
EXTENSION_HINTS = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
    '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon',
}

# Explicit security descriptor for the state directory. D:PAI protects against
# inheriting a permissive parent ACE; BA/SY/CO get full control.
DIRECTORY_SDDL = (
    "D:PAI"
    "(A;OICI;FA;;;BA)"   # BUILTIN\Administrators: full control
    "(A;OICI;FA;;;SY)"   # SYSTEM: full control
    "(A;OICI;FA;;;CO)"   # CREATOR OWNER: full control (resolves to the user)
)


# ---------------------------------------------------------------------------
# ctypes bindings
# ---------------------------------------------------------------------------
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
shell32 = ctypes.windll.shell32
advapi32 = ctypes.windll.advapi32

WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", POINT),
    ]


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HANDLE),
        ("hIcon", wintypes.HANDLE),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HANDLE),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HANDLE),
    ]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", wintypes.LPVOID),
        ("bInheritHandle", wintypes.BOOL),
    ]


user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.RegisterClassExW.restype = wintypes.ATOM

user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND

user32.DefWindowProcW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
]
user32.DefWindowProcW.restype = ctypes.c_longlong

user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.DestroyWindow.restype = wintypes.BOOL

user32.AddClipboardFormatListener.argtypes = [wintypes.HWND]
user32.AddClipboardFormatListener.restype = wintypes.BOOL

user32.RemoveClipboardFormatListener.argtypes = [wintypes.HWND]
user32.RemoveClipboardFormatListener.restype = wintypes.BOOL

user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL

user32.CloseClipboard.argtypes = []
user32.CloseClipboard.restype = wintypes.BOOL

user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
user32.IsClipboardFormatAvailable.restype = wintypes.BOOL

user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE

user32.GetMessageW.argtypes = [
    ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT
]
user32.GetMessageW.restype = ctypes.c_long

user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
user32.TranslateMessage.restype = wintypes.BOOL

user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
user32.DispatchMessageW.restype = ctypes.c_longlong

user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.PostQuitMessage.restype = None

user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
user32.MessageBoxW.restype = ctypes.c_int

kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.CreateMutexW.restype = wintypes.HANDLE

kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

kernel32.GetLastError.argtypes = []
kernel32.GetLastError.restype = wintypes.DWORD

kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HANDLE

kernel32.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(SECURITY_ATTRIBUTES)]
kernel32.CreateDirectoryW.restype = wintypes.BOOL

kernel32.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
kernel32.GetFileAttributesW.restype = wintypes.DWORD

kernel32.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
kernel32.MoveFileExW.restype = wintypes.BOOL

shell32.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPWSTR, wintypes.UINT]
shell32.DragQueryFileW.restype = wintypes.UINT

advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
    wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.DWORD)
]
advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL

kernel32.LocalFree.argtypes = [wintypes.LPVOID]
kernel32.LocalFree.restype = wintypes.LPVOID


# ---------------------------------------------------------------------------
# State file
# ---------------------------------------------------------------------------
def state_file_path():
    """Resolve %LOCALAPPDATA%\\DshClipboardHook\\clipboard-paths.json."""
    local_app_data = os.environ.get('LOCALAPPDATA')
    if not local_app_data:
        return None
    return os.path.join(local_app_data, 'DshClipboardHook', 'clipboard-paths.json')


def create_directory_with_acl(path):
    """Create one directory level with an explicit security descriptor.

    Returns True when the directory now exists (created or already present).
    """
    sd_ptr = wintypes.LPVOID()
    sd_size = wintypes.DWORD()
    sa = None
    if advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            DIRECTORY_SDDL, 1, ctypes.byref(sd_ptr), ctypes.byref(sd_size)
    ):
        sa = SECURITY_ATTRIBUTES()
        sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
        sa.bInheritHandle = False
        sa.lpSecurityDescriptor = sd_ptr
    try:
        created = kernel32.CreateDirectoryW(path, ctypes.byref(sa) if sa else None)
        error = kernel32.GetLastError()
        return created or error == ERROR_ALREADY_EXISTS
    finally:
        if sa is not None and sd_ptr:
            kernel32.LocalFree(sd_ptr)


def build_snapshot_json(items):
    """Serialize entries, honouring the item-count and size caps."""
    out = []
    truncated = False
    for item in items:
        if len(out) >= MAX_ITEMS:
            truncated = True
            break
        path = item['path']
        if not path or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in path):
            truncated = True
            continue
        if len(path.encode('utf-8')) > MAX_PATH_UTF8_BYTES:
            truncated = True
            continue

        media_type = item.get('mediaType')
        if media_type:
            if len(media_type) > MAX_MEDIA_TYPE_CHARS or not MEDIA_TYPE_RE.match(media_type):
                media_type = None
                truncated = True

        entry = {'kind': item['kind'], 'path': path}
        if media_type:
            entry['mediaType'] = media_type.lower()
        out.append(entry)

    doc = {'version': 1, 'truncated': truncated, 'items': out}
    data = json.dumps(doc, ensure_ascii=False)
    # Enforce the total-size cap: drop only trailing items, never below the
    # item-count cap. An absurd clipboard must not produce an empty file.
    if len(data.encode('utf-8')) > MAX_ENCODED_BYTES:
        while len(out) > MAX_ITEMS and len(json.dumps(
                {'version': 1, 'truncated': True, 'items': out},
                ensure_ascii=False).encode('utf-8')) > MAX_ENCODED_BYTES:
            out.pop()
        doc = {'version': 1, 'truncated': True, 'items': out}
        data = json.dumps(doc, ensure_ascii=False)
    return data


def write_state_file(items):
    """Write the snapshot atomically (tmp file + atomic replace)."""
    target = state_file_path()
    if not target:
        return False
    directory = os.path.dirname(target)
    if not create_directory_with_acl(directory):
        return False

    data = build_snapshot_json(items)
    temporary = target + '.tmp'
    try:
        with open(temporary, 'w', encoding='utf-8') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if not kernel32.MoveFileExW(
                temporary, target, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
        ):
            return False
        return True
    finally:
        if os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Clipboard monitoring
# ---------------------------------------------------------------------------
_refresh_in_progress = False


def media_type_for_path(path):
    dot = path.rfind('.')
    if dot < 0:
        return None
    return EXTENSION_HINTS.get(path[dot:].lower())


def collect_entries(hdrop):
    """Enumerate CF_HDROP and classify each entry."""
    count = shell32.DragQueryFileW(hdrop, 0xFFFFFFFF, None, 0)
    if not count:
        return []

    buffer = ctypes.create_unicode_buffer(32768)
    items = []
    for index in range(count):
        copied = shell32.DragQueryFileW(hdrop, index, buffer, 32768)
        if not copied or copied >= 32768:
            continue
        path = buffer[:copied]
        if not path:
            continue
        attributes = kernel32.GetFileAttributesW(path)
        if attributes == INVALID_FILE_ATTRIBUTES:
            continue  # deleted, virtual-only, or inaccessible: drop it
        is_directory = bool(attributes & FILE_ATTRIBUTE_DIRECTORY)
        entry = {
            'kind': 'directory' if is_directory else 'file',
            'path': path,
        }
        if not is_directory:
            media_type = media_type_for_path(path)
            if media_type:
                entry['mediaType'] = media_type
        items.append(entry)
    return items


def open_clipboard(owner_window):
    """Acquire the desktop-wide clipboard lock, retrying briefly."""
    backoff = (10, 25, 50)
    for attempt in range(3):
        if user32.OpenClipboard(owner_window):
            return True
        if attempt < 2:
            time.sleep(backoff[attempt] / 1000.0)
    return False


def refresh_clipboard_paths(owner_window):
    """Read the current CF_HDROP contents and persist them.

    Safe to call at startup (before the pump) and from WM_CLIPBOARDUPDATE.
    A non-file copy clears the snapshot on purpose.
    """
    global _refresh_in_progress
    if _refresh_in_progress:
        return False
    _refresh_in_progress = True

    items = []
    success = False
    try:
        if open_clipboard(owner_window):
            try:
                if user32.IsClipboardFormatAvailable(CF_HDROP):
                    data = user32.GetClipboardData(CF_HDROP)
                    if data:
                        items = collect_entries(data)
                        success = True
                else:
                    # A non-file copy (text, image, and so on) clears the
                    # snapshot: keeping the previous paths here would let a later
                    # paste insert something the user did not just copy.
                    success = True
            finally:
                user32.CloseClipboard()
        # Always persist, including the empty case, so a stale snapshot cannot
        # outlive the clipboard state that produced it.
        written = write_state_file(items)
        return success and written
    finally:
        _refresh_in_progress = False


# ---------------------------------------------------------------------------
# Window / message pump
# ---------------------------------------------------------------------------
_WINDOW_CLASS_NAME = 'DshClipboardHookListener'
_wndproc_ref = None  # kept alive so the callback is not garbage collected


def _make_wndproc():
    @WNDPROC
    def wndproc(window, message, w_param, l_param):
        if message == WM_CLIPBOARDUPDATE:
            refresh_clipboard_paths(window)
            return 0
        if message == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        if message == WM_QUERYENDSESSION:
            return 1  # TRUE: grant shutdown
        return user32.DefWindowProcW(window, message, w_param, l_param)

    global _wndproc_ref
    _wndproc_ref = wndproc
    return wndproc


def register_hook_window_class(module_instance):
    window_class = WNDCLASSEXW()
    window_class.cbSize = ctypes.sizeof(WNDCLASSEXW)
    window_class.lpfnWndProc = _make_wndproc()
    window_class.hInstance = module_instance
    window_class.lpszClassName = _WINDOW_CLASS_NAME
    atom = user32.RegisterClassExW(ctypes.byref(window_class))
    return atom != 0 or kernel32.GetLastError() == ERROR_CLASS_ALREADY_EXISTS


def create_hook_window(module_instance):
    # HWND_MESSAGE keeps the window off screen entirely.
    return user32.CreateWindowExW(
        0, _WINDOW_CLASS_NAME, None, 0, 0, 0, 0, 0,
        wintypes.HWND(-3), None, module_instance, None
    )


def report_startup_failure(step):
    error = kernel32.GetLastError()
    user32.MessageBoxW(
        None,
        f"DshClipboardHook failed to start at: {step}\nGetLastError: {error}",
        "DshClipboardHook",
        0x10 | 0x0  # MB_OK | MB_ICONERROR
    )


def main():
    # Single instance: a second hook would fight over the same state file.
    mutex = kernel32.CreateMutexW(None, False, "Local\\DshClipboardHook.SingleInstance")
    if mutex and kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        # Already running: exit quietly (this is a background process).
        if mutex:
            kernel32.CloseHandle(mutex)
        return 0
    if not mutex:
        report_startup_failure("CreateMutexW")
        return 1

    module_instance = kernel32.GetModuleHandleW(None)
    if not register_hook_window_class(module_instance):
        report_startup_failure("RegisterClassExW")
        kernel32.CloseHandle(mutex)
        return 1

    window = create_hook_window(module_instance)
    if not window:
        report_startup_failure("CreateWindowExW")
        kernel32.CloseHandle(mutex)
        return 1

    if not user32.AddClipboardFormatListener(window):
        user32.DestroyWindow(window)
        report_startup_failure("AddClipboardFormatListener")
        kernel32.CloseHandle(mutex)
        return 1

    # Reflect whatever is on the clipboard right now, then let notifications
    # drive subsequent updates.
    refresh_clipboard_paths(window)

    message = MSG()
    while True:
        result = user32.GetMessageW(ctypes.byref(message), None, 0, 0)
        if result == 0 or result == -1:
            break
        user32.TranslateMessage(ctypes.byref(message))
        user32.DispatchMessageW(ctypes.byref(message))

    user32.RemoveClipboardFormatListener(window)
    user32.DestroyWindow(window)
    user32.UnregisterClassW(_WINDOW_CLASS_NAME, module_instance)
    kernel32.CloseHandle(mutex)
    return 0


if __name__ == "__main__":
    sys.exit(main())
