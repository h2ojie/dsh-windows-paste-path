import importlib.util
import os
import sys
import threading
import unittest
from unittest import mock

MODULE_PATH = os.path.join(os.path.dirname(__file__), 'dsh_clipboard_hook.py')
SPEC = importlib.util.spec_from_file_location('dsh_clipboard_hook', MODULE_PATH)
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)


class ClipboardOrderingTest(unittest.TestCase):
    def setUp(self):
        HOOK._refresh_in_progress = False

    def test_filesystem_classification_starts_after_clipboard_close(self):
        close_called = threading.Event()
        classified = []

        def get_attributes(path):
            self.assertTrue(
                close_called.is_set(),
                'GetFileAttributesW ran while the desktop-wide clipboard lock was held',
            )
            classified.append(path)
            return HOOK.FILE_ATTRIBUTE_DIRECTORY

        with (
            mock.patch.object(HOOK, 'open_clipboard', return_value=True),
            mock.patch.object(HOOK.user32, 'IsClipboardFormatAvailable', return_value=True),
            mock.patch.object(HOOK.user32, 'GetClipboardData', return_value=123),
            mock.patch.object(HOOK.user32, 'CloseClipboard', side_effect=lambda: close_called.set() or True),
            mock.patch.object(HOOK, 'collect_paths', return_value=[r'\\server\share']),
            mock.patch.object(HOOK.kernel32, 'GetFileAttributesW', side_effect=get_attributes),
            mock.patch.object(HOOK, 'write_state_file', return_value=True),
        ):
            self.assertTrue(HOOK.refresh_clipboard_paths(None))

        self.assertEqual(classified, [r'\\server\share'])
        self.assertFalse(HOOK._refresh_in_progress)


if __name__ == '__main__':
    unittest.main()
