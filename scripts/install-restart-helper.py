"""Install the native restart oneshot for this checkout without replacing custom units."""
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
unit = 'nookframe-restart.service'
config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
target = config / 'systemd/user' / unit
path = str(root)
if not path.isprintable() or path.endswith((' ', '\\')):
    raise SystemExit('Checkout path cannot be represented safely in WorkingDirectory')
text = (root / 'scripts' / unit).read_text().replace('%h/code/nookframe', path.replace('%', '%%'))
target.parent.mkdir(parents=True, exist_ok=True)
try:
    with target.open('x') as output:
        output.write(text)
except FileExistsError:
    if target.is_symlink() or target.read_text() != text:
        raise SystemExit(f'Existing unit left unchanged: inspect {target} before installing')
print(f'Restart helper: {target}')
