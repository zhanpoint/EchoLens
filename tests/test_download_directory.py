import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DownloadDirectoryTest(unittest.TestCase):
    def test_directory_organization_paths(self) -> None:
        script = """
          import { buildDirectorySegments } from './src/lib/download-settings.ts';
          const context = {
            authorName: '作者:名称',
            contentType: 'video/mp4',
            workId: '123456',
            workTitle: '作品/标题',
          };
          const now = new Date(2026, 6, 14, 9, 30, 0);
          console.log(JSON.stringify({
            author: buildDirectorySegments('author', context, 'sample.mp4', now),
            date: buildDirectorySegments('date', context, 'sample.mp4', now),
            fileType: buildDirectorySegments('fileType', context, 'sample.mp4', now),
            flat: buildDirectorySegments('flat', context, 'sample.mp4', now),
            work: buildDirectorySegments('work', context, 'sample.mp4', now),
          }));
        """
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            encoding="utf-8",
            text=True,
        )

        self.assertEqual(
            json.loads(result.stdout),
            {
                "author": ["作者_名称"],
                "date": ["2026-07-14"],
                "fileType": ["视频"],
                "flat": [],
                "work": ["作品_标题"],
            },
        )


if __name__ == "__main__":
    unittest.main()
