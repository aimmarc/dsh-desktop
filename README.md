# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装为真正的跨平台桌面应用：
一个图标，双击即用，托盘常驻，数据与网页版完全互通。

## 特性

- **跨平台**：Windows / macOS / Linux，同一套代码，三平台安装包
- **体积小巧**：Tauri 2 壳（系统 WebView，不内置 Chromium）+ 内置精简 Node 运行时
  + 平台裁剪后的 dsh 依赖（安装包目标 ~60MB 级，对比 Electron 方案小 60%+）
- **本地化**：界面跟随系统语言（中文/英文），全部数据存于本地 `~/.dsh`（`$DSH_HOME`）
- **托盘常驻**：关窗不退出，服务后台继续跑；托盘图标右键才是真正退出
- **进程守护**：服务意外退出自动重启；端口 3080 已有服务时直接复用，不重复启动
- **数据互通**：与网页版共用同一数据目录，随时切换

## 架构

```
┌─ Tauri 壳 (Rust, 系统 WebView) ─────────────────────────┐
│  本地启动页（加载中/出错/重试）                           │
│    └─ 就绪后跳转 → http://127.0.0.1:3080（真正界面）     │
│  服务管理器 (src-tauri/src/server.rs)                    │
│    定位内置 node → 探测 3080 → 拉起 `node launch.js web`  │
│    → 等待就绪 → 跳转 → 退出时清理进程树                   │
│  托盘与原生菜单 (src-tauri/src/menu.rs)                   │
└─────────────────────────┬───────────────────────────────┘
                          │ 拉起
              ┌───────────▼───────────┐
              │ dsh web 本地服务        │  数据 → ~/.dsh (DSH_HOME)
              │ (esbuild 打包/裁剪后)   │
              └───────────────────────┘
```

## 开发环境

- [Rust](https://rustup.rs/)（stable，Windows 需要 MSVC 工具链）
- Node.js >= 22
- WebView2 运行时（Windows 11 预装；Windows 10 多数预装）

## 开发

```bash
npm install
npm run prepare:runtime   # fetch node + pack dsh runtime into src-tauri/resources
npm run tauri dev         # 编译 Rust 壳并打开应用窗口
```

## 打包安装包

```bash
npm run bundle            # 完整流程：fetch-node → pack --minify → tauri build
```

产物在 `src-tauri/target/release/bundle/`：

| 平台 | 安装包 |
|---|---|
| Windows | `nsis/*.exe` |
| macOS | `dmg/*.dmg` |
| Linux | `deb/*.deb`、`appimage/*.AppImage` |

三平台安装包由 `.github/workflows/build.yml` 在打 tag 时自动构建（GitHub Actions）。

## 体积优化策略

为什么不做单文件 esbuild bundle：dsh 大量使用 `import.meta.url` / `createRequire`
定位运行时资源（前端 dist、agent presets、worker 脚本、package.json 版本号），
单文件打包会打断这些路径。正确做法是**保留 node_modules 目录结构**，然后：

1. 平台裁剪：只保留当前平台的 native 二进制（node-pty / sharp / koffi / …）
2. 删除调试符号（PDB）、source map、测试、文档、@types
3. 可选 `--minify`：esbuild 逐文件压缩 JS（保持路径与导出名）

参考体积（Windows x64，开发机实测）：

| 项 | 原始 | 裁剪后 |
|---|---|---|
| node_modules | ~280 MB | ~132 MB（含 minify） |
| Node 运行时 | — | ~83 MB（v22.23.2） |
| Tauri 壳 | — | ~10 MB（release） |
| **NSIS 安装包** | — | **42 MB**（实测） |

## 环境变量（覆盖项）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PORT` | 默认绑定端口（默认 `3080`） |
| `DSH_HOME` | 透传给服务端；harness 数据根目录（默认 `~/.dsh`） |

## 已知限制

- macOS 安装包未加入 Apple 开发者计划时，首次打开需在「系统设置 → 隐私与安全性」
  手动允许一次（社区方案同款体验）
- Linux 依赖 WebKitGTK（`libwebkit2gtk-4.1-0`）与 AppIndicator（`libayatana-appindicator3-1`）

## License

MIT（外壳部分；dsh 本体归 DeepSeek 官方所有）
