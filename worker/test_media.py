"""Offline regression tests for the worker's stdout JSON protocol."""
import io
import json
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

import yt_dlp
from yt_dlp.downloader.common import FileDownloader
from worker import media


class WorkerProtocolTests(unittest.TestCase):
    def test_download_progress_cannot_contaminate_result(self):
        result = {'file': 'sample.mp4', 'caption': 'Caption with emojis 🎬'}

        def noisy_download(*args):
            # Reproduce the real failure: quiet=True still prints a progress
            # line without a final newline, immediately before the JSON result.
            with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as ydl:
                downloader = FileDownloader(ydl, ydl.params)
                downloader.report_progress({
                    'status': 'finished', 'downloaded_bytes': 1024,
                    'total_bytes': 1024, 'elapsed': 1,
                    'filename': 'sample.mp4', 'info_dict': {},
                })
            return result

        output, diagnostics = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(diagnostics):
            with patch.object(media, 'import_media', side_effect=noisy_download):
                media.execute({'action': 'download', 'root': '.'})
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertIn('[download]', diagnostics.getvalue())

    def test_failed_download_does_not_emit_a_success_result(self):
        output = io.StringIO()
        with redirect_stdout(output):
            with patch.object(media, 'import_media', side_effect=ValueError('Download failed')):
                with self.assertRaisesRegex(ValueError, 'Download failed'):
                    media.execute({'action': 'download', 'root': '.'})
        self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
