"""Offline regression tests for the worker's stdout JSON protocol."""
import io
import json
import unittest
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

import yt_dlp
from yt_dlp.downloader.common import FileDownloader
from worker import media


class WorkerProtocolTests(unittest.TestCase):
    def test_downloaders_and_limits(self):
        options = media.download_options({'id': 'test'}, Path('.'))
        with yt_dlp.YoutubeDL(options) as ydl:
            self.assertEqual(set(ydl._ies), {'Instagram', 'Youtube', 'TikTok', 'TikTokVM'})
        self.assertTrue(options['noprogress'])
        self.assertTrue(options['noplaylist'])
        self.assertIn('node', options['js_runtimes'])
        self.assertIsNone(media.download_limit({'duration': 60}))
        self.assertIsNotNone(media.download_limit({'duration': 901}))
        self.assertIsNotNone(media.download_limit({'is_live': True}))
        self.assertIsNotNone(media.download_limit({'live_status': 'is_upcoming'}))

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



class OverlayCompositingTests(unittest.TestCase):
    def test_overlays_composite_at_their_own_offset(self):
        # Each overlay blends only its own box, so the offset must survive into
        # the filter graph and the input index must follow the -i order.
        filters, last = media.overlay_filters([
            {'file': 'a.png', 'x': 90, 'y': 198, 'startMs': 0, 'endMs': 2000},
            {'file': 'b.png', 'x': 0, 'y': 1700, 'startMs': 500, 'endMs': 6000},
        ])
        self.assertEqual(last, 'base2')
        self.assertEqual(filters, [
            "[base0][2:v]overlay=90:198:enable='between(t,0.0,2.0)'[base1]",
            "[base1][3:v]overlay=0:1700:enable='between(t,0.5,6.0)'[base2]",
        ])

    def test_offsets_cannot_inject_filter_syntax(self):
        with self.assertRaises(ValueError):
            media.overlay_filters([
                {'file': 'a.png', 'x': "0[x];drawbox", 'y': 0, 'startMs': 0, 'endMs': 1},
            ])

    def test_a_project_without_overlays_leaves_the_base_untouched(self):
        self.assertEqual(media.overlay_filters([]), ([], 'base0'))


if __name__ == '__main__':
    unittest.main()
