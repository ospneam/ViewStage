use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

/// 线段点结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrokePoint {
    pub from_x: f32,
    pub from_y: f32,
    pub to_x: f32,
    pub to_y: f32,
}

/// 笔画结构（用于视口裁剪）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stroke {
    pub r#type: String,
    pub points: Vec<StrokePoint>,
    pub color: Option<String>,
    pub line_width: Option<u32>,
    pub eraser_size: Option<u32>,
}

/// 视口结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// 视口裁剪请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportCullRequest {
    pub strokes: Vec<Stroke>,
    pub viewport: Viewport,
}

/// 路径平滑请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathSmoothRequest {
    pub points: Vec<StrokePoint>,
    pub smoothness: f32,
    pub algorithm: String,
}

/// 错误响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

// ==================== 内部工具函数 ====================

/// 线段与矩形相交检测
#[inline]
fn line_rect_intersect(
    x1: f32, y1: f32,
    x2: f32, y2: f32,
    rect_left: f32, rect_top: f32,
    rect_right: f32, rect_bottom: f32
) -> bool {
    if x1 < rect_left && x2 < rect_left {
        return false;
    }
    if x1 > rect_right && x2 > rect_right {
        return false;
    }
    if y1 < rect_top && y2 < rect_top {
        return false;
    }
    if y1 > rect_bottom && y2 > rect_bottom {
        return false;
    }
    
    let d1 = (rect_left - x1) * (y2 - y1) - (rect_top - y1) * (x2 - x1);
    let d2 = (rect_right - x1) * (y2 - y1) - (rect_top - y1) * (x2 - x1);
    let d3 = (rect_left - x1) * (y2 - y1) - (rect_bottom - y1) * (x2 - x1);
    let d4 = (rect_right - x1) * (y2 - y1) - (rect_bottom - y1) * (x2 - x1);
    
    if (d1 * d2) > 0.0 && (d3 * d4) > 0.0 {
        return false;
    }
    
    true
}

// ==================== 导出函数 ====================

/// 路径平滑处理
#[wasm_bindgen]
pub fn smooth_path(request_json: &str) -> String {
    let request: PathSmoothRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_string(&ErrorResponse {
                error: format!("Failed to parse request: {}", e)
            }).unwrap_or_default();
        }
    };
    
    let point_count = request.points.len();
    if point_count < 2 {
        return serde_json::to_string(&request.points).unwrap_or_default();
    }
    
    let mut smoothed_points = Vec::with_capacity(point_count);
    
    if request.algorithm == "moving_average" {
        let window_size = (3.0 + request.smoothness * 7.0) as usize;
        let half_window = window_size / 2;
        
        // 使用前缀和加速计算
        let mut prefix_from_x = vec![0.0; point_count + 1];
        let mut prefix_from_y = vec![0.0; point_count + 1];
        let mut prefix_to_x = vec![0.0; point_count + 1];
        let mut prefix_to_y = vec![0.0; point_count + 1];
        
        for i in 0..point_count {
            prefix_from_x[i + 1] = prefix_from_x[i] + request.points[i].from_x;
            prefix_from_y[i + 1] = prefix_from_y[i] + request.points[i].from_y;
            prefix_to_x[i + 1] = prefix_to_x[i] + request.points[i].to_x;
            prefix_to_y[i + 1] = prefix_to_y[i] + request.points[i].to_y;
        }
        
        for i in 0..point_count {
            let start = i.saturating_sub(half_window);
            let end = (i + half_window).min(point_count - 1);
            let count = end - start + 1;
            
            let sum_from_x = prefix_from_x[end + 1] - prefix_from_x[start];
            let sum_from_y = prefix_from_y[end + 1] - prefix_from_y[start];
            let sum_to_x = prefix_to_x[end + 1] - prefix_to_x[start];
            let sum_to_y = prefix_to_y[end + 1] - prefix_to_y[start];
            
            smoothed_points.push(StrokePoint {
                from_x: sum_from_x / count as f32,
                from_y: sum_from_y / count as f32,
                to_x: sum_to_x / count as f32,
                to_y: sum_to_y / count as f32,
            });
        }
    } else {
        // 简单平滑：保留首尾点
        smoothed_points.push(request.points[0].clone());
        
        let smooth_factor = request.smoothness * 0.5;
        
        for i in 1..point_count - 1 {
            let prev = &request.points[i - 1];
            let curr = &request.points[i];
            let next = &request.points[i + 1];
            
            let control1_x = curr.from_x + (prev.to_x - curr.from_x) * smooth_factor;
            let control1_y = curr.from_y + (prev.to_y - curr.from_y) * smooth_factor;
            let control2_x = curr.to_x + (next.from_x - curr.to_x) * smooth_factor;
            let control2_y = curr.to_y + (next.from_y - curr.to_y) * smooth_factor;
            
            smoothed_points.push(StrokePoint {
                from_x: control1_x,
                from_y: control1_y,
                to_x: control2_x,
                to_y: control2_y,
            });
        }
        
        smoothed_points.push(request.points.last().unwrap().clone());
    }
    
    serde_json::to_string(&smoothed_points).unwrap_or_default()
}

/// 视口裁剪：只保留可见的笔画
#[wasm_bindgen]
pub fn cull_strokes_by_viewport(request_json: &str) -> String {
    let request: ViewportCullRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_string(&ErrorResponse {
                error: format!("Failed to parse request: {}", e)
            }).unwrap_or_default();
        }
    };
    
    let vp = &request.viewport;
    let vp_left = vp.x;
    let vp_top = vp.y;
    let vp_right = vp.x + vp.width;
    let vp_bottom = vp.y + vp.height;
    
    let mut visible_strokes = Vec::new();
    
    for stroke in request.strokes {
        if stroke.points.is_empty() {
            continue;
        }
        
        let mut is_visible = false;
        
        for point in &stroke.points {
            if line_rect_intersect(
                point.from_x, point.from_y,
                point.to_x, point.to_y,
                vp_left, vp_top, vp_right, vp_bottom
            ) {
                is_visible = true;
                break;
            }
        }
        
        if is_visible {
            visible_strokes.push(stroke);
        }
    }
    
    serde_json::to_string(&visible_strokes).unwrap_or_default()
}
