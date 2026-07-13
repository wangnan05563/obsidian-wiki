// window.rs — Tauri 窗口管理
//
// 管理两个窗口：
// 1. 主窗口：加载 http://localhost:{port}/，完整应用界面
// 2. 悬浮窗口：加载 http://localhost:{port}/#floating，透明置顶小圆按钮
//
// 为什么用 WebviewWindowBuilder 而非配置文件：窗口参数需要动态拼接 URL（端口），
// 在代码中创建更灵活；配置文件 windows 数组留空。

use tauri::{App, AppHandle, Manager, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub fn create_main_window(app: &App, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!("http://localhost:{}/", port);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
        .title("Karpathy Wiki")
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .build()?;
    Ok(())
}

// 悬浮窗口两种尺寸：收起态（小圆按钮）和展开态（问答面板）
// 为什么用物理像素：set_size 接受 PhysicalSize，避免 DPI 缩放导致尺寸不准
const FLOATING_COLLAPSED: (u32, u32) = (80, 80);
const FLOATING_EXPANDED: (u32, u32) = (420, 560);

pub fn create_floating_window(app: &App, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    // 悬浮窗口：使用 webview.eval() 注入 floating 模式标志
    // 为什么不用 initialization_script 设置 localStorage：
    //   Tauri 2.x WebView2 在 Windows 上同源（http://localhost:3000）的 webview
    //   共享 localStorage 存储，会污染主窗口的检测逻辑，导致主窗口也进入 floating mode。
    // 为什么不用 URL query/hash：
    //   Tauri 2.x WebviewUrl::External 在某些 WebView2 版本下不会保留 query/hash 到 window.location。
    // 为什么用 webview.eval()：
    //   eval() 直接在 webview JS context 设置 window 属性，完全隔离，不影响其他 webview。
    let url = format!("http://localhost:{}/", port);
    let win = WebviewWindowBuilder::new(app, "floating", WebviewUrl::External(url.parse()?))
        .title("")
        .inner_size(FLOATING_COLLAPSED.0 as f64, FLOATING_COLLAPSED.1 as f64)
        .min_inner_size(FLOATING_COLLAPSED.0 as f64, FLOATING_COLLAPSED.1 as f64)
        .decorations(false)       // 无标题栏，圆角按钮外观
        .transparent(true)        // 透明背景，让按钮浮在桌面上
        .always_on_top(true)      // 置顶，随时可呼出
        .skip_taskbar(true)       // 不显示在任务栏，避免与主窗口混淆
        .resizable(true)          // 允许调整大小：展开后用户可拖动边缘改变面板尺寸
        .visible(true)
        .build()?;
    // eval() 是异步的，JS 会在 webview 加载完成后执行
    let _ = win.eval("window.__FLOATING_MODE__ = true;");
    Ok(())
}

// 切换悬浮窗口尺寸：收起↔展开
// 前端点击按钮时通过 invoke 调用此命令，Rust 端调整窗口尺寸
// 为什么不在前端用 CSS 改尺寸：Tauri 窗口尺寸由 Rust 端控制，前端无法直接修改
#[tauri::command]
pub fn toggle_floating_size(app: AppHandle, expanded: bool) {
    println!("[Tauri] toggle_floating_size called, expanded: {}", expanded);
    if let Some(win) = app.get_webview_window("floating") {
        let (w, h) = if expanded { FLOATING_EXPANDED } else { FLOATING_COLLAPSED };
        println!("[Tauri] floating window found, setting size to {}x{}", w, h);
        match win.set_size(PhysicalSize::new(w, h)) {
            Ok(_) => println!("[Tauri] set_size succeeded"),
            Err(e) => println!("[Tauri] set_size FAILED: {}", e),
        }
    } else {
        println!("[Tauri] WARNING: floating window not found!");
    }
}

// 开始拖动悬浮窗口（收起态小圆按钮和展开态面板都可拖动）
// 为什么需要这个命令：data-tauri-drag-region 只对鼠标按下拖动区域生效，
// 但小圆按钮需要先响应 click 展开，再响应拖动，两者会冲突。
// 用 JS 监听 mousedown + 移动距离判断是 click 还是 drag，drag 时调用此命令。
#[tauri::command]
pub fn start_floating_drag(app: AppHandle) {
    println!("[Tauri] start_floating_drag called");
    if let Some(win) = app.get_webview_window("floating") {
        if let Err(e) = win.start_dragging() {
            println!("[Tauri] start_dragging FAILED: {}", e);
        }
    } else {
        println!("[Tauri] WARNING: floating window not found for drag!");
    }
}
