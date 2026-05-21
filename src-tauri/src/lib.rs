//! ViewStage - 图像处理 Rust 后端
//! 
//! 功能模块：
//! - 图像旋转 (image_update_rotation): 90/180/270度旋转
//! - 图片保存 (image_save_file): 保存到指定目录
//! - 笔画压缩 (stroke_format_compact): 将笔画渲染到图片
//! - 设置管理 (get_settings, save_settings): 应用配置持久化
//!
//! 性能优化：
//! - 使用 rayon 并行处理像素
//! - 使用 base64 编码传输数据
//! - 使用 image 库进行图像处理

use tauri::{Manager, Emitter};
use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use base64::{Engine as _, engine::general_purpose};
use zip::ZipArchive;
use std::io::{Read, Write};

mod image_processing;

use image_processing::{
    image_load_base64, image_fetch_base64_data,
    image_update_rotation,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;



use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ==================== 数据结构 ====================
// 用于前后端通信的结构体定义

/// 图片保存结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSaveResult {
    pub path: String,                    // 保存路径
    pub success: bool,                   // 是否成功
    pub error: Option<String>,           // 错误信息
    pub enhanced_data: Option<String>,   // 增强后的图片数据 (base64)
}

/// 笔画点 (线段)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrokePoint {
    pub from_x: f32,
    pub from_y: f32,
    pub to_x: f32,
    pub to_y: f32,
}

/// 笔画 (绘制或擦除)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stroke {
    #[serde(rename = "type")]
    pub stroke_type: String,            // "draw" 或 "erase"
    pub points: Vec<StrokePoint>,       // 线段点集合
    pub color: Option<String>,          // 颜色 (#RRGGBB)
    pub line_width: Option<u32>,        // 线宽
    pub eraser_size: Option<u32>,       // 橡皮大小
}

/// 笔画压缩请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactStrokesRequest {
    pub base_image: Option<String>,     // 基础图片 (base64)
    pub strokes: Vec<Stroke>,           // 待压缩笔画
    pub canvas_width: u32,              // 画布宽度
    pub canvas_height: u32,             // 画布高度
}

// ==================== 系统目录 ====================
// 获取应用缓存目录、配置目录、ViewStage目录

/// 获取应用缓存目录
#[tauri::command]
fn dir_fetch_cache(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let cache_dir = config_dir.join("cache");
    
    if !cache_dir.exists() {
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }
    
    Ok(cache_dir.to_string_lossy().to_string())
}

/// 获取缓存大小
#[tauri::command]
fn cache_fetch_size(app: tauri::AppHandle) -> Result<u64, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let cache_dir = config_dir.join("cache");
    
    if !cache_dir.exists() {
        return Ok(0);
    }
    
    fn directory_calc_size(path: &std::path::Path) -> u64 {
        let mut size = 0;
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        size += directory_calc_size(&path);
                    } else {
                        size += entry.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
        }
        size
    }
    
    Ok(directory_calc_size(&cache_dir))
}

/// 清除缓存
#[tauri::command]
fn cache_delete_all(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let cache_dir = config_dir.join("cache");
    
    if !cache_dir.exists() {
        return Ok("缓存目录不存在".to_string());
    }
    
    fn directory_delete_contents(path: &std::path::Path) -> (u64, u32) {
        let mut size = 0u64;
        let mut count = 0u32;
        
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.is_dir() {
                    let (s, c) = directory_delete_contents(&entry_path);
                    size += s;
                    count += c;
                    let _ = std::fs::remove_dir(&entry_path);
                } else {
                    size += entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if std::fs::remove_file(&entry_path).is_ok() {
                        count += 1;
                    }
                }
            }
        }
        (size, count)
    }
    
    let (cleared_size, cleared_files) = directory_delete_contents(&cache_dir);
    
    log::info!("清除缓存: {} 字节, {} 个文件", cleared_size, cleared_files);
    
    Ok(format!("已清除 {} 个文件，共 {:.2} MB", cleared_files, cleared_size as f64 / 1024.0 / 1024.0))
}

/// 检查并执行自动清除缓存
#[tauri::command]
fn cache_validate_auto_clear(app: tauri::AppHandle) -> Result<bool, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let config_file = config_dir.join("config.json");
    
    if !config_file.exists() {
        return Ok(false);
    }
    
    let config_content = std::fs::read_to_string(&config_file)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    
    let config: serde_json::Value = serde_json::from_str(&config_content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;
    
    let auto_clear_days = config.get("autoClearCacheDays")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    
    if auto_clear_days == 0 {
        log::info!("自动清除缓存已关闭");
        return Ok(false);
    }
    
    let last_clear_date = config.get("lastCacheClearDate")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    
    if last_clear_date == today {
        log::info!("今日已执行过自动清除缓存");
        return Ok(false);
    }
    
    if last_clear_date.is_empty() {
        let mut updated_config = config.clone();
        updated_config["lastCacheClearDate"] = serde_json::json!(today);
        let updated_content = serde_json::to_string_pretty(&updated_config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&config_file, updated_content)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        log::info!("首次设置自动清除缓存日期");
        return Ok(false);
    }
    
    let last_date = chrono::NaiveDate::parse_from_str(last_clear_date, "%Y-%m-%d")
        .map_err(|e| format!("Failed to parse last clear date: {}", e))?;
    let today_date = chrono::Local::now().date_naive();
    
    let days_since_last_clear = (today_date - last_date).num_days();
    
    if days_since_last_clear >= auto_clear_days as i64 {
        log::info!("执行自动清除缓存，距上次清除 {} 天", days_since_last_clear);
        
        let cache_dir = config_dir.join("cache");
        
        if cache_dir.exists() {
            fn directory_delete_contents(path: &std::path::Path) {
                if let Ok(entries) = std::fs::read_dir(path) {
                    for entry in entries.flatten() {
                        let entry_path = entry.path();
                        if entry_path.is_dir() {
                            directory_delete_contents(&entry_path);
                            let _ = std::fs::remove_dir(&entry_path);
                        } else {
                            let _ = std::fs::remove_file(&entry_path);
                        }
                    }
                }
            }
            directory_delete_contents(&cache_dir);
        }
        
        let mut updated_config = config.clone();
        updated_config["lastCacheClearDate"] = serde_json::json!(today);
        let updated_content = serde_json::to_string_pretty(&updated_config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&config_file, updated_content)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        
        log::info!("自动清除缓存完成");
        return Ok(true);
    }
    
    Ok(false)
}

/// 获取应用配置目录
#[tauri::command]
fn dir_fetch_config(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    
    Ok(config_dir.to_string_lossy().to_string())
}

/// 获取图片保存目录 (~/Pictures/ViewStage)
#[tauri::command]
fn dir_fetch_pictures_viewstage() -> Result<String, String> {
    let pictures_dir = dirs::picture_dir()
        .ok_or("Failed to get pictures directory")?;
    
    let cds_dir = pictures_dir.join("ViewStage");
    
    if !cds_dir.exists() {
        std::fs::create_dir_all(&cds_dir)
            .map_err(|e| format!("Failed to create ViewStage dir: {}", e))?;
    }
    
    Ok(cds_dir.to_string_lossy().to_string())
}

/// 获取用户主题目录 (%APPDATA%/SECTL/ViewStage/themes)
#[tauri::command]
fn dir_fetch_theme(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let theme_dir = config_dir.join("themes");
    
    if !theme_dir.exists() {
        std::fs::create_dir_all(&theme_dir)
            .map_err(|e| format!("Failed to create theme dir: {}", e))?;
    }
    
    Ok(theme_dir.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct ThemeInfo {
    name: String,
    display_name: String,
    canvas_bg: String,
    text_color: String,
}

/// 获取用户主题目录下所有已安装的主题信息
#[tauri::command]
fn theme_list_user(app: tauri::AppHandle) -> Result<Vec<ThemeInfo>, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    let theme_dir = config_dir.join("themes");

    if !theme_dir.exists() {
        return Ok(Vec::new());
    }

    let mut themes = Vec::new();
    let entries = std::fs::read_dir(&theme_dir)
        .map_err(|e| format!("Failed to read theme dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // 优先从 config.json 读取身份信息，回退到 theme.json
        let identity_paths = [path.join("config.json"), path.join("theme.json")];
        let mut found = false;

        for identity_path in &identity_paths {
            if identity_path.exists() {
                let content = match std::fs::read_to_string(identity_path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let json: serde_json::Value = match serde_json::from_str(&content) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let pkg = json["packageName"].as_str().filter(|s| !s.is_empty());
                let disp = json["displayName"].as_str().filter(|s| !s.is_empty());
                let theme_name = pkg.unwrap_or(&dir_name);

                // 读取 theme.json 获取预览颜色
                let theme_json_path = path.join("theme.json");
                let (canvas_bg, text_color) = if theme_json_path.exists() {
                    if let Ok(tc) = std::fs::read_to_string(&theme_json_path) {
                        if let Ok(tj) = serde_json::from_str::<serde_json::Value>(&tc) {
                            let bg = tj["canvasBgColor"].as_str().unwrap_or("#1a1a1a").to_string();
                            let txt = tj["noCameraMessage"]["textColor"].as_str().unwrap_or("#ffffff").to_string();
                            (bg, txt)
                        } else {
                            ("#1a1a1a".to_string(), "#ffffff".to_string())
                        }
                    } else {
                        ("#1a1a1a".to_string(), "#ffffff".to_string())
                    }
                } else {
                    ("#1a1a1a".to_string(), "#ffffff".to_string())
                };

                themes.push(ThemeInfo {
                    name: theme_name.to_string(),
                    display_name: disp.unwrap_or(theme_name).to_string(),
                    canvas_bg,
                    text_color,
                });
                found = true;
                break;
            }
        }

        if !found {
            // 没有身份文件，仍然使用目录名
            let (canvas_bg, text_color) = if path.join("theme.json").exists() {
                if let Ok(tc) = std::fs::read_to_string(path.join("theme.json")) {
                    if let Ok(tj) = serde_json::from_str::<serde_json::Value>(&tc) {
                        let bg = tj["canvasBgColor"].as_str().unwrap_or("#1a1a1a").to_string();
                        let txt = tj["noCameraMessage"]["textColor"].as_str().unwrap_or("#ffffff").to_string();
                        (bg, txt)
                    } else {
                        ("#1a1a1a".to_string(), "#ffffff".to_string())
                    }
                } else {
                    ("#1a1a1a".to_string(), "#ffffff".to_string())
                }
            } else {
                ("#1a1a1a".to_string(), "#ffffff".to_string())
            };
            themes.push(ThemeInfo {
                name: dir_name.clone(),
                display_name: dir_name,
                canvas_bg,
                text_color,
            });
        }
    }

    themes.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(themes)
}

/// 删除用户安装的主题
#[tauri::command]
fn theme_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if name.is_empty() {
        return Err("Theme name cannot be empty".to_string());
    }

    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    let theme_base = config_dir.join("themes");

    // 规范化路径防止路径遍历
    let theme_base_canonical = std::fs::canonicalize(&theme_base)
        .map_err(|_| "Themes directory not found".to_string())?;
    let theme_dir = theme_base.join(&name);
    let theme_dir_canonical = std::fs::canonicalize(&theme_dir)
        .map_err(|_| format!("Theme '{}' not found", name))?;

    if !theme_dir_canonical.starts_with(&theme_base_canonical) {
        return Err("Invalid theme name".to_string());
    }

    // 确保不是内置主题（内置主题不在 themes/ 目录下，此检查为安全兜底）
    if !theme_dir_canonical.join("theme.json").exists() && !theme_dir_canonical.join("config.json").exists() {
        return Err(format!("'{}' is not a valid user theme", name));
    }

    std::fs::remove_dir_all(&theme_dir_canonical)
        .map_err(|e| format!("Failed to delete theme '{}': {}", name, e))?;

    log::info!("Theme '{}' deleted", name);
    Ok(())
}

/// 在 ZIP 中查找文件条目的索引（忽略路径前缀）
fn zip_find_entry(archive: &mut ZipArchive<std::fs::File>, target: &str) -> Option<usize> {
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().replace('\\', "/");
            if name.ends_with(target) && (name == target || name.ends_with(&format!("/{}", target))) {
                return Some(i);
            }
        }
    }
    None
}

/// 从 ZIP 中读取文本文件内容（按文件名查找）
fn zip_read_text(archive: &mut ZipArchive<std::fs::File>, target: &str) -> Result<String, String> {
    let idx = zip_find_entry(archive, target)
        .ok_or_else(|| format!("Missing {} in .vst file", target))?;
    let mut entry = archive.by_index(idx)
        .map_err(|e| format!("Failed to read {}: {}", target, e))?;
    let mut content = String::new();
    entry.read_to_string(&mut content)
        .map_err(|e| format!("Failed to read {}: {}", target, e))?;
    Ok(content)
}

/// 从 .vst 文件导入主题
/// .vst 是一个重命名的 ZIP 压缩包，包含 theme.json, config.json, theme.css 等文件
/// force=true 时允许覆盖已存在的主题
#[tauri::command]
fn theme_import_vst(app: tauri::AppHandle, file_path: String, force: Option<bool>) -> Result<ThemeInfo, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    let theme_base = config_dir.join("themes");

    if !theme_base.exists() {
        std::fs::create_dir_all(&theme_base)
            .map_err(|e| format!("Failed to create theme dir: {}", e))?;
    }

    // 打开 .vst 文件（ZIP 格式）
    let file = std::fs::File::open(&file_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Invalid .vst file: {}", e))?;

    // 检测 ZIP 中是否包含公共根目录
    let common_prefix = {
        let mut names = Vec::new();
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                if !entry.is_dir() {
                    names.push(entry.name().replace('\\', "/").to_string());
                }
            }
        }

        if names.is_empty() {
            return Err("Empty .vst file".to_string());
        }

        // 找公共前缀（所有路径都包含的顶层目录）
        let first = names[0].clone();
        let prefix = first.find('/').map(|i| &first[..=i]).unwrap_or("");
        if !prefix.is_empty() && names.iter().all(|n| n.starts_with(prefix)) {
            prefix.to_string()
        } else {
            String::new()
        }
    };

    // 用灵活查找校验必需文件
    if zip_find_entry(&mut archive, "theme.json").is_none() {
        return Err("Missing theme.json in .vst file (visual config)".to_string());
    }
    if zip_find_entry(&mut archive, "config.json").is_none() {
        return Err("Missing config.json in .vst file (identity)".to_string());
    }
    if zip_find_entry(&mut archive, "theme.css").is_none() {
        return Err("Missing theme.css in .vst file".to_string());
    }

    // 读取并解析 config.json（身份信息）
    let config_json_content = zip_read_text(&mut archive, "config.json")?;
    let config_json: serde_json::Value = serde_json::from_str(&config_json_content)
        .map_err(|e| format!("Invalid config.json: {}", e))?;

    let _theme_name = config_json["name"]
        .as_str()
        .ok_or_else(|| "config.json: 'name' is required (string)".to_string())?;

    let package_name = config_json["packageName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "config.json: 'packageName' is required (non-empty string)".to_string())?;

    if !package_name.chars().all(|c| c.is_ascii_lowercase() || c == '.' || c == '_')
        || package_name.starts_with('.')
        || package_name.ends_with('.')
        || !package_name.contains('.')
    {
        return Err("config.json: 'packageName' must be a reverse-domain name, e.g. com.example.mytheme".to_string());
    }

    let display_name = config_json["displayName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "config.json: 'displayName' is required (non-empty string)".to_string())?;

    // 读取并解析 theme.json（视觉配置）
    let theme_json_content = zip_read_text(&mut archive, "theme.json")?;
    let theme_json: serde_json::Value = serde_json::from_str(&theme_json_content)
        .map_err(|e| format!("Invalid theme.json: {}", e))?;

    // 校验 theme.json 字段
    if theme_json["showToolbarText"].as_bool().is_none() {
        return Err("theme.json: 'showToolbarText' is required (bool)".to_string());
    }

    if theme_json["showAuroraEffect"].as_bool().is_none() {
        return Err("theme.json: 'showAuroraEffect' is required (bool)".to_string());
    }

    {
        let bg = theme_json["canvasBgColor"].as_str().filter(|s| !s.is_empty());
        if bg.is_none() {
            return Err("theme.json: 'canvasBgColor' is required (non-empty string)".to_string());
        }
    }

    {
        let no_cam = theme_json.get("noCameraMessage")
            .and_then(|v| v.as_object())
            .ok_or_else(|| "theme.json: 'noCameraMessage' is required (object)".to_string())?;

        for key in &["textColor", "secondaryTextColor", "tertiaryTextColor", "textShadow"] {
            if !no_cam.contains_key(*key) {
                return Err(format!("theme.json: 'noCameraMessage.{}' is required", key));
            }
        }
    }

    // 校验 icons 字段并验证 SVG 文件存在
    let icons = theme_json.get("icons")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "theme.json: 'icons' is required (object)".to_string())?;

    let required_icons = [
        "menu", "minimize", "move", "pen", "eraser", "undo", "clear",
        "camera", "camera-fill", "settings", "image", "file", "folder",
        "close", "collapse", "addFile", "word", "pdf", "scan",
        "app-settings", "doc-scan", "canvas", "source", "theme-icon", "about"
    ];

    for key in &required_icons {
        if !icons.contains_key(*key) {
            return Err(format!("theme.json: 'icons.{}' is required", key));
        }
    }

    // 验证图标 SVG 文件存在（不强制，仅警告）
    for (_key, val) in icons.iter() {
        if let Some(icon_name) = val.as_str() {
            let svg_path = format!("icons/{}.svg", icon_name);
            if zip_find_entry(&mut archive, &svg_path).is_none() {
                log::warn!("Icon file 'icons/{}.svg' referenced in theme.json but not found in .vst", icon_name);
            }
        }
    }

    // 检查是否已存在，根据 force 决定是否覆盖
    let target_dir = theme_base.join(package_name);
    if target_dir.exists() {
        if force.unwrap_or(false) {
            std::fs::remove_dir_all(&target_dir)
                .map_err(|e| format!("Failed to remove existing theme '{}': {}", package_name, e))?;
        } else {
            return Err(format!("Theme '{}' already exists", package_name));
        }
    }

    // 解压所有文件，去除公共前缀
    let prefix_len = common_prefix.len();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

        if entry.is_dir() {
            continue;
        }

        let entry_name = entry.name().replace('\\', "/");
        let relative = if prefix_len > 0 && entry_name.starts_with(&common_prefix) {
            entry_name[prefix_len..].to_string()
        } else {
            entry_name.clone()
        };

        let target_path = target_dir.join(&relative);

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
        }

        let mut buffer = Vec::new();
        entry.read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read entry '{}': {}", entry_name, e))?;

        let mut out_file = std::fs::File::create(&target_path)
            .map_err(|e| format!("Failed to create file {:?}: {}", target_path, e))?;
        out_file.write_all(&buffer)
            .map_err(|e| format!("Failed to write file {:?}: {}", target_path, e))?;
    }

    log::info!("Theme imported successfully: packageName='{}', displayName='{}'", package_name, display_name);

    let canvas_bg = theme_json["canvasBgColor"].as_str().unwrap_or("#1a1a1a").to_string();
    let text_color = theme_json["noCameraMessage"]["textColor"].as_str().unwrap_or("#ffffff").to_string();

    Ok(ThemeInfo {
        name: package_name.to_string(),
        display_name: display_name.to_string(),
        canvas_bg,
        text_color,
    })
}

/// 获取用户主题的预览图片（Base64 编码）
#[tauri::command]
fn theme_get_preview(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    let preview_path = config_dir.join("themes").join(&name).join("preview.png");

    if !preview_path.exists() {
        return Ok(None);
    }

    let bytes = std::fs::read(&preview_path)
        .map_err(|e| format!("Failed to read preview: {}", e))?;
    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:image/png;base64,{}", b64)))
}

// ==================== 图片保存 ====================

/// 生成保存路径
/// - 按日期创建子目录: YYYY-MM-DD
/// - 文件名格式: {prefix}_HH-MM-SS-SSS.{extension}
fn path_calc_save(base_dir: &str, prefix: &str, extension: &str) -> Result<(PathBuf, String), String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d").to_string();
    let time_str = now.format("%H-%M-%S").to_string();
    
    let date_dir = PathBuf::from(base_dir).join(&date_str);
    
    if !date_dir.exists() {
        std::fs::create_dir_all(&date_dir)
            .map_err(|e| format!("Failed to create date directory: {}", e))?;
    }
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .subsec_millis();
    
    let file_name = format!("{}_{}-{:03}.{}", prefix, time_str, timestamp, extension);
    let file_path = date_dir.join(&file_name);
    
    Ok((file_path, file_name))
}

fn string_format_prefix(prefix: &str) -> String {
    let sanitized: String = prefix
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if sanitized.is_empty() { "photo".to_string() } else { sanitized }
}

#[tauri::command]
fn image_save_file(image_data: String, prefix: Option<String>) -> Result<ImageSaveResult, String> {
    let base_dir = dir_fetch_pictures_viewstage()?;
    let prefix_str = string_format_prefix(&prefix.unwrap_or_else(|| "photo".to_string()));

    let decoded = image_fetch_base64_data(&image_data)?;

    let extension = if image_data.contains("image/png") {
        "png"
    } else if image_data.contains("image/jpeg") || image_data.contains("image/jpg") {
        "jpg"
    } else {
        "png"
    };

    let (file_path, _file_name) = path_calc_save(&base_dir, &prefix_str, extension)?;
    
    std::fs::write(&file_path, &decoded)
        .map_err(|e| format!("Failed to write image file: {}", e))?;
    
    Ok(ImageSaveResult {
        path: file_path.to_string_lossy().to_string(),
        success: true,
        error: None,
        enhanced_data: None,
    })
}

// ==================== 笔画压缩 ====================
// 将笔画渲染到图片，用于撤销功能

/// 解析颜色字符串为 RGBA
/// 支持格式: #RRGGBB 或 #RRGGBBAA
fn color_calc_from_hex(color_str: &str) -> Result<Rgba<u8>, String> {
    if !color_str.starts_with('#') {
        return Err(format!("Invalid color format: must start with '#', got: {}", color_str));
    }
    
    match color_str.len() {
        7 => {
            let r = u8::from_str_radix(&color_str[1..3], 16)
                .map_err(|_| format!("Invalid red component in color: {}", color_str))?;
            let g = u8::from_str_radix(&color_str[3..5], 16)
                .map_err(|_| format!("Invalid green component in color: {}", color_str))?;
            let b = u8::from_str_radix(&color_str[5..7], 16)
                .map_err(|_| format!("Invalid blue component in color: {}", color_str))?;
            Ok(Rgba([r, g, b, 255]))
        }
        9 => {
            let r = u8::from_str_radix(&color_str[1..3], 16)
                .map_err(|_| format!("Invalid red component in color: {}", color_str))?;
            let g = u8::from_str_radix(&color_str[3..5], 16)
                .map_err(|_| format!("Invalid green component in color: {}", color_str))?;
            let b = u8::from_str_radix(&color_str[5..7], 16)
                .map_err(|_| format!("Invalid blue component in color: {}", color_str))?;
            let a = u8::from_str_radix(&color_str[7..9], 16)
                .map_err(|_| format!("Invalid alpha component in color: {}", color_str))?;
            Ok(Rgba([r, g, b, a]))
        }
        _ => Err(format!("Invalid color format: expected #RRGGBB or #RRGGBBAA, got: {}", color_str))
    }
}

const DEFAULT_COLOR: Rgba<u8> = Rgba([52, 152, 219, 255]);

fn canvas_render_line(canvas: &mut RgbaImage, x1: i32, y1: i32, x2: i32, y2: i32, color: Rgba<u8>, width: u32) {
    let dx = (x2 - x1).abs();
    let dy = (y2 - y1).abs();
    let sx = if x1 < x2 { 1 } else { -1 };
    let sy = if y1 < y2 { 1 } else { -1 };
    let mut err = dx - dy;
    let mut x = x1;
    let mut y = y1;
    
    let half_width = (width / 2) as i32;
    
    loop {
        for wx in -half_width..=half_width {
            for wy in -half_width..=half_width {
                let px = x + wx;
                let py = y + wy;
                if px >= 0 && py >= 0 && (px as u32) < canvas.width() && (py as u32) < canvas.height() {
                    let dist = ((wx * wx + wy * wy) as f32).sqrt();
                    if dist <= half_width as f32 {
                        let pixel = canvas.get_pixel_mut(px as u32, py as u32);
                        if color[3] == 255 {
                            *pixel = color;
                        } else {
                            let alpha = color[3] as f32 / 255.0;
                            let inv_alpha = 1.0 - alpha;
                            pixel[0] = (color[0] as f32 * alpha + pixel[0] as f32 * inv_alpha) as u8;
                            pixel[1] = (color[1] as f32 * alpha + pixel[1] as f32 * inv_alpha) as u8;
                            pixel[2] = (color[2] as f32 * alpha + pixel[2] as f32 * inv_alpha) as u8;
                        }
                    }
                }
            }
        }
        
        if x == x2 && y == y2 {
            break;
        }
        
        let e2 = 2 * err;
        if e2 > -dy {
            err -= dy;
            x += sx;
        }
        if e2 < dx {
            err += dx;
            y += sy;
        }
    }
}

fn canvas_delete_line(canvas: &mut RgbaImage, x1: i32, y1: i32, x2: i32, y2: i32, width: u32) {
    let dx = (x2 - x1).abs();
    let dy = (y2 - y1).abs();
    let sx = if x1 < x2 { 1 } else { -1 };
    let sy = if y1 < y2 { 1 } else { -1 };
    let mut err = dx - dy;
    let mut x = x1;
    let mut y = y1;
    
    let half_width = (width / 2) as i32;
    
    loop {
        for wx in -half_width..=half_width {
            for wy in -half_width..=half_width {
                let px = x + wx;
                let py = y + wy;
                if px >= 0 && py >= 0 && (px as u32) < canvas.width() && (py as u32) < canvas.height() {
                    let dist = ((wx * wx + wy * wy) as f32).sqrt();
                    if dist <= half_width as f32 {
                        let pixel = canvas.get_pixel_mut(px as u32, py as u32);
                        pixel[3] = 0;
                    }
                }
            }
        }
        
        if x == x2 && y == y2 {
            break;
        }
        
        let e2 = 2 * err;
        if e2 > -dy {
            err -= dy;
            x += sx;
        }
        if e2 < dx {
            err += dx;
            y += sy;
        }
    }
}

#[tauri::command]
fn stroke_format_compact(request: CompactStrokesRequest) -> Result<String, String> {
    let mut canvas: RgbaImage = ImageBuffer::new(request.canvas_width, request.canvas_height);
    
    for pixel in canvas.pixels_mut() {
        *pixel = Rgba([0, 0, 0, 0]);
    }
    
    if let Some(base_image_data) = request.base_image {
        if let Ok(base_img) = image_load_base64(&base_image_data) {
            let base_rgba = base_img.to_rgba8();
            for (x, y, pixel) in base_rgba.enumerate_pixels() {
                if x < canvas.width() && y < canvas.height() {
                    canvas.put_pixel(x, y, *pixel);
                }
            }
        }
    }
    
    for stroke in &request.strokes {
        let points = &stroke.points;
        
        if stroke.stroke_type == "clear" {
            for pixel in canvas.pixels_mut() {
                *pixel = Rgba([0, 0, 0, 0]);
            }
            continue;
        }
        
        if points.is_empty() {
            continue;
        }
        
        if stroke.stroke_type == "draw" {
            let color = color_calc_from_hex(stroke.color.as_deref().unwrap_or("#3498db"))
                .unwrap_or(DEFAULT_COLOR);
            let line_width = stroke.line_width.unwrap_or(2);
            
            for point in points {
                canvas_render_line(
                    &mut canvas,
                    point.from_x as i32,
                    point.from_y as i32,
                    point.to_x as i32,
                    point.to_y as i32,
                    color,
                    line_width,
                );
            }
        } else if stroke.stroke_type == "erase" {
            let eraser_size = stroke.eraser_size.unwrap_or(15);
            
            for point in points {
                canvas_delete_line(
                    &mut canvas,
                    point.from_x as i32,
                    point.from_y as i32,
                    point.to_x as i32,
                    point.to_y as i32,
                    eraser_size,
                );
            }
        }
    }
    
    let mut buffer = Vec::new();
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode compacted image: {}", e))?;
    
    Ok(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&buffer)))
}

// ==================== 全局状态 ====================
// 镜像、增强等全局状态，使用原子类型保证线程安全

use std::sync::atomic::{AtomicBool, Ordering};

static MIRROR_STATE: AtomicBool = AtomicBool::new(false);
static OOBE_ACTIVE: AtomicBool = AtomicBool::new(false);
static MAIN_SCRIPT_LOADED: AtomicBool = AtomicBool::new(false);

// ==================== 设置窗口 ====================
// 打开设置窗口、状态同步

#[tauri::command]
async fn window_show_settings(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    
    if let Some(window) = app.get_webview_window("settings") {
        window.set_focus().map_err(|e| format!("Failed to focus settings window: {}", e))?;
        return Ok(());
    }
    
    let window = WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into())
    )
    .title("设置")
    .inner_size(600.0, 600.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .center()
    .build()
    .map_err(|e| format!("Failed to create settings window: {}", e))?;
    
    window.set_focus().map_err(|e| format!("Failed to focus new settings window: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn mirror_update_state(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    MIRROR_STATE.store(enabled, Ordering::SeqCst);
    let _ = app.emit("mirror-changed", enabled);
    Ok(())
}

#[tauri::command]
async fn mirror_fetch_state() -> Result<bool, String> {
    Ok(MIRROR_STATE.load(Ordering::SeqCst))
}

#[tauri::command]
fn app_fetch_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UpdateCheckResult {
    has_update: bool,
    current_version: String,
    latest_version: String,
    release: Option<GitHubRelease>,
    current_release: Option<GitHubRelease>,
}

fn version_calc_parse(version: &str) -> Option<(u32, u32, u32)> {
    let version = version.trim_start_matches('v');
    let parts: Vec<&str> = version.split('.').collect();
    
    if parts.len() >= 3 {
        let major = parts[0].parse::<u32>().ok()?;
        let minor = parts[1].parse::<u32>().ok()?;
        let patch = parts[2].parse::<u32>().ok()?;
        return Some((major, minor, patch));
    }
    None
}

fn version_validate_newer(current: &str, latest: &str) -> bool {
    let current_ver = version_calc_parse(current);
    let latest_ver = version_calc_parse(latest);
    
    match (current_ver, latest_ver) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

fn url_validate_github(url: &str) -> Result<(), String> {
    if url.starts_with("https://gh-proxy.com/") {
        let original_url = url.strip_prefix("https://gh-proxy.com/").unwrap_or(url);
        let parsed = url::Url::parse(original_url).map_err(|e| format!("Invalid URL: {}", e))?;
        let host = parsed.host_str().unwrap_or("");
        let valid_domains = ["github.com", "www.github.com", "api.github.com"];
        if !valid_domains.contains(&host) {
            return Err(format!("Invalid GitHub URL: unexpected domain {}", host));
        }
        return Ok(());
    }

    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    
    let valid_domains = ["github.com", "www.github.com", "api.github.com"];
    let host = parsed.host_str().unwrap_or("");
    
    if !valid_domains.contains(&host) {
        return Err(format!("Invalid GitHub URL: unexpected domain {}", host));
    }
    
    Ok(())
}

#[tauri::command]
async fn update_fetch_check() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    
    let client = reqwest::Client::builder()
        .user_agent("ViewStage")
        .timeout(std::time::Duration::from_secs(10))
        .https_only(true)
        .build()
        .map_err(|e| e.to_string())?;
    
    let response = client
        .get("https://api.github.com/repos/ospneam/ViewStage/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("GitHub API error: {}", response.status()));
    }
    
    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    if release.tag_name.is_empty() {
        return Err("Invalid release: empty tag name".to_string());
    }
    
    url_validate_github(&release.html_url)?;
    
    let latest_version = release.tag_name.trim_start_matches('v');
    let has_update = version_validate_newer(current_version, latest_version);
    
    let current_tag = format!("v{}", current_version);
    let current_release_response = client
        .get(&format!("https://api.github.com/repos/ospneam/ViewStage/releases/tags/{}", current_tag))
        .send()
        .await;
    
    let current_release = if current_release_response.is_ok() {
        let resp = current_release_response.unwrap();
        if resp.status().is_success() {
            resp.json::<GitHubRelease>().await.ok()
        } else {
            None
        }
    } else {
        None
    };
    
    Ok(UpdateCheckResult {
        has_update,
        current_version: current_version.to_string(),
        latest_version: latest_version.to_string(),
        release: if has_update { Some(release) } else { None },
        current_release,
    })
}

const CURRENT_CONFIG_VERSION: u32 = 2;

type MigrationFn = fn(&mut serde_json::Value) -> Result<(), String>;

fn migration_fetch_all() -> std::collections::HashMap<u32, MigrationFn> {
    let mut migrations: std::collections::HashMap<u32, MigrationFn> = std::collections::HashMap::new();
    
    migrations.insert(0u32, migration_v0_to_v1 as MigrationFn);
    migrations.insert(1u32, migration_v1_to_v2 as MigrationFn);
    
    migrations
}

fn migration_v0_to_v1(config: &mut serde_json::Value) -> Result<(), String> {
    log::info!("执行配置迁移: v0 -> v1");
    
    if let Some(obj) = config.as_object_mut() {
        if !obj.contains_key("theme") {
            obj.insert("theme".to_string(), serde_json::json!("simplify"));
            log::info!("添加字段: theme = simplify");
        }
        
        if !obj.contains_key("denoiseFrameCount") {
            obj.insert("denoiseFrameCount".to_string(), serde_json::json!(3));
            log::info!("添加字段: denoiseFrameCount = 3");
        }
        
        if !obj.contains_key("denoiseStrength") {
            obj.insert("denoiseStrength".to_string(), serde_json::json!("medium"));
            log::info!("添加字段: denoiseStrength = medium");
        }
        
        obj.insert("config_version".to_string(), serde_json::json!(1));
        log::info!("设置配置版本: config_version = 1");
    }
    
    Ok(())
}

fn migration_v1_to_v2(config: &mut serde_json::Value) -> Result<(), String> {
    log::info!("执行配置迁移: v1 -> v2");
    
    if let Some(obj) = config.as_object_mut() {
        if !obj.contains_key("penEffectMode") {
            obj.insert("penEffectMode".to_string(), serde_json::json!("limited"));
            log::info!("添加字段: penEffectMode = limited");
        }
        
        obj.insert("config_version".to_string(), serde_json::json!(2));
        log::info!("设置配置版本: config_version = 2");
    }
    
    Ok(())
}

fn config_backup_create(config_path: &std::path::Path, version: u32) -> Result<std::path::PathBuf, String> {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let backup_filename = format!("config.json.backup_v{}_{}", version, timestamp);
    let backup_path = config_path.parent().unwrap().join(backup_filename);
    
    std::fs::copy(config_path, &backup_path)
        .map_err(|e| format!("备份配置文件失败: {}", e))?;
    
    log::info!("配置已备份到: {:?}", backup_path);
    Ok(backup_path)
}

fn config_backup_cleanup_old(config_dir: &std::path::Path, keep_count: usize) {
    if let Ok(entries) = std::fs::read_dir(config_dir) {
        let mut backups: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.starts_with("config.json.backup_v")
            })
            .map(|e| e.path())
            .collect();
        
        backups.sort_by(|a, b| {
            let a_time = std::fs::metadata(a).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let b_time = std::fs::metadata(b).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            b_time.cmp(&a_time)
        });
        
        for old_backup in backups.iter().skip(keep_count) {
            if let Err(e) = std::fs::remove_file(old_backup) {
                log::warn!("删除旧备份失败 {:?}: {}", old_backup, e);
            } else {
                log::info!("删除旧备份: {:?}", old_backup);
            }
        }
    }
}

fn config_migrate_run(config: &mut serde_json::Value, migrations: &std::collections::HashMap<u32, MigrationFn>) -> Result<(), String> {
    let current_version = config
        .get("config_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    
    if current_version >= CURRENT_CONFIG_VERSION {
        log::info!("配置版本已是最新: v{}", current_version);
        return Ok(());
    }
    
    log::info!("开始配置迁移: v{} -> v{}", current_version, CURRENT_CONFIG_VERSION);
    
    let mut version = current_version;
    while version < CURRENT_CONFIG_VERSION {
        if let Some(migration_fn) = migrations.get(&version) {
            migration_fn(config)?;
        }
        version += 1;
    }
    
    log::info!("配置迁移完成: v{} -> v{}", current_version, CURRENT_CONFIG_VERSION);
    Ok(())
}

fn config_fetch_default() -> serde_json::Value {
    serde_json::json!({
        "config_version": CURRENT_CONFIG_VERSION,
        "width": 1920,
        "height": 1080,
        "language": "zh-CN",
        "defaultCamera": "",
        "cameraWidth": 1280,
        "cameraHeight": 720,
        "moveFps": 30,
        "drawFps": 10,
        "pdfScale": 1.5,
        "defaultRotation": 0,
        "contrast": 1.4,
        "brightness": 10,
        "saturation": 1.2,
        "sharpen": 0,
        "canvasScale": 2,
        "dprLimit": 2,
        "highFrameRate": false,
        "smoothStrength": 0.5,
        "blurEffect": true,
        "penColors": [
            {"r": 52, "g": 152, "b": 219},
            {"r": 46, "g": 204, "b": 113},
            {"r": 231, "g": 76, "b": 60},
            {"r": 243, "g": 156, "b": 18},
            {"r": 155, "g": 89, "b": 182},
            {"r": 26, "g": 188, "b": 156},
            {"r": 52, "g": 73, "b": 94},
            {"r": 233, "g": 30, "b": 99},
            {"r": 0, "g": 188, "b": 212},
            {"r": 139, "g": 195, "b": 74},
            {"r": 255, "g": 87, "b": 34},
            {"r": 103, "g": 58, "b": 183},
            {"r": 121, "g": 85, "b": 72},
            {"r": 0, "g": 0, "b": 0},
            {"r": 255, "g": 255, "b": 255}
        ],
        "fileAssociations": false,
        "wordAssociations": false,
        "autoClearCacheDays": 15,
        "lastCacheClearDate": "",
        "theme": "simplify",
        "denoiseFrameCount": 3,
        "denoiseStrength": "medium",
        "penEffectMode": "limited"
    })
}

fn config_merge_defaults(existing: &serde_json::Value, defaults: &serde_json::Value) -> serde_json::Value {
    let mut merged = defaults.clone();
    
    if let (Some(existing_obj), Some(merged_obj)) = (existing.as_object(), merged.as_object_mut()) {
        for (key, value) in existing_obj {
            merged_obj.insert(key.clone(), value.clone());
        }
    }
    
    merged
}

#[tauri::command]
async fn settings_fetch_all(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    
    let default_config = config_fetch_default();
    
    if !config_path.exists() {
        log::info!("配置文件不存在，使用默认配置");
        return Ok(default_config);
    }
    
    let config_content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取配置文件失败: {}", e))?;
    
    let mut existing_config = serde_json::from_str::<serde_json::Value>(&config_content)
        .map_err(|e| format!("解析配置文件失败: {}", e))?;
    
    let current_version = existing_config
        .get("config_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    
    if current_version < CURRENT_CONFIG_VERSION {
        log::info!("检测到配置版本过旧: v{} < v{}", current_version, CURRENT_CONFIG_VERSION);
        
        let backup_path = config_backup_create(&config_path, current_version)?;
        
        let migrations = migration_fetch_all();
        
        match config_migrate_run(&mut existing_config, &migrations) {
            Ok(_) => {
                let merged_config = config_merge_defaults(&existing_config, &default_config);
                
                let merged_str = serde_json::to_string_pretty(&merged_config)
                    .map_err(|e| format!("序列化配置失败: {}", e))?;
                
                std::fs::write(&config_path, merged_str)
                    .map_err(|e| {
                        log::error!("保存迁移后的配置失败，尝试回滚: {}", e);
                        if let Err(rollback_err) = std::fs::copy(&backup_path, &config_path) {
                            log::error!("回滚失败: {}", rollback_err);
                        }
                        format!("保存配置失败: {}", e)
                    })?;
                
                config_backup_cleanup_old(&config_dir, 3);
                
                log::info!("配置迁移成功");
                Ok(merged_config)
            }
            Err(e) => {
                log::error!("配置迁移失败: {}", e);
                
                if let Err(rollback_err) = std::fs::copy(&backup_path, &config_path) {
                    log::error!("回滚失败: {}", rollback_err);
                    return Err(format!("配置迁移失败且回滚失败: {} (回滚错误: {})", e, rollback_err));
                }
                
                log::info!("已回滚到迁移前的配置");
                let merged_config = config_merge_defaults(&existing_config, &default_config);
                Ok(merged_config)
            }
        }
    } else {
        let merged_config = config_merge_defaults(&existing_config, &default_config);
        
        let merged_str = serde_json::to_string_pretty(&merged_config)
            .map_err(|e| format!("序列化配置失败: {}", e))?;
        std::fs::write(&config_path, merged_str)
            .map_err(|e| format!("保存配置失败: {}", e))?;
        
        Ok(merged_config)
    }
}

#[tauri::command]
async fn settings_save_all(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    }
    
    let config_path = config_dir.join("config.json");
    let temp_path = config_path.with_extension("json.tmp");
    
    let existing_settings = if config_path.exists() {
        if let Ok(config_content) = std::fs::read_to_string(&config_path) {
            if let Ok(mut existing) = serde_json::from_str::<serde_json::Value>(&config_content) {
                if let Some(obj) = existing.as_object_mut() {
                    if let Some(new_obj) = settings.as_object() {
                        for (key, value) in new_obj {
                            obj.insert(key.clone(), value.clone());
                        }
                    }
                }
                existing
            } else {
                settings
            }
        } else {
            settings
        }
    } else {
        settings
    };
    
    let config_str = serde_json::to_string_pretty(&existing_settings).map_err(|e| e.to_string())?;
    
    std::fs::write(&temp_path, &config_str).map_err(|e| e.to_string())?;
    std::fs::rename(&temp_path, &config_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to rename config file: {}", e)
    })?;
    
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn filetype_validate_pdf_default() -> Result<bool, String> {
    use winreg::RegKey;
    use winreg::enums::*;
    
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    
    // 检查用户设置的默认程序
    if let Ok(prog_id_key) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice") {
        if let Ok(prog_id) = prog_id_key.get_value::<String, _>("ProgId") {
            // 检查是否是 ViewStage 的 ProgId
            if prog_id.contains("ViewStage") || prog_id.contains("viewstage") {
                return Ok(true);
            }
        }
    }
    
    // 检查系统默认程序
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    if let Ok(pdf_key) = hkcr.open_subkey(".pdf") {
        if let Ok(default_prog) = pdf_key.get_value::<String, _>("") {
            if default_prog.contains("ViewStage") || default_prog.contains("viewstage") {
                return Ok(true);
            }
        }
    }
    
    Ok(false)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn filetype_validate_pdf_default() -> Result<bool, String> {
    Ok(false)
}

fn app_restart(app: &tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
async fn settings_delete_all(app: tauri::AppHandle) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    
    if config_dir.exists() {
        std::fs::remove_dir_all(&config_dir).map_err(|e| e.to_string())?;
        
        if config_dir.exists() {
            return Err("配置目录删除失败".to_string());
        }
    }
    
    app_restart(&app);
    
    Ok(())
}

#[tauri::command]
async fn app_restart_process(app: tauri::AppHandle) -> Result<(), String> {
    app_restart(&app);
    
    Ok(())
}

#[tauri::command]
async fn update_download_file(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
    use_mirror: Option<bool>,
) -> Result<String, String> {
    let use_mirror = use_mirror.unwrap_or(false);
    log::info!("开始下载更新，文件: {}, 镜像: {}", file_name, use_mirror);

    url_validate_github(&url)?;

    let download_url = if use_mirror {
        let proxy_url = format!("https://gh-proxy.com/{}", url);
        log::info!("使用镜像下载: {}", proxy_url);
        proxy_url
    } else {
        log::info!("使用原始地址下载: {}", url);
        url
    };

    let client = reqwest::Client::builder()
        .user_agent("ViewStage")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| {
            log::error!("创建 HTTP 客户端失败: {}", e);
            e.to_string()
        })?;

    log::info!("正在发起下载请求...");
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| {
            log::error!("下载请求失败: {}", e);
            format!("Network error: {}", e)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        log::error!("下载请求失败，HTTP 状态码: {}", status);
        return Err(format!("Download error: {}", status));
    }

    let total_size = response.content_length().unwrap_or(0);
    log::info!("文件大小: {} bytes ({:.2} MB)", total_size, total_size as f64 / 1024.0 / 1024.0);

    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| {
            log::error!("获取应用数据目录失败: {}", e);
            format!("Failed to get app data dir: {}", e)
        })?;
    
    let updates_dir = app_data_dir.join("updates");
    std::fs::create_dir_all(&updates_dir)
        .map_err(|e| {
            log::error!("创建更新目录失败: {}", e);
            format!("Failed to create updates dir: {}", e)
        })?;

    let file_path = updates_dir.join(&file_name);
    log::info!("保存路径: {:?}", file_path);

    let mut file = std::fs::File::create(&file_path)
        .map_err(|e| {
            log::error!("创建文件失败: {}", e);
            format!("Failed to create file: {}", e)
        })?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    use futures::stream::StreamExt;

    log::info!("开始接收数据...");
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            log::error!("读取数据块失败: {}", e);
            format!("Failed to read chunk: {}", e)
        })?;
        file.write_all(&chunk)
            .map_err(|e| {
                log::error!("写入文件失败: {}", e);
                format!("Failed to write file: {}", e)
            })?;
        
        downloaded += chunk.len() as u64;
        
        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            let progress_rounded = (progress * 100.0).round() / 100.0;
            
            if (progress_rounded as u64) % 10 == 0 && progress_rounded > 0.01 {
                log::debug!("下载进度: {:.1}%", progress_rounded);
            }
            
            app.emit("update-download-progress", progress_rounded)
                .unwrap_or(());
        }
    }

    file.flush().map_err(|e| {
        log::error!("刷新文件失败: {}", e);
        format!("Failed to flush file: {}", e)
    })?;

    log::info!("下载完成，已保存到: {:?}", file_path);

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn resolution_fetch_available(app: tauri::AppHandle) -> Result<Vec<(u32, u32, String)>, String> {
    let primary_monitor = app.primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("无法获取主显示器".to_string())?;
    
    let max_width = primary_monitor.size().width;
    let max_height = primary_monitor.size().height;
    
    let mut resolutions = Vec::new();
    
    let base_resolutions: Vec<(u32, u32)> = vec![
        (1920, 1080),
        (1600, 900),
        (1366, 768),
        (1280, 720),
        (1024, 576),
    ];
    
    for (base_width, base_height) in base_resolutions {
        if base_width <= max_width && base_height <= max_height {
            resolutions.push((base_width, base_height, format!("{} x {}", base_width, base_height)));
        }
    }
    
    resolutions.push((max_width, max_height, format!("{} x {}", max_width, max_height)));
    
    Ok(resolutions)
}

#[tauri::command]
async fn window_hide_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(splashscreen) = app.get_webview_window("splashscreen") {
        let _ = splashscreen.close();
    }
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn oobe_submit_complete(app: tauri::AppHandle) -> Result<(), String> {
    OOBE_ACTIVE.store(false, Ordering::SeqCst);
    
    app_restart(&app);
    
    Ok(())
}

#[tauri::command]
fn oobe_check_active() -> bool {
    OOBE_ACTIVE.load(Ordering::SeqCst)
}

#[tauri::command]
fn main_signal_loaded() {
    MAIN_SCRIPT_LOADED.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn main_check_loaded() -> bool {
    MAIN_SCRIPT_LOADED.load(Ordering::SeqCst)
}

#[tauri::command]
fn app_submit_exit() {
    std::process::exit(0);
}

// ==================== 设备信息检测 ====================

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub windows_version: String,
    pub windows_build: u32,
    pub windows_display_version: String,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub cpu_arch: String,
    pub gpu_name: String,
    pub gpu_driver_version: String,
    pub gpu_driver_date: String,
    pub gpu_dedicated_memory_mb: u64,
    pub total_ram_mb: u64,
    pub system_type: String,
    pub disk_total_gb: u64,
    pub disk_type: String,
    pub has_touchscreen: bool,
}

/// 检测设备信息并写入 device.json
#[tauri::command]
async fn device_detect_all(app: tauri::AppHandle) -> Result<DeviceInfo, String> {
    let device_info = device_collect_info();

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    }

    let device_path = config_dir.join("device.json");
    let json = serde_json::to_string_pretty(&device_info).map_err(|e| e.to_string())?;
    std::fs::write(&device_path, &json).map_err(|e| format!("保存设备信息失败: {}", e))?;

    log::info!("设备信息已保存到: {:?}", device_path);

    Ok(device_info)
}

fn device_collect_info() -> DeviceInfo {
    let (win_ver, win_build, win_display) = device_detect_windows_version();
    let (cpu_name, cpu_cores, cpu_arch) = device_detect_cpu();
    let (gpu_name, gpu_driver, gpu_driver_date, gpu_mem) = device_detect_gpu();
    let (total_ram_mb, system_type) = device_detect_system();
    let (disk_total_gb, disk_type) = device_detect_disk();
    let has_touchscreen = device_detect_touchscreen();

    DeviceInfo {
        windows_version: win_ver,
        windows_build: win_build,
        windows_display_version: win_display,
        cpu_name,
        cpu_cores,
        cpu_arch,
        gpu_name,
        gpu_driver_version: gpu_driver,
        gpu_driver_date: gpu_driver_date,
        gpu_dedicated_memory_mb: gpu_mem,
        total_ram_mb,
        system_type,
        disk_total_gb,
        disk_type,
        has_touchscreen,
    }
}

fn device_detect_windows_version() -> (String, u32, String) {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::*;

        if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") {
            let product_name: String = hklm.get_value("ProductName").unwrap_or_else(|_| "Windows".to_string());
            let current_build: String = hklm.get_value("CurrentBuild").unwrap_or_else(|_| "0".to_string());
            let display_version: String = hklm.get_value("DisplayVersion").unwrap_or_default();
            let release_id: String = hklm.get_value("ReleaseId").unwrap_or_default();
            let _edition_id: String = hklm.get_value("EditionID").unwrap_or_default();

            let build_number: u32 = current_build.parse().unwrap_or(0);
            let version_str = if !display_version.is_empty() {
                format!("{} {} (Build {})", product_name.trim(), display_version, current_build)
            } else if !release_id.is_empty() {
                format!("{} {} (Build {})", product_name.trim(), release_id, current_build)
            } else {
                format!("{} (Build {})", product_name.trim(), current_build)
            };

            return (version_str, build_number, display_version);
        }
    }

    ("Unknown".to_string(), 0, String::new())
}

fn device_detect_cpu() -> (String, usize, String) {
    let cpu_name: String;

    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::*;

        if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") {
            cpu_name = hklm.get_value("ProcessorNameString").unwrap_or_else(|_| "Unknown".to_string());
        } else {
            cpu_name = "Unknown".to_string();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        cpu_name = "Unknown".to_string();
    }

    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);

    let arch = if cfg!(target_arch = "x86_64") { "x64".to_string() }
               else if cfg!(target_arch = "x86") { "x86".to_string() }
               else if cfg!(target_arch = "aarch64") { "ARM64".to_string() }
               else { "Unknown".to_string() };

    (cpu_name.trim().to_string(), cores, arch)
}

fn device_detect_gpu() -> (String, String, String, u64) {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance -ClassName Win32_VideoController | Select-Object -First 1 Name, DriverVersion, DriverDate, AdapterRAM | ConvertTo-Json -Compress"
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                    let name = json.get("Name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
                    let driver = json.get("DriverVersion").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let driver_date = json.get("DriverDate").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let ram = json.get("AdapterRAM").and_then(|v| v.as_u64()).unwrap_or(0);
                    return (name, driver, driver_date, ram / (1024 * 1024));
                }
            }
        }
    }

    ("Unknown".to_string(), String::new(), String::new(), 0)
}

fn device_detect_system() -> (u64, String) {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance -ClassName Win32_ComputerSystem | Select-Object TotalPhysicalMemory, PCSystemType | ConvertTo-Json -Compress"
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                    let ram = json.get("TotalPhysicalMemory").and_then(|v| v.as_u64()).unwrap_or(0);
                    let sys_type = json.get("PCSystemType").and_then(|v| v.as_u64()).unwrap_or(0);
                    let type_str = match sys_type {
                        1 => "Desktop".to_string(),
                        2 => "Laptop".to_string(),
                        3 => "Workstation".to_string(),
                        4 => "Enterprise Server".to_string(),
                        5 => "Tablet".to_string(),
                        _ => "Unknown".to_string(),
                    };
                    return (ram / (1024 * 1024), type_str);
                }
            }
        }
    }

    (0, "Unknown".to_string())
}

fn device_detect_disk() -> (u64, String) {
    #[cfg(target_os = "windows")]
    {
        let disk_size = {
            let output = std::process::Command::new("powershell")
                .args([
                    "-NoProfile", "-NonInteractive", "-Command",
                    "Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object -First 1 Size | ConvertTo-Json -Compress"
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            match output {
                Ok(o) if o.status.success() => {
                    let stdout = String::from_utf8_lossy(&o.stdout);
                    serde_json::from_str::<serde_json::Value>(&stdout)
                        .ok()
                        .and_then(|v| v.get("Size").and_then(|s| s.as_u64()))
                        .unwrap_or(0)
                }
                _ => 0,
            }
        };

        let disk_type = if disk_size > 0 {
            let output = std::process::Command::new("powershell")
                .args([
                    "-NoProfile", "-NonInteractive", "-Command",
                    "Get-CimInstance -ClassName Win32_DiskDrive | Select-Object -First 1 @{N='RPM';E={if ($_.RotationsPerMinute -eq $null -or $_.RotationsPerMinute -eq 0) {'SSD'} else {'HDD'}}} | ConvertTo-Json -Compress"
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            match output {
                Ok(o) if o.status.success() => {
                    let stdout = String::from_utf8_lossy(&o.stdout);
                    match serde_json::from_str::<serde_json::Value>(&stdout) {
                        Ok(ref v) => v.get("RPM")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown")
                            .to_string(),
                        Err(_) => "Unknown".to_string(),
                    }
                }
                _ => "Unknown".to_string(),
            }
        } else {
            "Unknown".to_string()
        };

        return (disk_size / (1024 * 1024 * 1024), disk_type);
    }

    #[cfg(not(target_os = "windows"))]
    { (0, "Unknown".to_string()) }
}

fn device_detect_touchscreen() -> bool {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::IsTouchEnabled"
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
                return stdout == "true" || stdout == "True";
            }
        }
    }

    false
}

// ==================== Office 文件转换 ====================

/// Office 软件类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OfficeSoftware {
    MicrosoftWord,
    WpsOffice,
    LibreOffice,
    None,
}

/// Office 检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeDetectionResult {
    pub has_word: bool,
    pub has_wps: bool,
    pub has_libreoffice: bool,
    pub recommended: OfficeSoftware,
}

#[cfg(target_os = "windows")]
fn office_detect_windows() -> OfficeDetectionResult {
    use winreg::RegKey;
    use winreg::enums::*;
    
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    
    let has_word = office_check_word(&hkcu, &hklm);
    let has_wps = office_check_wps(&hkcu, &hklm);
    let has_libreoffice = office_check_libreoffice(&hkcu, &hklm);
    
    let recommended = if has_word {
        OfficeSoftware::MicrosoftWord
    } else if has_wps {
        OfficeSoftware::WpsOffice
    } else if has_libreoffice {
        OfficeSoftware::LibreOffice
    } else {
        OfficeSoftware::None
    };
    
    OfficeDetectionResult {
        has_word,
        has_wps,
        has_libreoffice,
        recommended,
    }
}

#[cfg(target_os = "windows")]
fn office_check_word(hkcu: &winreg::RegKey, hklm: &winreg::RegKey) -> bool {
    let paths = [
        "SOFTWARE\\Microsoft\\Office\\Word",
        "SOFTWARE\\Microsoft\\Office\\16.0\\Word",
        "SOFTWARE\\Microsoft\\Office\\15.0\\Word",
        "SOFTWARE\\Microsoft\\Office\\14.0\\Word",
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE",
    ];
    
    for path in &paths {
        if hkcu.open_subkey(path).is_ok() || hklm.open_subkey(path).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn office_check_wps(hkcu: &winreg::RegKey, hklm: &winreg::RegKey) -> bool {
    let paths = [
        "SOFTWARE\\Kingsoft\\Office",
        "SOFTWARE\\WPS",
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\wps.exe",
    ];
    
    for path in &paths {
        if hkcu.open_subkey(path).is_ok() || hklm.open_subkey(path).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn office_check_libreoffice(hkcu: &winreg::RegKey, hklm: &winreg::RegKey) -> bool {
    let paths = [
        "SOFTWARE\\LibreOffice",
        "SOFTWARE\\The Document Foundation\\LibreOffice",
    ];
    
    for path in &paths {
        if hkcu.open_subkey(path).is_ok() || hklm.open_subkey(path).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn office_detect_windows() -> OfficeDetectionResult {
    OfficeDetectionResult {
        has_word: false,
        has_wps: false,
        has_libreoffice: false,
        recommended: OfficeSoftware::None,
    }
}

#[tauri::command]
fn office_detect_all() -> OfficeDetectionResult {
    office_detect_windows()
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn office_convert_docx_to_pdf_bytes(file_data: Vec<u8>, file_name: String, app: tauri::AppHandle) -> Result<String, String> {
    use std::fs;
    use std::io::Write;
    
    println!("收到文件数据: {} 字节", file_data.len());
    println!("文件名: {}", file_name);
    
    if file_data.len() < 4 {
        return Err("文件数据太小，可能已损坏".to_string());
    }
    
    let header: Vec<String> = file_data.iter().take(16).map(|b| format!("{:02x}", b)).collect();
    println!("文件头: {}", header.join(" "));
    
    if file_data[0] == 0x50 && file_data[1] == 0x4B {
        println!("检测到 ZIP 格式 (docx)");
    } else if file_data[0] == 0xD0 && file_data[1] == 0xCF {
        println!("检测到 OLE 格式 (doc)");
    } else {
        println!("未知文件格式");
    }
    
    let detection = office_detect_windows();
    println!("推荐使用: {:?}", detection.recommended);
    
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let cache_dir = config_dir.join("cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    
    let folder_name = format!("document_{}", chrono::Local::now().format("%Y%m%d%H%M%S"));
    let doc_cache_dir = cache_dir.join(&folder_name);
    fs::create_dir_all(&doc_cache_dir).map_err(|e| e.to_string())?;
    
    let temp_name = format!("temp_{}.docx", chrono::Local::now().format("%Y%m%d%H%M%S"));
    let temp_docx_path = doc_cache_dir.join(&temp_name);
    
    {
        let mut file = fs::File::create(&temp_docx_path)
            .map_err(|e| format!("创建临时文件失败: {}", e))?;
        file.write_all(&file_data)
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("同步文件失败: {}", e))?;
    }
    
    let pdf_name = format!("{}.pdf", folder_name);
    let pdf_path = doc_cache_dir.join(&pdf_name);
    
    if pdf_path.exists() {
        fs::remove_file(&pdf_path).map_err(|e| e.to_string())?;
    }
    
    let docx_path_str = temp_docx_path.to_string_lossy().to_string();
    let pdf_path_str = pdf_path.to_string_lossy().to_string();
    
    println!("临时文件路径: {}", docx_path_str);
    println!("输出 PDF 路径: {}", pdf_path_str);
    
    let result = match detection.recommended {
        OfficeSoftware::MicrosoftWord => {
            let r = office_convert_word(&docx_path_str, &pdf_path_str);
            if r.is_err() && detection.has_wps {
                println!("Word 转换失败，尝试 WPS...");
                office_convert_wps(&docx_path_str, &pdf_path_str)
            } else if r.is_err() && detection.has_libreoffice {
                println!("Word 转换失败，尝试 LibreOffice...");
                office_convert_libreoffice(&docx_path_str, &pdf_path_str, &doc_cache_dir)
            } else {
                r
            }
        }
        OfficeSoftware::WpsOffice => {
            let r = office_convert_wps(&docx_path_str, &pdf_path_str);
            if r.is_err() && detection.has_word {
                println!("WPS 转换失败，尝试 Word...");
                office_convert_word(&docx_path_str, &pdf_path_str)
            } else if r.is_err() && detection.has_libreoffice {
                println!("WPS 转换失败，尝试 LibreOffice...");
                office_convert_libreoffice(&docx_path_str, &pdf_path_str, &doc_cache_dir)
            } else {
                r
            }
        }
        OfficeSoftware::LibreOffice => {
            office_convert_libreoffice(&docx_path_str, &pdf_path_str, &doc_cache_dir)
        }
        OfficeSoftware::None => {
            Err("未检测到可用的 Office 软件，请安装 Microsoft Word、WPS Office 或 LibreOffice".to_string())
        }
    };
    
    if let Err(e) = fs::remove_file(&temp_docx_path) {
        println!("清理临时文件失败: {}", e);
    }
    
    result?;
    
    for _ in 0..10 {
        if pdf_path.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    
    if pdf_path.exists() {
        Ok(pdf_path_str)
    } else {
        Err("PDF 文件生成失败".to_string())
    }
}

#[cfg(target_os = "windows")]
fn office_convert_libreoffice(docx_path: &str, _pdf_path: &str, cache_dir: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let output_dir = cache_dir.to_str()
        .ok_or("Invalid cache directory path")?
        .to_string();
    Command::new("soffice")
        .args(["--headless", "--convert-to", "pdf", "--outdir", &output_dir, docx_path])
        .output()
        .map(|_| ())
        .map_err(|e| format!("LibreOffice 转换失败: {}", e))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn office_convert_docx_to_pdf(docx_path: String, app: tauri::AppHandle) -> Result<String, String> {
    use std::process::Command;
    use std::fs;
    
    let detection = office_detect_windows();
    
    let docx = std::path::Path::new(&docx_path);
    let docx_absolute = std::fs::canonicalize(docx)
        .map_err(|e| format!("无法获取文件绝对路径: {}", e))?;
    
    if !docx_absolute.exists() {
        return Err(format!("文件不存在: {}", docx_absolute.display()));
    }
    
    println!("转换文件: {}", docx_absolute.display());
    
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let cache_dir = config_dir.join("cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    
    let folder_name = format!("document_{}", chrono::Local::now().format("%Y%m%d%H%M%S"));
    let doc_cache_dir = cache_dir.join(&folder_name);
    fs::create_dir_all(&doc_cache_dir).map_err(|e| e.to_string())?;
    
    let pdf_name = format!("{}.pdf", folder_name);
    let pdf_path = doc_cache_dir.join(&pdf_name);
    
    if pdf_path.exists() {
        fs::remove_file(&pdf_path).map_err(|e| e.to_string())?;
    }
    
    let docx_path_str = docx_absolute.to_string_lossy().to_string();
    let pdf_path_str = pdf_path.to_string_lossy().to_string();
    
    match detection.recommended {
        OfficeSoftware::MicrosoftWord => {
            office_convert_word(&docx_path_str, &pdf_path_str)?;
        }
        OfficeSoftware::WpsOffice => {
            office_convert_wps(&docx_path_str, &pdf_path_str)?;
        }
        OfficeSoftware::LibreOffice => {
            let output_dir = doc_cache_dir.to_str()
                .ok_or("Invalid cache directory path")?
                .to_string();
            Command::new("soffice")
                .args(["--headless", "--convert-to", "pdf", "--outdir", &output_dir, &docx_path_str])
                .output()
                .map_err(|e| format!("LibreOffice 转换失败: {}", e))?;
        }
        OfficeSoftware::None => {
            return Err("未检测到可用的 Office 软件，请安装 Microsoft Word、WPS Office 或 LibreOffice".to_string());
        }
    }
    
    std::thread::sleep(std::time::Duration::from_millis(500));
    
    if pdf_path.exists() {
        Ok(pdf_path_str)
    } else {
        Err("PDF 文件生成失败".to_string())
    }
}

#[cfg(target_os = "windows")]
fn office_convert_word(docx_path: &str, pdf_path: &str) -> Result<(), String> {
    use std::process::Command;
    
    println!("Word COM 转换开始");
    println!("  输入文件: {}", docx_path);
    println!("  输出文件: {}", pdf_path);
    
    let ps_script = format!(r#"
        $ErrorActionPreference = 'Stop'
        
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $word.DisplayAlerts = 0
        $doc = $null
        try {{
            $doc = $word.Documents.Open('{input}', $false, $false, $false)
            if (-not $doc) {{
                throw "无法打开文档，文件可能已损坏或格式不支持"
            }}
            $doc.ExportAsFixedFormat('{output}', 17)
        }}
        finally {{
            if ($doc) {{ 
                try {{ $doc.Close($false) }} catch {{}}
                [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
            }}
            try {{ $word.Quit() }} catch {{}}
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
            [GC]::Collect()
            [GC]::WaitForPendingFinalizers()
        }}
    "#, input = docx_path.replace("'", "''"), output = pdf_path.replace("'", "''"));
    
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("PowerShell 执行失败: {}", e))?;
    
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Word 转换失败: {}", stderr))
    }
}

#[cfg(target_os = "windows")]
fn office_convert_wps(docx_path: &str, pdf_path: &str) -> Result<(), String> {
    use std::process::Command;
    
    println!("WPS COM 转换开始");
    println!("  输入文件: {}", docx_path);
    println!("  输出文件: {}", pdf_path);
    
    let ps_script = format!(r#"
        $ErrorActionPreference = 'Stop'
        
        $wps = $null
        try {{
            $wps = New-Object -ComObject Kwps.Application
        }} catch {{
            $wps = New-Object -ComObject WPS.Application
        }}
        $wps.Visible = $false
        $wps.DisplayAlerts = 0
        $doc = $null
        try {{
            $doc = $wps.Documents.Open('{input}', $false, $false, $false)
            if (-not $doc) {{
                throw "无法打开文档，文件可能已损坏或格式不支持"
            }}
            $doc.ExportAsFixedFormat('{output}', 17)
        }}
        finally {{
            if ($doc) {{ 
                try {{ $doc.Close($false) }} catch {{}}
                [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
            }}
            try {{ $wps.Quit() }} catch {{}}
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wps) | Out-Null
            [GC]::Collect()
            [GC]::WaitForPendingFinalizers()
        }}
    "#, input = docx_path.replace("'", "''"), output = pdf_path.replace("'", "''"));
    
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("PowerShell 执行失败: {}", e))?;
    
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("WPS 转换失败: {}", stderr))
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn office_convert_docx_to_pdf(_docx_path: String, _app: tauri::AppHandle) -> Result<String, String> {
    Err("此功能仅支持 Windows 系统".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn filetype_set_icons(app: tauri::AppHandle) -> Result<(), String> {
    use std::process::Command;
    use winreg::RegKey;
    use winreg::enums::*;
    
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("获取资源目录失败: {}", e))?;
    
    let pdf_icon = resource_dir.join("icons").join("pdf.ico").to_string_lossy().to_string();
    let word_icon = resource_dir.join("icons").join("word.ico").to_string_lossy().to_string();
    
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("获取可执行文件路径失败: {}", e))?;
    let exe_path_str = exe_path.to_string_lossy().to_string();
    
    let app_id = "SECTL.ViewStage";
    
    log::info!("开始设置文件关联");
    log::info!("可执行文件: {}", exe_path_str);
    log::info!("PDF 图标: {}", pdf_icon);
    log::info!("Word 图标: {}", word_icon);
    
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes_key = hkcu.create_subkey("Software\\Classes")
        .map_err(|e| format!("创建 Classes 键失败: {}", e))?.0;
    
    fn filetype_create_progid(
        classes_key: &RegKey,
        prog_id: &str,
        icon_path: &str,
        exe_path: &str,
        friendly_name: &str,
    ) -> Result<(), String> {
        let (prog_key, _) = classes_key
            .create_subkey(prog_id)
            .map_err(|e| format!("创建 {} 键失败: {}", prog_id, e))?;
        
        prog_key
            .set_value("", &friendly_name)
            .map_err(|e| format!("设置 {} 友好名称失败: {}", prog_id, e))?;
        
        let (icon_key, _) = prog_key
            .create_subkey("DefaultIcon")
            .map_err(|e| format!("创建 {}\\DefaultIcon 键失败: {}", prog_id, e))?;
        icon_key
            .set_value("", &icon_path)
            .map_err(|e| format!("设置 {} 图标失败: {}", prog_id, e))?;
        
        let (command_key, _) = prog_key
            .create_subkey("shell\\open\\command")
            .map_err(|e| format!("创建 {}\\shell\\open\\command 键失败: {}", prog_id, e))?;
        let command = format!("\"{}\" \"%1\"", exe_path);
        command_key
            .set_value("", &command)
            .map_err(|e| format!("设置 {} 命令失败: {}", prog_id, e))?;
        
        log::info!("ProgID {} 设置完成", prog_id);
        Ok(())
    }
    
    filetype_create_progid(&classes_key, &format!("{}.pdf", app_id), &pdf_icon, &exe_path_str, "ViewStage PDF Document")?;
    filetype_create_progid(&classes_key, &format!("{}.docx", app_id), &word_icon, &exe_path_str, "ViewStage Word Document")?;
    filetype_create_progid(&classes_key, &format!("{}.doc", app_id), &word_icon, &exe_path_str, "ViewStage Word 97-2003 Document")?;
    
    fn filetype_create_association(classes_key: &RegKey, ext: &str, prog_id: &str) -> Result<(), String> {
        let (ext_key, _) = classes_key
            .create_subkey(ext)
            .map_err(|e| format!("创建 {} 键失败: {}", ext, e))?;
        
        let (openwith_key, _) = ext_key
            .create_subkey("OpenWithProgids")
            .map_err(|e| format!("创建 {}\\OpenWithProgids 键失败: {}", ext, e))?;
        
        openwith_key
            .set_value(prog_id, &"")
            .map_err(|e| format!("关联 {} 到 {} 失败: {}", ext, prog_id, e))?;
        
        log::info!("文件扩展名 {} 已关联到 {}", ext, prog_id);
        Ok(())
    }
    
    filetype_create_association(&classes_key, ".pdf", &format!("{}.pdf", app_id))?;
    filetype_create_association(&classes_key, ".docx", &format!("{}.docx", app_id))?;
    filetype_create_association(&classes_key, ".doc", &format!("{}.doc", app_id))?;
    
    fn filetype_update_default(hkcu: &RegKey, ext: &str, prog_id: &str) -> Result<(), String> {
        let user_choice_path = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\{}\\UserChoice",
            ext
        );
        
        let result = hkcu.create_subkey(&user_choice_path);
        
        match result {
            Ok((user_choice_key, _)) => {
                match user_choice_key.set_value("ProgId", &prog_id) {
                    Ok(_) => {
                        log::info!("成功设置 {} 为 {} 的默认程序", prog_id, ext);
                        Ok(())
                    }
                    Err(e) => {
                        log::warn!("设置 UserChoice 失败（可能需要管理员权限）: {}", e);
                        Err(format!("设置默认程序失败，请手动在系统设置中设置: {}", e))
                    }
                }
            }
            Err(e) => {
                log::warn!("创建 UserChoice 键失败: {}", e);
                Err(format!("无法设置默认程序，请手动在系统设置中设置: {}", e))
            }
        }
    }
    
    let mut errors = Vec::new();
    
    if let Err(e) = filetype_update_default(&hkcu, ".pdf", &format!("{}.pdf", app_id)) {
        errors.push(e);
    }
    
    if let Err(e) = filetype_update_default(&hkcu, ".docx", &format!("{}.docx", app_id)) {
        errors.push(e);
    }
    
    if let Err(e) = filetype_update_default(&hkcu, ".doc", &format!("{}.doc", app_id)) {
        errors.push(e);
    }
    
    let ps_script = r#"
        $code = @'
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
'@
        Add-Type -MemberDefinition $code -Name Shell -Namespace WinAPI
        [WinAPI.Shell]::SHChangeNotify(0x8000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
        Write-Host "图标缓存已刷新"
    "#;
    
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("刷新图标缓存失败: {}", e))?;
    
    if !output.status.success() {
        log::warn!("刷新图标缓存失败");
    }
    
    if errors.is_empty() {
        log::info!("文件关联设置完成，已设置为默认程序");
        Ok(())
    } else {
        let error_msg = errors.join("\n");
        log::warn!("部分设置失败:\n{}", error_msg);
        Err(error_msg)
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn set_file_type_icons() -> Result<(), String> {
    Err("此功能仅支持 Windows 系统".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn filetype_delete_icons() -> Result<(), String> {
    use std::process::Command;
    use winreg::RegKey;
    use winreg::enums::*;
    
    let app_id = "SECTL.ViewStage";
    
    log::info!("开始移除文件关联");
    
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    
    fn filetype_delete_progid(hkcu: &RegKey, prog_id: &str) -> Result<(), String> {
        let classes_path = format!("Software\\Classes\\{}", prog_id);
        
        if let Ok(_) = hkcu.delete_subkey_all(&classes_path) {
            log::info!("已删除 ProgID: {}", prog_id);
        } else {
            log::info!("ProgID {} 不存在或已删除", prog_id);
        }
        
        Ok(())
    }
    
    filetype_delete_progid(&hkcu, &format!("{}.pdf", app_id))?;
    filetype_delete_progid(&hkcu, &format!("{}.docx", app_id))?;
    filetype_delete_progid(&hkcu, &format!("{}.doc", app_id))?;
    
    fn filetype_delete_association(hkcu: &RegKey, ext: &str, prog_id: &str) -> Result<(), String> {
        let openwith_path = format!("Software\\Classes\\{}\\OpenWithProgids", ext);
        
        if let Ok(openwith_key) = hkcu.open_subkey(&openwith_path) {
            if let Ok(_) = openwith_key.delete_value(prog_id) {
                log::info!("已移除 {} 的 {} 关联", ext, prog_id);
            }
        }
        
        Ok(())
    }
    
    filetype_delete_association(&hkcu, ".pdf", &format!("{}.pdf", app_id))?;
    filetype_delete_association(&hkcu, ".docx", &format!("{}.docx", app_id))?;
    filetype_delete_association(&hkcu, ".doc", &format!("{}.doc", app_id))?;
    
    fn filetype_delete_user_choice(hkcu: &RegKey, ext: &str) -> Result<(), String> {
        let user_choice_path = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\{}\\UserChoice",
            ext
        );
        
        if let Ok(_) = hkcu.delete_subkey_all(&user_choice_path) {
            log::info!("已移除 {} 的 UserChoice 设置", ext);
        } else {
            log::info!("{} 的 UserChoice 不存在或已删除", ext);
        }
        
        Ok(())
    }
    
    filetype_delete_user_choice(&hkcu, ".pdf")?;
    filetype_delete_user_choice(&hkcu, ".docx")?;
    filetype_delete_user_choice(&hkcu, ".doc")?;
    
    let ps_script = r#"
        $code = @'
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
'@
        Add-Type -MemberDefinition $code -Name Shell -Namespace WinAPI
        [WinAPI.Shell]::SHChangeNotify(0x8000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
        Write-Host "图标缓存已刷新"
    "#;
    
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("刷新图标缓存失败: {}", e))?;
    
    if !output.status.success() {
        log::warn!("刷新图标缓存失败");
    }
    
    log::info!("文件关联移除完成");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn filetype_delete_icons() -> Result<(), String> {
    Err("此功能仅支持 Windows 系统".to_string())
}




#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn app_init_run() {
    use simplelog::{CombinedLogger, WriteLogger, LevelFilter, Config, TermLogger, TerminalMode, ColorChoice};
    use std::fs::File;
    
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("SECTL")
        .join("ViewStage");
    let log_dir = config_dir.join("log");
    
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("无法创建日志目录: {}", e);
    }
    
    let log_file = log_dir.join(format!("viewstage_{}.log", chrono::Local::now().format("%Y%m%d")));
    
    if let Ok(file) = File::create(&log_file) {
        let _ = CombinedLogger::init(vec![
            WriteLogger::new(LevelFilter::Info, Config::default(), file),
            TermLogger::new(LevelFilter::Info, Config::default(), TerminalMode::Mixed, ColorChoice::Auto),
        ]);
        log::info!("日志系统初始化成功");
    }
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            println!("单实例回调: args={:?}", args);
            if args.len() > 1 {
                let file_path = args[1].clone();
                println!("从第二个实例接收文件: {}", file_path);
                let _ = app.emit("file-opened", file_path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .setup(|app| {
            let window = app.get_webview_window("main")
                .expect("Failed to get main window");
            
            let _ = window.set_decorations(false);
            
            let config_dir = app.path().app_config_dir()
                .expect("Failed to get config directory");
            let config_path = config_dir.join("config.json");
            
            let is_first_run = !config_path.exists();
            
            if is_first_run {
                println!("首次运行，打开 OOBE 界面");
                
                OOBE_ACTIVE.store(true, Ordering::SeqCst);
                
                use tauri::WebviewWindowBuilder;
                
                let oobe_window = WebviewWindowBuilder::new(
                    app,
                    "oobe",
                    tauri::WebviewUrl::App("oobe.html".into())
                )
                .title("欢迎使用 ViewStage")
                .inner_size(500.0, 520.0)
                .resizable(false)
                .decorations(false)
                .center()
                .always_on_top(true)
                .build()
                .expect("Failed to create OOBE window");
                
                let _ = oobe_window.set_focus();
                
                if let Some(splashscreen) = app.get_webview_window("splashscreen") {
                    let _ = splashscreen.close();
                }
            } else {
                if let Ok(config_content) = std::fs::read_to_string(&config_path) {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&config_content) {
                        if let (Some(width), Some(height)) = (
                            config.get("width").and_then(serde_json::Value::as_u64),
                            config.get("height").and_then(serde_json::Value::as_u64)
                        ) {
                            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                                width: width as u32,
                                height: height as u32,
                            }));
                        }
                        
                        let _ = window.set_fullscreen(true);
                    }
                }
                
                let args: Vec<String> = std::env::args().collect();
                println!("启动参数: {:?}", args);
                
                if args.len() > 1 {
                    let file_path = args[1].clone();
                    println!("检测到文件参数: {}", file_path);
                    
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2000));
                        println!("发送文件打开事件: {}", file_path);
                        let _ = app_handle.emit("file-opened", file_path.clone());
                        println!("已发送文件打开事件: {}", file_path);
                    });
                }
                
                println!("应用已启动，等待文件打开事件...");
            }
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dir_fetch_cache, 
            cache_fetch_size,
            cache_delete_all,
            cache_validate_auto_clear,
            dir_fetch_config, 
            dir_fetch_pictures_viewstage,
            dir_fetch_theme,
            theme_list_user,
            theme_delete,
            theme_import_vst,
            theme_get_preview,
            image_update_rotation,
            image_save_file,
            stroke_format_compact,
            window_show_settings,
            mirror_update_state,
            mirror_fetch_state,
            app_fetch_version,
            update_fetch_check,
            update_download_file,
            settings_fetch_all,
            settings_save_all,
            settings_delete_all,
            app_restart_process,
            resolution_fetch_available,
            filetype_validate_pdf_default,
            window_hide_splashscreen,
            oobe_submit_complete,
            oobe_check_active,
            main_signal_loaded,
            main_check_loaded,
            app_submit_exit,
            office_detect_all,
            office_convert_docx_to_pdf,
            office_convert_docx_to_pdf_bytes,
            filetype_set_icons,
            filetype_delete_icons,
            device_detect_all
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
