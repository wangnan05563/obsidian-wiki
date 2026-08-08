// §4.3 useImageCompress — 图片压缩 composable。
// 职责：用 canvas 将大图压缩到指定 MB 以内；生成正方形缩略图。
// 设计选择：逐步降低 quality（0.9→0.1）直到满足大小，保证质量优先。
// 统一加载 File/Blob 为 HTMLImageElement，加载后释放 ObjectURL 避免内存泄漏
// 移到模块顶层避免每次 useImageCompress() 调用重新创建函数实例（S7721）
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(src);
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Image load failed'));
        };
        img.src = url;
    });
}
// 按最长边等比例缩放，保留原始宽高比
// 移到模块顶层避免每次 useImageCompress() 调用重新创建函数实例（S7721）
function calculateSize(origW, origH, maxSide) {
    if (origW > origH) {
        return { width: maxSide, height: Math.round(origH * (maxSide / origW)) };
    }
    return { width: Math.round(origW * (maxSide / origH)), height: maxSide };
}
// 移到模块顶层避免每次 useImageCompress() 调用重新创建函数实例（S7721）
function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 返回 null'))), type, quality);
    });
}
// 压缩到 maxSizeMB 以内；已达标直接返回
// 移到模块顶层避免每次 useImageCompress() 调用重新创建函数实例（S7721）
async function compress(file, maxSizeMB) {
    if (file.size <= maxSizeMB * 1024 * 1024) {
        return file;
    }
    const img = await loadImage(file);
    const canvas = document.createElement('canvas');
    const { width, height } = calculateSize(img.width, img.height, 1920);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('canvas 2d context 不可用');
    ctx.drawImage(img, 0, 0, width, height);
    // 逐步降低质量直到满足大小或 quality 跌破 0.1
    let quality = 0.9;
    let blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    while (blob.size > maxSizeMB * 1024 * 1024 && quality > 0.1) {
        quality -= 0.1;
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    }
    return blob;
}
// 生成正方形缩略图（按短边缩放后居中裁剪），size 为边长像素
// 移到模块顶层避免每次 useImageCompress() 调用重新创建函数实例（S7721）
async function generateThumbnail(blob, size) {
    const img = await loadImage(blob);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('canvas 2d context 不可用');
    // 短边缩放到 size，长边等比例缩放后居中裁剪
    const scale = Math.max(size / img.width, size / img.height);
    const scaledW = img.width * scale;
    const scaledH = img.height * scale;
    const offsetX = (size - scaledW) / 2;
    const offsetY = (size - scaledH) / 2;
    ctx.drawImage(img, offsetX, offsetY, scaledW, scaledH);
    return canvasToBlob(canvas, 'image/jpeg', 0.8);
}
export function useImageCompress() {
    return { compress, generateThumbnail };
}
