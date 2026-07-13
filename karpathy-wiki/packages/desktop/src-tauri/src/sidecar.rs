// sidecar.rs — Node.js 后端子进程管理
//
// 为什么用 PID 而非 Child 句柄：Tauri State 要求 Send + Sync，
// std::process::Child 在 Windows 上不是 Send，无法被 app.manage() 管理。
// 改为只存 PID，kill 时通过 taskkill 终止进程树。

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Sidecar {
    // 为什么用 Mutex<Option<u32>>：存 PID 而非 Child，
    // u32 是 Send + Sync，可被 Tauri State 管理
    pid: Mutex<Option<u32>>,
}

impl Sidecar {
    pub fn new() -> Self {
        Self {
            pid: Mutex::new(None),
        }
    }

    // 启动 Node.js 后端子进程
    // 开发模式：pnpm run dev:api（tsx watch）
    // 打包模式：sidecar exe（karpathy-wiki.exe）
    pub fn spawn(&self) -> Result<(), String> {
        let mut cmd = if cfg!(debug_assertions) {
            // 开发模式：通过 pnpm run dev:api 启动 tsx watch
            // 为什么用 cmd /C：Rust 的 Command::new 在 Windows 上用 CreateProcessW，
            // 只搜索 .exe 文件，不搜索 .cmd/.bat。pnpm 是 pnpm.cmd 脚本，必须通过 cmd.exe 调用。
            let mut c = Command::new("cmd");
            c.args(["/C", "pnpm", "run", "dev:api"]);
            // 为什么设置 current_dir：tauri dev 在 packages/desktop/src-tauri 运行，
            // 但 dev:api 脚本在仓库根目录（src-tauri 上两层），必须切换才能找到 package.json
            let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|p| p.parent())
                .ok_or("无法获取仓库根目录")?;
            c.current_dir(repo_root);
            c
        } else {
            // 打包模式：运行同目录下的 karpathy-wiki.exe
            let exe_dir = std::env::current_exe()
                .map_err(|e| format!("无法获取 exe 路径: {}", e))?;
            let exe_dir = exe_dir.parent()
                .ok_or("无法获取 exe 目录")?;
            let backend_exe = exe_dir.join("karpathy-wiki.exe");
            if !backend_exe.exists() {
                return Err(format!("后端 exe 不存在: {}", backend_exe.display()));
            }
            Command::new(&backend_exe)
        };

        // 子进程的 stdout/stderr 继承到主进程，便于调试
        cmd.stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .stdin(Stdio::null());

        let child = cmd.spawn().map_err(|e| {
            format!("启动后端子进程失败: {}。请确认 Node.js 已安装且在 PATH 中。", e)
        })?;

        let pid = child.id();
        // 为什么放弃 Child 句柄：避免持有非 Send 类型
        // 子进程变成孤儿由 PID 追踪，kill 时用 taskkill /T 终止整个进程树
        *self.pid.lock().unwrap() = Some(pid);
        // 为什么必须 detach：不调用 wait() 会导致僵尸进程，
        // 但我们放弃 Child 句柄，这里不做 wait，子进程独立运行
        std::mem::forget(child);

        Ok(())
    }

    // 等待后端 HTTP 服务就绪（轮询 TCP 端口连通性）
    // 超时 30 秒，避免无限等待
    // 为什么用 TcpStream 而非 reqwest：避免引入 reqwest/hyper 整条 HTTP 客户端依赖链，
    // 端口可连接即代表 HTTP 服务已监听，无需发送完整 HTTP 请求
    pub fn wait_for_ready(&self, port: u16) -> Result<(), String> {
        let addr = format!("127.0.0.1:{}", port);
        let start = Instant::now();
        let timeout = Duration::from_secs(30);

        while start.elapsed() < timeout {
            if std::net::TcpStream::connect_timeout(
                &addr.parse().map_err(|e| format!("地址解析失败: {}", e))?,
                Duration::from_secs(2),
            ).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }

        Err(format!(
            "后端服务在 30 秒内未就绪（{} 未监听）",
            addr
        ))
    }

    // 停止后端子进程
    pub fn kill(&self) {
        if let Some(pid) = self.pid.lock().unwrap().take() {
            // Windows 用 taskkill /T /F 终止进程树
            // 为什么用 /T：子进程（tsx/node）需要一起终止
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .output();
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}
