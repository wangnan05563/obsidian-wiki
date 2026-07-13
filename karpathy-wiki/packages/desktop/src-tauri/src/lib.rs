// lib.rs — Tauri 应用核心逻辑
//
// 启动流程：
// 1. 创建 Sidecar 实例并启动 Node.js 后端子进程
// 2. 轮询健康检查端点等待后端就绪
// 3. 创建主窗口（加载 http://localhost:{port}/）
// 4. 创建悬浮窗口（加载 http://localhost:{port}/#floating）
// 5. 应用退出时自动 kill 子进程（Sidecar::Drop 实现）
//
// 主窗口关闭行为：
// - 第一次点关闭按钮：隐藏窗口 + 显示托盘图标，不退出应用
// - 托盘菜单"显示主窗口"：恢复主窗口
// - 托盘菜单"退出"：kill sidecar + 真正退出应用

use tauri::{Manager, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use std::sync::Mutex;

mod sidecar;
mod window;

use sidecar::Sidecar;

// 默认后端端口，与 config.json 中 server.port 一致
const BACKEND_PORT: u16 = 3000;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 启动 Node.js 后端子进程
            let sidecar = Sidecar::new();
            if let Err(e) = sidecar.spawn() {
                eprintln!("[Tauri] 后端启动失败: {}", e);
                // 开发模式下直接给出提示，不退出（用户可能已手动启动后端）
                if cfg!(debug_assertions) {
                    eprintln!("[Tauri] 开发模式：假设后端已手动启动，继续创建窗口");
                } else {
                    return Err(e.into());
                }
            } else {
                // 等待后端就绪（仅在子进程成功启动时）
                if let Err(e) = sidecar.wait_for_ready(BACKEND_PORT) {
                    eprintln!("[Tauri] 后端就绪等待超时: {}", e);
                    if !cfg!(debug_assertions) {
                        return Err(e.into());
                    }
                }
            }

            // 将 sidecar 存入 Tauri State，应用退出时 Drop 会自动 kill
            app.manage(Mutex::new(sidecar));

            // 创建主窗口
            if let Err(e) = window::create_main_window(app, BACKEND_PORT) {
                eprintln!("[Tauri] 主窗口创建失败: {}", e);
                return Err(e);
            }

            // 创建悬浮窗口
            if let Err(e) = window::create_floating_window(app, BACKEND_PORT) {
                eprintln!("[Tauri] 悬浮窗口创建失败: {}", e);
                // 悬浮窗口失败不阻断，主窗口仍可用
            }

            // 创建托盘图标 + 菜单
            // 为什么用 tray-icon：主窗口关闭后最小化到托盘，而不是退出整个应用，
            // 让悬浮窗口继续可用，用户可通过托盘菜单恢复主窗口或退出。
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let _tray = TrayIconBuilder::new()
                .id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            // 退出前 kill sidecar 避免孤儿进程
                            if let Some(sidecar_state) = app.try_state::<Mutex<Sidecar>>() {
                                if let Ok(sidecar) = sidecar_state.lock() {
                                    sidecar.kill();
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::toggle_floating_size,
            window::start_floating_drag
        ])
        .on_window_event(|window, event| {
            // 主窗口关闭时：阻止默认关闭，改为隐藏 + 显示托盘提示
            // 为什么不直接退出：用户可能只想暂时收起主窗口，悬浮窗口仍在使用中，
            // 直接 exit 会 kill sidecar 导致整个应用不可用。
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // 阻止默认关闭行为
                    api.prevent_close();
                    // 隐藏主窗口，应用继续运行（悬浮窗口 + sidecar 保活）
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}
