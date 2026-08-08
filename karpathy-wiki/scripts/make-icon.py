import struct, os
from PIL import Image

SRC = r"D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\frontend\public\images\login\cognition-icon.png"
OUT = r"D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\assets\app.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def bmp_ico_image(rgba):
    """Encode an RGBA Image as an ICO image entry (BITMAPINFOHEADER + BGRA XOR + 1bpp AND mask)."""
    w, h = rgba.size
    # Pillow is RGBA; convert to BGRA bytes, bottom-up.
    pixels = rgba.convert("RGBA").getdata()
    px = list(pixels)
    # Build BGRA rows, bottom-up
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[y * w + x]
            row += bytes((b, g, r, a))
        # pad row to 4-byte boundary (32bpp already aligned for any width? 4 bytes/pixel -> always 4-aligned)
        xor += row
    # AND mask: 1 bit/pixel, bottom-up, rows padded to 4 bytes. Fully transparent-by-alpha => all 0.
    and_row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):
        and_mask += bytes(and_row_bytes)
    # BITMAPINFOHEADER
    biHeight = h * 2  # XOR + AND combined height
    biSizeImage = len(xor) + len(and_mask)
    header = struct.pack("<IiiHHIIiiII",
                         40,        # biSize
                         w,         # biWidth
                         biHeight,  # biHeight
                         1,         # biPlanes
                         32,        # biBitCount
                         0,         # biCompression BI_RGB
                         biSizeImage,
                         0, 0, 0, 0)
    return bytes(header) + bytes(xor) + bytes(and_mask)


im = Image.open(SRC).convert("RGBA")
print("source:", im.size)

entries = []  # (width, height, data)
for s in SIZES:
    frame = im.resize((s, s), Image.LANCZOS)
    entries.append((s, s, bmp_ico_image(frame)))

# Assemble ICO
icon_dir = struct.pack("<HHH", 0, 1, len(entries))  # reserved, type=1, count
offset = 6 + 16 * len(entries)
dir_entries = bytearray()
image_data = bytearray()
for (w, h, data) in entries:
    dir_entries += struct.pack("<BBBBHHII",
                               w if w < 256 else 0,   # width (0 means 256)
                               h if h < 256 else 0,   # height
                               0,                     # colors (0 = >8bpp)
                               0,                     # reserved
                               1,                     # planes
                               32,                    # bit count
                               len(data),             # bytes in image
                               offset)
    image_data += data
    offset += len(data)

with open(OUT, "wb") as f:
    f.write(icon_dir + bytes(dir_entries) + bytes(image_data))

print("wrote:", OUT, "total bytes:", os.path.getsize(OUT))

# Verify
with open(OUT, "rb") as f:
    d = f.read()
reserved, itype, count = struct.unpack("<HHH", d[:6])
print("verified image_count:", count)
off = 6
for i in range(count):
    w, b, h, _, planes, bpp, sz, dataoff = struct.unpack("<BBBBHHII", d[off:off + 16])
    ww = w if w != 0 else 256
    hh = h if h != 0 else 256
    fmt = "PNG" if d[dataoff] == 0x89 else "BMP"
    print(f"  entry {i}: {ww}x{hh} bpp={bpp} size={sz} format={fmt}")
    off += 16
