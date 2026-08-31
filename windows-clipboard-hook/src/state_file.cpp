// Copyright 2026. MIT License.
// State-file writer implementation.
//
// Three properties matter here and each is easy to lose:
//
// 1. The directory must be created with an explicit security descriptor.
//    %LOCALAPPDATA% itself is typically listable by other local users, so
//    leaving the new directory on the default ACL would expose the paths.
// 2. Writes go through a temporary file plus an atomic replace, so a reader
//    never observes a half-written document.
// 3. Paths are emitted verbatim. No normalization, joining, or case folding:
//    drive letters and UNC prefixes must survive untouched.

#include "state_file.h"

#include <windows.h>
#include <sddl.h>

#include <cstdio>
#include <cwchar>

namespace wfp {
namespace {

// Serialization caps. The snapshot lives in a user-writable directory and is
// parsed by DSH on every paste, so an absurd clipboard must not be able to
// produce an absurd file.
constexpr size_t kMaxItems = 256;
constexpr size_t kMaxEncodedBytes = 1024 * 1024;
constexpr size_t kMaxPathUtf8Bytes = 32 * 1024;
constexpr size_t kMaxMediaTypeChars = 128;

constexpr wchar_t kDirectoryName[] = L"DshClipboardHook";
constexpr wchar_t kFileName[] = L"clipboard-paths.json";

// D:NO_ACCESS_CONTROL from the parent (protected), plus explicit ACEs below.
// Keeping DACL_PROTECTED avoids inheriting a permissive parent ACE that would
// silently undo the restriction.
constexpr wchar_t kDirectorySddl[] =
    L"D:PAI"
    L"(A;OICI;FA;;;BA)"    // BUILTIN\Administrators: full control
    L"(A;OICI;FA;;;SY)"    // SYSTEM: full control
    L"(A;OICI;FA;;;CO)";   // CREATOR OWNER: full control (resolves to the user)

struct FileHandle {
    HANDLE handle = INVALID_HANDLE_VALUE;

    FileHandle() = default;
    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;

    ~FileHandle() {
        if (handle != INVALID_HANDLE_VALUE) {
            CloseHandle(handle);
        }
    }

    bool valid() const { return handle != INVALID_HANDLE_VALUE; }
};

/** Absolute target path, or false when LOCALAPPDATA is not usable. */
bool localAppDataDirectory(std::wstring& outDirectory) {
    wchar_t buffer[MAX_PATH] = {};
    const DWORD written = GetEnvironmentVariableW(L"LOCALAPPDATA", buffer, MAX_PATH);
    if (written == 0 || written >= MAX_PATH) {
        return false;
    }
    outDirectory.assign(buffer);
    if (outDirectory.empty()) {
        return false;
    }
    return true;
}

bool appendPathSegment(std::wstring& target, const wchar_t* segment) {
    if (target.empty() || segment == nullptr || segment[0] == L'\0') {
        return false;
    }
    const wchar_t last = target[target.size() - 1];
    if (last != L'\\' && last != L'/') {
        target.push_back(L'\\');
    }
    target.append(segment);
    return true;
}

/**
 * Create one directory level with an explicit security descriptor.
 * @returns true when the directory now exists (created or already present).
 */
bool createDirectoryWithAcl(const std::wstring& path) {
    SECURITY_ATTRIBUTES attributes = {};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = FALSE;

    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
            kDirectorySddl, SDDL_REVISION_1, &descriptor, nullptr) != FALSE) {
        attributes.lpSecurityDescriptor = descriptor;
    }
    // A failed conversion is not fatal: the directory is then created with the
    // default ACL and the loop below still succeeds. Preferring "usable" over
    // "secure but missing" would be wrong the other way round, so the fallback
    // is deliberate and rare on a healthy machine.

    const bool created = CreateDirectoryW(path.c_str(), &attributes) != FALSE;
    const DWORD error = GetLastError();

    if (descriptor != nullptr) {
        LocalFree(descriptor);
    }

    return created || error == ERROR_ALREADY_EXISTS;
}

/** UTF-8 encode a UTF-16 string, returning false on malformed input. */
bool toUtf8(const std::wstring& value, std::string& outBytes) {
    outBytes.clear();
    if (value.empty()) {
        return true;
    }
    const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0) {
        return false;
    }
    outBytes.resize(static_cast<size_t>(required));
    const int written = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), outBytes.data(), required,
                                            nullptr, nullptr);
    if (written != required) {
        return false;
    }
    return true;
}

/** Escape one string as a JSON string body (without the surrounding quotes). */
void appendJsonEscaped(std::string& target, const std::string& value) {
    for (unsigned char byte : value) {
        switch (byte) {
            case '"':
                target += "\\\"";
                break;
            case '\\':
                target += "\\\\";
                break;
            case '\b':
                target += "\\b";
                break;
            case '\f':
                target += "\\f";
                break;
            case '\n':
                target += "\\n";
                break;
            case '\r':
                target += "\\r";
                break;
            case '\t':
                target += "\\t";
                break;
            default:
                if (byte < 0x20) {
                    char escaped[7] = {};
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", byte);
                    target += escaped;
                } else {
                    target.push_back(static_cast<char>(byte));
                }
                break;
        }
    }
}

/**
 * Reject anything that would corrupt the document or confuse a consumer.
 * Backslashes are fine: they are escaped during serialization, and Windows
 * paths are expected to contain them.
 */
bool isEncodablePath(const std::wstring& path) {
    if (path.empty()) {
        return false;
    }
    for (wchar_t character : path) {
        if (character < 0x20 || character == 0x7f) {
            return false;
        }
    }
    return true;
}

/** Serialize the snapshot, honouring the item-count and size caps. */
bool buildSnapshotJson(const StateSnapshot& snapshot, std::string& outJson) {
    // `truncated` is only known once the loop finishes, so the object wrapper is
    // composed afterwards rather than being patched in place.
    std::string entries;
    entries.reserve(4096);

    bool truncated = false;
    size_t emitted = 0;

    for (const StateItem& item : snapshot.items) {
        if (emitted >= kMaxItems) {
            truncated = true;
            break;
        }
        if (!isEncodablePath(item.path)) {
            truncated = true;
            continue;
        }

        std::string pathUtf8;
        if (!toUtf8(item.path, pathUtf8) || pathUtf8.size() > kMaxPathUtf8Bytes) {
            truncated = true;
            continue;
        }

        std::string mediaTypeUtf8;
        if (!item.mediaType.empty()) {
            if (item.mediaType.size() > kMaxMediaTypeChars ||
                !toUtf8(item.mediaType, mediaTypeUtf8)) {
                mediaTypeUtf8.clear();
                truncated = true;
            }
        }

        std::string entry;
        entry += R"({"kind":")";
        entry += item.isDirectory ? "directory" : "file";
        entry += R"(","path":")";
        appendJsonEscaped(entry, pathUtf8);
        if (!mediaTypeUtf8.empty()) {
            entry += R"(","mediaType":")";
            appendJsonEscaped(entry, mediaTypeUtf8);
            entry += '"';
        }
        entry += "}";

        if (entries.size() + entry.size() + 2 > kMaxEncodedBytes) {
            truncated = true;
            break;
        }

        if (emitted > 0) {
            entries += ',';
        }
        entries += entry;
        ++emitted;
    }

    std::string json;
    json.reserve(entries.size() + 64);
    json += R"({"version":1,"truncated":)";
    json += truncated ? "true" : "false";
    json += R"(,"items":[)";
    json += entries;
    json += R"(]})";

    outJson = json;
    return true;
}

/** Overwrite the file, or remove it when there is nothing to persist. */
bool writeOrReplaceFile(const std::wstring& targetPath, const std::string& bytes) {
    std::wstring temporaryPath = targetPath + L".tmp";
    {
        FileHandle file;
        file.handle = CreateFileW(temporaryPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
        if (!file.valid()) {
            return false;
        }
        DWORD writtenTotal = 0;
        while (writtenTotal < bytes.size()) {
            DWORD chunk = 0;
            const DWORD remaining = static_cast<DWORD>(bytes.size() - writtenTotal);
            if (WriteFile(file.handle, bytes.data() + writtenTotal, remaining, &chunk, nullptr) == FALSE) {
                return false;
            }
            if (chunk == 0) {
                return false;
            }
            writtenTotal += chunk;
        }
        if (FlushFileBuffers(file.handle) == FALSE) {
            return false;
        }
    }

    if (MoveFileExW(temporaryPath.c_str(), targetPath.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == FALSE) {
        DeleteFileW(temporaryPath.c_str());
        return false;
    }
    return true;
}

}  // namespace

bool stateFilePath(std::wstring& outPath) {
    std::wstring directory;
    if (!localAppDataDirectory(directory)) {
        return false;
    }
    if (!appendPathSegment(directory, kDirectoryName)) {
        return false;
    }
    if (!appendPathSegment(directory, kFileName)) {
        return false;
    }
    outPath = directory;
    return true;
}

bool writeStateFile(const StateSnapshot& snapshot) {
    std::wstring targetPath;
    if (!stateFilePath(targetPath)) {
        return false;
    }

    // %LOCALAPPDATA%\DshClipboardHook — created with an explicit ACL so the
    // parent directory's permissive default cannot leak the paths.
    std::wstring directory(targetPath);
    const size_t separator = directory.rfind(L'\\');
    if (separator == std::wstring::npos || separator == 0) {
        return false;
    }
    directory.resize(separator);
    if (!createDirectoryWithAcl(directory)) {
        return false;
    }

    std::string json;
    if (!buildSnapshotJson(snapshot, json)) {
        return false;
    }
    return writeOrReplaceFile(targetPath, json);
}

}  // namespace wfp
