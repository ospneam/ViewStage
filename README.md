# ViewStage

一个基于 Tauri 构建的轻量级桌面应用，采用原生 HTML、CSS 和 JavaScript 开发，提供简洁高效的视频/文档展示功能。

## 技术栈

- **前端**：Vanilla HTML 5 + CSS 3 + JavaScript（无框架依赖）
- **后端**：Rust + Tauri
- **构建工具**：Cargo

## 功能特点

- 🚀 **轻量高性能**：基于 Tauri 框架，应用体积小、启动快、内存占用低
- 🖥️ **跨平台支持**：可编译为 Windows、macOS、Linux 多平台安装包
- 🎨 **原生 UI 体验**：使用系统原生 WebView，提供流畅的桌面应用交互
- 📦 **开箱即用**：无复杂前端框架依赖，代码结构清晰易维护

## 快速开始

### 环境要求
- Node.js（推荐 20.x）
- Rust（稳定版）
- Tauri CLI

## 项目结构

```
ViewStage/
├── .github/workflows/    # GitHub Actions 自动编译配置
├── src-tauri/            # Tauri Rust 后端代码
│   ├── src/              # Rust 源码
│   ├── Cargo.toml        # Rust 依赖配置
│   └── Cargo.lock        # Rust 依赖锁定文件
├── src/                  # 前端代码
│   ├── assets/           # 静态资源（图片、脚本等）
│   └── ...               # HTML/CSS/JS 文件
├── .gitignore            # Git 忽略文件
├── LICENSE               # 许可证
└── README.md             # 项目说明
```
## 许可证

本项目采用开源许可证，详见 [LICENSE](https://github.com/ospneam/ViewStage/blob/main/LICENSE) 文件。