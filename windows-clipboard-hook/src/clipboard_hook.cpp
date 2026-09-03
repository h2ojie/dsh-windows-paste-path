// Copyright 2026. MIT License.
// Clipboard monitoring implementation.
//
// Two rules dominate this file:
//
// 1. OpenClipboard takes a process-wide-visible lock for the whole desktop. A
//    leaked lock breaks the clipboard for every other running program, so the
//    release is owned by an RAII guard and never by a branch.
// 2. Paths are kept exactly as Windows reports them. No normalization, no
//    MAX_PATH truncation, no case folding.

#include "clipboard_hook.h"

#include "state_file.h"

#include <windows.h>

#include <string>
#include <utility>
#include <vector>

namespace wfp {
namespace {

constexpr wchar_t kWindowClassName[] = L"DshClipboardHookListener";

// Explorer may hold the clipboard for a few milliseconds right after a copy.
constexpr int kOpenMaxAttempts = 3;
constexpr DWORD kOpenBackoffMs[kOpenMaxAttempts] = {10, 25, 50};

// DragQueryFileW can return paths well beyond MAX_PATH.
constexpr UINT kPathBufferChars = 32768;

// Extension to media-type hints. Only image types are enumerated: anything
// absent is already treated as unsupported, so listing archives or documents
// would add maintenance cost without changing behaviour. DSH makes the final
// decision against its own imageLimits.mediaTypes.
struct ExtensionHint {
    const wchar_t* extension;
    const wchar_t* mediaType;
};

constexpr ExtensionHint kExtensionHints[] = {
    {L".jpg", L"image/jpeg"},  {L".jpeg", L"image/jpeg"},
    {L".jpe", L"image/jpeg"},  {L".png", L"image/png"},
    {L".gif", L"image/gif"},   {L".webp", L"image/webp"},
    {L".bmp", L"image/bmp"},   {L".tif", L"image/tiff"},
    {L".tiff", L"image/tiff"}, {L".avif", L"image/avif"},
    {L".heic", L"image/heic"}, {L".heif", L"image/heif"},
    {L".svg", L"image/svg+xml"},
    {L".ico", L"image/vnd.microsoft.icon"},
};

// The message pump is single threaded and startup runs before the pump starts,
// so a plain flag is sufficient; `volatile` keeps the compiler from caching it
// across the window-procedure call boundary.
volatile bool gRefreshInProgress = false;

/**
 * RAII guard for the clipboard lock.
 *
 * The lock is desktop-wide: failing to release it leaves every other program
 * unable to read or write the clipboard until this process exits. Releasing in
 * a destructor covers every exit path, including ones added later.
 */
class ClipboardLock {
public:
    ClipboardLock() = default;
    ClipboardLock(const ClipboardLock&) = delete;
    ClipboardLock& operator=(const ClipboardLock&) = delete;

    ~ClipboardLock() {
        if (opened_) {
            CloseClipboard();
        }
    }

    /** Acquire the lock, retrying briefly while another program holds it. */
    bool acquire(HWND ownerWindow) {
        for (int attempt = 0; attempt < kOpenMaxAttempts; ++attempt) {
            if (OpenClipboard(ownerWindow) != FALSE) {
                opened_ = true;
                return true;
            }
            if (attempt + 1 < kOpenMaxAttempts) {
                Sleep(kOpenBackoffMs[attempt]);
            }
        }
        return false;
    }

private:
    bool opened_ = false;
};

/** Map a file extension to a media-type hint; empty when unknown. */
std::wstring mediaTypeForPath(const std::wstring& path) {
    const size_t dot = path.rfind(L'.');
    if (dot == std::wstring::npos) {
        return std::wstring();
    }
    const std::wstring extension = path.substr(dot);
    for (const ExtensionHint& hint : kExtensionHints) {
        if (_wcsicmp(extension.c_str(), hint.extension) == 0) {
            return std::wstring(hint.mediaType);
        }
    }
    return std::wstring();
}

/**
 * Copy CF_HDROP path strings while its clipboard-owned handle is valid.
 *
 * This function deliberately performs no filesystem I/O. GetFileAttributesW
 * on a disconnected mapped drive or unreachable UNC share can block
 * indefinitely, so it must never run while the desktop-wide clipboard lock is
 * held.
 */
bool collectPaths(HDROP drop, std::vector<std::wstring>& paths) {
    const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
    if (count == 0) {
        return false;
    }

    std::wstring buffer;
    buffer.resize(kPathBufferChars);
    paths.clear();

    for (UINT index = 0; index < count; ++index) {
        const UINT copied = DragQueryFileW(drop, index, buffer.data(),
                                           static_cast<UINT>(buffer.size()));
        if (copied == 0 || copied >= buffer.size()) {
            return false;
        }

        std::wstring path(buffer.data(), copied);
        if (!path.empty()) {
            paths.push_back(std::move(path));
        }
    }

    return !paths.empty();
}

/** Classify process-owned paths after CloseClipboard releases the lock. */
void classifyEntries(const std::vector<std::wstring>& paths, StateSnapshot& snapshot) {
    snapshot.items.clear();
    for (const std::wstring& path : paths) {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            continue;  // deleted, virtual-only, or inaccessible: drop it
        }

        StateItem item;
        item.path = path;
        item.isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (!item.isDirectory) {
            item.mediaType = mediaTypeForPath(path);
        }
        snapshot.items.push_back(std::move(item));
    }
}

LRESULT CALLBACK hookWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_CLIPBOARDUPDATE:
            refreshClipboardPaths(window);
            return 0;

        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;

        // Returning TRUE grants the shutdown request. WM_DESTROY then ends the
        // pump through PostQuitMessage.
        case WM_QUERYENDSESSION:
            return TRUE;

        default:
            return DefWindowProcW(window, message, wParam, lParam);
    }
}

}  // namespace

bool registerHookWindowClass(HINSTANCE moduleInstance) {
    WNDCLASSEXW windowClass = {};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = hookWindowProc;
    windowClass.hInstance = moduleInstance;
    windowClass.lpszClassName = kWindowClassName;
    const ATOM atom = RegisterClassExW(&windowClass);
    return atom != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

HWND createHookWindow(HINSTANCE moduleInstance) {
    // HWND_MESSAGE keeps the window off screen entirely; clipboard change
    // notifications are delivered to message-only windows as usual.
    return CreateWindowExW(0, kWindowClassName, nullptr, 0, 0, 0, 0, 0, HWND_MESSAGE,
                           nullptr, moduleInstance, nullptr);
}

bool refreshClipboardPaths(HWND ownerWindow) {
    if (gRefreshInProgress) {
        return false;
    }
    gRefreshInProgress = true;

    StateSnapshot snapshot;
    std::vector<std::wstring> paths;
    bool succeeded = false;

    {
        ClipboardLock lock;
        if (lock.acquire(ownerWindow)) {
            if (IsClipboardFormatAvailable(CF_HDROP) != FALSE) {
                // The HDROP belongs to the clipboard and becomes invalid when
                // CloseClipboard runs. Copy only the path strings here;
                // potentially blocking filesystem classification must happen
                // after the RAII guard releases the desktop-wide lock.
                // DragFinish must NOT be called on a clipboard HDROP.
                const HANDLE data = GetClipboardData(CF_HDROP);
                if (data != nullptr) {
                    succeeded = collectPaths(static_cast<HDROP>(data), paths);
                }
            } else {
                // A non-file copy (text, image, and so on) intentionally clears
                // the snapshot: keeping the previous paths here would let a
                // later paste insert something the user did not just copy.
                succeeded = true;
            }
        }
    }

    classifyEntries(paths, snapshot);
    // Always persist, including the empty case, so a stale snapshot cannot
    // outlive the clipboard state that produced it.
    const bool persisted = writeStateFile(snapshot);

    gRefreshInProgress = false;
    return succeeded && persisted;
}

}  // namespace wfp
