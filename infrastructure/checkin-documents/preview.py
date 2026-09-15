"""Generate a disposable reading copy; never modify or rewrite the original."""
from io import BytesIO
import warnings
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def make_preview(original: bytes) -> bytes:
    if not original or len(original) > 10_000_000:
        raise ValueError('Invalid original size')
    with Image.open(BytesIO(original)) as opened:
        opened.seek(0)
        image = ImageOps.exif_transpose(opened)
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        if image.mode in ('RGBA', 'LA') or 'transparency' in image.info:
            rgba = image.convert('RGBA')
            background = Image.new('RGB', image.size, 'white')
            background.paste(rgba, mask=rgba.getchannel('A'))
            image = background
        else:
            image = image.convert('RGB')
        output = BytesIO()
        image.save(output, 'JPEG', quality=85, optimize=True)
        return output.getvalue()
