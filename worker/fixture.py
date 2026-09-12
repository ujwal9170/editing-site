"""Generate disposable test media, never included as user footage in Git."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw
from media import run
root = Path(sys.argv[1]).resolve(); root.mkdir(parents=True, exist_ok=True)
run(['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(root / 'QA-test-pattern.mp4')])
background = Image.new('RGB', (1080, 1920), '#7c3aed'); background.save(root / 'background.png')
background_720 = Image.new('RGB', (720, 1280), '#7c3aed'); background_720.save(root / 'background-720.png')
overlay = Image.new('RGBA', (1080, 1920)); draw = ImageDraw.Draw(overlay); draw.rectangle((100, 100, 450, 180), fill='#c5ff5f'); overlay.save(root / 'overlay.png')
print(root / 'QA-test-pattern.mp4')
