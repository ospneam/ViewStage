// image_processing.rs — 图像编解码与旋转处理
// 提供 base64 图像数据加载、解码及 Tauri IPC 旋转命令

use image::DynamicImage;
use base64::{Engine as _, engine::general_purpose};

/// 单次加载的图像最大字节数（50MB）
const MAX_IMAGE_SIZE: usize = 50 * 1024 * 1024;

/// 从 base64 数据加载图像
///
/// # 参数
/// * `image_data` — 含 data:image 前缀或纯 base64 的图片数据
///
/// # 返回值
/// * `Ok(DynamicImage)` — 解码后的图像对象
///
/// # 异常
/// * base64 解析失败
/// * 图像格式不支持或数据损坏
/// * 分辨率宽高为零
pub fn image_load_base64(image_data: &str) -> Result<DynamicImage, String> {
    let base64_data = if image_data.starts_with("data:image") {
        image_data.split(',')
            .nth(1)
            .ok_or("Invalid base64 image data")?
            .to_string()
    } else {
        image_data.to_string()
    };
    
    if base64_data.len() > MAX_IMAGE_SIZE * 4 / 3 {
        return Err("Image data too large (max 50MB)".to_string());
    }
    
    let decoded = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    
    let img = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    if img.width() == 0 || img.height() == 0 {
        return Err("Invalid image dimensions: width or height is zero".to_string());
    }
    
    Ok(img)
}

/// 从 base64 数据提取原始字节
///
/// # 参数
/// * `image_data` — 含 data:image 前缀或纯 base64 的图片数据
///
/// # 返回值
/// * `Ok(Vec<u8>)` — 解码后的原始图像字节
///
/// # 异常
/// * base64 解析失败
pub fn image_fetch_base64_data(image_data: &str) -> Result<Vec<u8>, String> {
    let base64_data = if image_data.starts_with("data:image") {
        image_data.split(',')
            .nth(1)
            .ok_or("Invalid base64 image data")?
    } else {
        image_data
    };
    
    general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))
}

/// Tauri IPC 命令：将图像按方向旋转
///
/// # 参数
/// * `image_data` — base64 编码的图片数据（含 data:image 前缀）
/// * `direction` — 旋转方向，"left" 为逆时针 270 度，其他值为顺时针 90 度
///
/// # 返回值
/// * `Ok(String)` — 旋转后的 base64 编码 PNG 图片数据
///
/// # 异常
/// * base64 解析失败
/// * 图像格式不支持
#[tauri::command]
pub fn image_update_rotation(image_data: String, direction: String) -> Result<String, String> {
    let img = image_load_base64(&image_data)?;
    
    let rotated = if direction == "left" {
        img.rotate270()
    } else {
        img.rotate90()
    };
    
    let mut buffer = Vec::new();
    rotated
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode rotated image: {}", e))?;
    
    let result = format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&buffer));
    
    Ok(result)
}
