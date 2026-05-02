<div align="center">
   <img src="https://github.com/ospneam/ViewStage/blob/main/src-tauri/icons/Square1024x1024Logo.png" width=15%>
   <h1>ViewStage</h1>
   <p>一个基于 Tauri 构建的摄像头及PDF展台应用，采用原生 HTML、CSS 和 JavaScript 开发，提供简洁高效的课堂及其他用途的全屏展台。</p>
</div>

## 技术栈

- **前端**：Vanilla HTML 5 + CSS 3 + JavaScript
- **后端**：Rust + Tauri
- **构建工具**：Cargo

> \[!IMPORTANT]
> 这个应用部分使用了Tare编写与进行性能优化、检测代码问题
>
> > 若您介意或排斥，请无视次项目，感谢(❁´◡\`❁)

## 功能特点

- 🚀 **轻量高性能**：基于 Tauri 框架，应用体积小、启动快、内存占用低
- 🎨 **原生 UI 体验**：使用系统原生 WebView，提供流畅的桌面应用交互
- 📦 **开箱即用**：无复杂前端框架依赖，代码结构清晰易维护
- 🔧 **高度可配置**：支持自定义配置，包括但不限于摄像头选择、PDF文件关联等
- 🌈 **多颜色笔**：提供15种颜色的笔，可在设置中自定义添加或删除
- 🖊 **大小无极调节**：支持批注大小1-20px无级调节，橡皮1-50px无级调节
- 🔍 **实时预览**：在设置中可以开启实时预览，方便查看摄像头画面
- 📁 **多文档格式支持**：支持打开.pdf/.docx/.doc/等格式的文档 \[若需要打开Word文档，系统中必须安装有Microsoft Office或WPS Office]

## 运行条件

- 推荐操作系统：Windows10以上系统

- 1、在系统中必须安装有WebView2运行时，若未安装，请前往[Microsoft Edge WebView2 运行时](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section)下载并安装最新版

## 开发环境要求

- Node.js（推荐 20.x）
- Rust（稳定版）
- Tauri CLI

## 项目进展

- ✅批注
- ✅触控
- ✅PDF、Word打开
- ✅允许PDF/.docx/.doc格式的文档以ViewStage为默认打开程序
- ✅允许从外部导入图片
- ✅图标完善（采用icons.bootcss.com中的图标，在此表示感谢(*^\_^*)）
- ✅设置
- ✅笔颜色（目前支持存储15中颜色）
- ✅多语言
- ❎支持手机作为信号源
- ❎支持手机上传图片及文件
- ⛏️OCR文档增强（目前仍然有小问题未解决）
- ❓更多功能(欢迎到issues提交(*^\_^*))

## 许可证

本项目采用开源许可证，详见 [LICENSE](https://github.com/ospneam/ViewStage/blob/main/LICENSE) 文件。
