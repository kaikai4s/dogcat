"""Extract the 20 supplied orange-cat poses, preserving the original order."""
from pathlib import Path
import importlib.util

spec = importlib.util.spec_from_file_location('pet_packager',Path(__file__).with_name('package-dog-walk.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)

if __name__ == '__main__':
    packager.main(
        source_path=Path(r'C:\Users\16377\AppData\Local\Temp\codex-clipboard-cd0fc34f-5391-4bd2-bb48-817696eddc86.png'),
        output_path=packager.ROOT/'output'/'orange-cat-walk-20-v2',
        rows=5,
        animal='cat',
        row_boundaries=[0,195,390,610,825,1024]
    )
