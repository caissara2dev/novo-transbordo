import unittest
from io import BytesIO
from PIL import Image
from pillow_heif import from_pillow
from preview import make_preview
class PreviewTests(unittest.TestCase):
 def test_orientation_and_size(self):
  image=Image.new('RGB',(2400,1200),'white');exif=Image.Exif();exif[274]=6
  output=BytesIO();image.save(output,'JPEG',exif=exif);original=output.getvalue()
  self.assertEqual(Image.open(BytesIO(make_preview(original))).size,(800,1600));self.assertEqual(output.getvalue(),original)
 def test_no_upscale(self):
  image=Image.new('RGB',(400,300),'white');out=BytesIO();image.save(out,'PNG')
  self.assertEqual(Image.open(BytesIO(make_preview(out.getvalue()))).size,(400,300))
 def test_real_heic(self):
  out=BytesIO();from_pillow(Image.new('RGB',(2000,1000),'white')).save(out);original=out.getvalue()
  self.assertIn(b'ftyp',original[:20]);self.assertEqual(Image.open(BytesIO(make_preview(original))).size,(1600,800))
 def test_invalid_original(self):
  with self.assertRaises(Exception):make_preview(b'not an image')
 def test_transparency(self):
  image=Image.new('RGBA',(20,20),(0,0,0,0));out=BytesIO();image.save(out,'PNG')
  pixel=Image.open(BytesIO(make_preview(out.getvalue()))).getpixel((0,0));self.assertGreater(min(pixel),250)
if __name__=='__main__':unittest.main()
