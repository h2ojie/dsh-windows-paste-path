// Copyright 2026. MIT License.
// Clipboard monitoring: hidden message window + WM_CLIPBOARDUPDATE, CF_HDROP
// enumeration, classification, and handoff to the state-file writer.

#ifndef DSH_CLIPBOARD_HOOK_CLIPBOARD_HOOK_H
#define DSH_CLIPBOARD_HOOK_CLIPBOARD_HOOK_H

#include <windows.h>

namespace wfp {

/**
 * Register the hidden message window class.
 * @param moduleInstance - the executable's HINSTANCE.
 * @returns false when registration fails; the caller must not continue.
 */
bool registerHookWindowClass(HINSTANCE moduleInstance);

/**
 * Create the message-only listener window.
 * @param moduleInstance - the executable's HINSTANCE.
 * @returns the window handle, or nullptr on failure.
 */
HWND createHookWindow(HINSTANCE moduleInstance);

/**
 * Read the current CF_HDROP contents and persist them.
 *
 * Safe to call from startup (before the message pump starts) and from
 * WM_CLIPBOARDUPDATE. Re-entrant calls are ignored rather than queued, because
 * the intent is always "reflect the newest state".
 *
 * @param ownerWindow - window handle passed to OpenClipboard; may be nullptr.
 * @returns false when the clipboard could not be opened, holds no CF_HDROP, or
 *          the state file could not be written. Never fatal to the process.
 */
bool refreshClipboardPaths(HWND ownerWindow);

}  // namespace wfp

#endif  // DSH_CLIPBOARD_HOOK_CLIPBOARD_HOOK_H
