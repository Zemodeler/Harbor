"""Convert the supplied Harbor identity to a multi-size Windows icon, without editing it."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = Image.open(root / 'design' / 'harbor-icon.png').convert('RGBA')
source.save(root / 'build' / 'icon.ico', format='ICO', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
print('Created build/icon.ico: 16, 24, 32, 48, 64, 128, 256 pixels')
