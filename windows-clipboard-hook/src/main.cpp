// Copyright 2026. MIT License.
// DshClipboardHook entry point.
//
// Startup order matters: AddClipboardFormatListener only delivers events for
// changes made after registration, so the current clipboard is read once by
// hand before the message pump starts. Without that read, copying a folder and
// only then starting the hook would leave the state file empty.

#include "clipboard_hook.h"

#include <windows.h>

#include <string>

namespace {

constexpr wchar_t kMutexName[] = L"Local\\DshClipboardHook.SingleInstance";

int reportStartupFailure(const wchar_t* step) {
    const DWORD error = GetLastError();
    std::wstring message(L"DshClipboardHook failed to start at: ");
    message += step;
    message += L"\nGetLastError: ";
    message += std::to_wstring(error);
    MessageBoxW(nullptr, message.c_str(), L"DshClipboardHook",
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    return 1;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE moduleInstance, HINSTANCE, PWSTR, int) {
    // Single instance: a second hook would fight over the same state file.
    HANDLE mutex = CreateMutexW(nullptr, FALSE, kMutexName);
    const bool alreadyRunning = mutex != nullptr && GetLastError() == ERROR_ALREADY_EXISTS;
    if (alreadyRunning) {
        MessageBoxW(nullptr, L"DshClipboardHook is already running.", L"DshClipboardHook",
                    MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND);
        if (mutex != nullptr) {
            CloseHandle(mutex);
        }
        return 0;
    }
    if (mutex == nullptr) {
        return reportStartupFailure(L"CreateMutexW");
    }

    const HRESULT oleResult = OleInitialize(nullptr);
    const bool oleReady = SUCCEEDED(oleResult);

    if (!wfp::registerHookWindowClass(moduleInstance)) {
        return reportStartupFailure(L"RegisterClassExW");
    }

    HWND window = wfp::createHookWindow(moduleInstance);
    if (window == nullptr) {
        return reportStartupFailure(L"CreateWindowExW");
    }

    if (AddClipboardFormatListener(window) == FALSE) {
        DestroyWindow(window);
        return reportStartupFailure(L"AddClipboardFormatListener");
    }

    // Reflect whatever is on the clipboard right now, then let notifications
    // drive subsequent updates.
    wfp::refreshClipboardPaths(window);

    MSG message = {};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    RemoveClipboardFormatListener(window);
    DestroyWindow(window);
    UnregisterClassW(L"DshClipboardHookListener", moduleInstance);

    if (oleReady) {
        OleUninitialize();
    }
    if (mutex != nullptr) {
        CloseHandle(mutex);
    }
    return 0;
}
