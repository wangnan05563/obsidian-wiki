// main.rs — Tauri 主进程入口
// 为什么用 lib + bin 双入口：Tauri 2.x 的标准结构，lib.rs 供移动端复用
fn main() {
    karpathy_wiki_desktop_lib::run()
}
