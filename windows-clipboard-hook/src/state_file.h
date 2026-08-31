// Copyright 2026. MIT License.
// Local state-file writer: writes the most recent CF_HDROP enumeration as a
// UTF-8 JSON snapshot under %LOCALAPPDATA%\DshClipboardHook.
//
// The file is the only channel between this hook and DSH. Keep its schema in
// sync with dsh-plugin/lib/index.js (validateItem / readStateFile).

#ifndef DSH_CLIPBOARD_HOOK_STATE_FILE_H
#define DSH_CLIPBOARD_HOOK_STATE_FILE_H

#include <string>
#include <vector>

namespace wfp {

/** One enumerated clipboard entry, already classified. */
struct StateItem {
    bool isDirectory = false;
    std::wstring path;
    std::wstring mediaType;  // empty when unknown; hint only, never authoritative
};

/** Snapshot of one successful CF_HDROP enumeration. */
struct StateSnapshot {
    std::vector<StateItem> items;
    bool truncated = false;  // item-count or size cap dropped the tail
};

/**
 * Resolve `%LOCALAPPDATA%\DshClipboardHook\clipboard-paths.json`.
 * @param outPath - receives the absolute path on success.
 * @returns false when LOCALAPPDATA is unavailable.
 */
bool stateFilePath(std::wstring& outPath);

/**
 * Write a snapshot atomically: create the directory with an explicit security
 * descriptor, then write to a sibling temporary file and atomically replace the
 * target. Any failure leaves the previous file untouched.
 * @param snapshot - items to persist.
 * @returns false when the directory or the file could not be written. The
 *          caller must keep running regardless.
 */
bool writeStateFile(const StateSnapshot& snapshot);

}  // namespace wfp

#endif  // DSH_CLIPBOARD_HOOK_STATE_FILE_H
