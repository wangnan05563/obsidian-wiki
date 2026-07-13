fn main() {
    // 显式声明应用自定义命令到 ACL manifest。
    // 为什么需要：Tauri 2.x 在 debug_assertions 下默认不自动注册应用命令到 allowed_commands，
    // 会导致 invoke('command') 返回 "Plugin not found" 错误。
    // 通过 AppManifest::commands 显式列出，触发 tauri-build 把命令包含到 manifest。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["toggle_floating_size"])),
    )
    .expect("failed to run tauri-build");
}
