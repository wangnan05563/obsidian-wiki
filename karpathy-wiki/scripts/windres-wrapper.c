// windres-wrapper.c
// windres.exe wrapper — 解决 GNU windres 在中文路径下的编码问题
//
// Rust 的 Command::new("windres") 在 Windows 上只搜索 .exe 文件，
// 不搜索 .cmd/.bat，所以需要创建一个 .exe wrapper 来调用 PowerShell 脚本。
//
// 编译: gcc -o windres.exe windres-wrapper.c -lshlwapi
// 放在 PATH 最前面（在 w64devkit\bin 前面），让 embed-resource 找到此 wrapper

#include <stdlib.h>
#include <string.h>
#include <process.h>
#include <windows.h>

int main(int argc, char *argv[]) {
    char *ps1 = getenv("WRAPPER_PS1");

    if (ps1 == NULL || ps1[0] == '\0') {
        // 环境变量未设置，直接调用真正的 windres（向后兼容）
        return _spawnvp(_P_WAIT, "windres-real.exe", (const char *const *)argv);
    }

    // 构建参数：powershell -ExecutionPolicy Bypass -File <ps1> [原参数...]
    // _spawnvp 期望 argv[0] 是程序名，实际参数从 argv[1] 开始
    char **new_argv = (char **)malloc((argc + 5) * sizeof(char *));
    if (new_argv == NULL) {
        return 1;
    }

    new_argv[0] = "powershell";
    new_argv[1] = "-ExecutionPolicy";
    new_argv[2] = "Bypass";
    new_argv[3] = "-File";
    new_argv[4] = ps1;

    // 复制原始参数（跳过 argv[0] 即程序名）
    for (int i = 1; i < argc; i++) {
        new_argv[4 + i] = argv[i];
    }
    new_argv[argc + 4] = NULL;

    int result = _spawnvp(_P_WAIT, "powershell.exe", (const char *const *)new_argv);
    free(new_argv);
    return result;
}
