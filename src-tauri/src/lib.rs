// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tauri::{Manager, Emitter};

#[tauri::command]
fn get_cache_dir(app: tauri::AppHandle) -> Result<String, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;
    
    if !cache_dir.exists() {
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }
    
    Ok(cache_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn get_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    
    Ok(config_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn get_cds_dir() -> Result<String, String> {
    let pictures_dir = dirs::picture_dir()
        .ok_or("Failed to get pictures directory")?;
    
    let cds_dir = pictures_dir.join("CDS");
    
    if !cds_dir.exists() {
        std::fs::create_dir_all(&cds_dir)
            .map_err(|e| format!("Failed to create CDS dir: {}", e))?;
    }
    
    Ok(cds_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            
            let config_dir = app.path().app_config_dir().unwrap();
            let config_path = config_dir.join("config.json");
            
            if config_path.exists() {
                if let Ok(config_content) = std::fs::read_to_string(config_path) {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&config_content) {
                        if let (Some(width), Some(height)) = (
                            config.get("width").and_then(|v| v.as_u64()),
                            config.get("height").and_then(|v| v.as_u64())
                        ) {
                            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                                width: width as u32,
                                height: height as u32,
                            }));
                        }
                        
                        let _ = window.set_fullscreen(true);
                    }
                }
            }
            
            let args: Vec<String> = std::env::args().collect();
            println!("启动参数: {:?}", args);
            
            if args.len() > 1 {
                let file_path = args[1].clone();
                println!("检测到文件参数: {}", file_path);
                
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = app_handle.emit("file-opened", file_path.clone());
                    println!("已发送文件打开事件: {}", file_path);
                });
            }
            
            println!("应用已启动，等待文件打开事件...");
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, get_cache_dir, get_config_dir, get_cds_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
