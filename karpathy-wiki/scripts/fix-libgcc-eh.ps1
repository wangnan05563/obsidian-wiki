# Fix libgcc_eh.a missing issue for w64devkit + Rust GNU toolchain
# w64devkit uses SEH exception handling and does not include libgcc_eh.a
# Rust GNU toolchain hardcodes -lgcc_eh in linker args
# Solution: copy libgcc.a as libgcc_eh.a (functionally equivalent for SEH builds)

$libgccDir = "d:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\w64devkit\w64devkit\lib\gcc\x86_64-w64-mingw32\16.1.0"
$libgcc = Join-Path $libgccDir "libgcc.a"
$libgccEh = Join-Path $libgccDir "libgcc_eh.a"

if (Test-Path $libgccEh) {
    Write-Host "libgcc_eh.a already exists, skipping"
} elseif (Test-Path $libgcc) {
    Copy-Item $libgcc $libgccEh -Force
    Write-Host "Created libgcc_eh.a from libgcc.a"
} else {
    Write-Host "ERROR: libgcc.a not found at $libgcc"
    exit 1
}
