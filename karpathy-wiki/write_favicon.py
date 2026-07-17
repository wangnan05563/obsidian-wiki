import os

svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Karpathy Wiki">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a0533"/>
      <stop offset="100%" stop-color="#0d1a3d"/>
    </linearGradient>
    <linearGradient id="head" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a0533"/>
      <stop offset="50%" stop-color="#2d0a4a"/>
      <stop offset="100%" stop-color="#0d1a3d"/>
    </linearGradient>
    <radialGradient id="eye">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#00f5ff"/>
      <stop offset="100%" stop-color="#0088aa"/>
    </radialGradient>
    <radialGradient id="antenna">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#ff006e"/>
      <stop offset="100%" stop-color="#b026ff"/>
    </radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <line x1="256" y1="56" x2="256" y2="112" stroke="#b026ff" stroke-width="8" stroke-linecap="round" filter="url(#glow)"/>
  <circle cx="256" cy="44" r="16" fill="url(#antenna)" filter="url(#glow)"/>
  <rect x="96" y="120" width="320" height="240" rx="72" ry="72" fill="url(#head)" stroke="#b026ff" stroke-width="6"/>
  <rect x="96" y="120" width="320" height="240" rx="72" ry="72" fill="none" stroke="#00f5ff" stroke-width="3" opacity="0.5"/>
  <line x1="112" y1="156" x2="112" y2="324" stroke="#ff006e" stroke-width="3" opacity="0.5"/>
  <line x1="400" y1="156" x2="400" y2="324" stroke="#00f5ff" stroke-width="3" opacity="0.5"/>
  <circle cx="200" cy="220" r="30" fill="url(#eye)" filter="url(#glow)"/>
  <circle cx="312" cy="220" r="30" fill="url(#eye)" filter="url(#glow)"/>
  <circle cx="208" cy="212" r="8" fill="#ffffff" opacity="0.9"/>
  <circle cx="320" cy="212" r="8" fill="#ffffff" opacity="0.9"/>
  <polyline points="212,290 232,304 256,298 280,304 300,290" fill="none" stroke="#ff006e" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
</svg>"""

# Pure ASCII SVG - no encoding issues possible
# Using UTF-8 for XML compliance, but content is 100% ASCII
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "public", "favicon.svg")
with open(path, "w", encoding="utf-8", newline="\n") as f:
    f.write(svg)

with open(path, "rb") as f:
    data = f.read()
print("Written {} bytes to {}".format(len(data), path))
print("First 3 bytes: {}".format(data[:3].hex()))
print("Has BOM: {}".format(data[:3] == b"\xef\xbb\xbf"))
print("Is pure ASCII: {}".format(all(b < 128 for b in data)))
