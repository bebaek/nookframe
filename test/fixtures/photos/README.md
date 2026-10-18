# Photo fixtures

`red.heic` is a synthetic 32×24 solid-red image generated for this project using Pillow 13.0.0 and pillow-heif 1.8.1. It contains no personal photo or metadata. It exercises actual HEVC decoding, rather than just HEIF file detection.

Generate with:

```python
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()
Image.new('RGB', (32, 24), '#ff3333').save('red.heic', quality=80)
```
