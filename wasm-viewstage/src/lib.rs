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

/// 笔画结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stroke {
    pub r#type: String,
    pub points: Vec<StrokePoint>,
    pub color: Option<String>,
    pub line_width: Option<u32>,
    pub eraser_size: Option<u32>,
}

/// 点处理配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointOptimizationConfig {
    pub epsilon: f32,
    pub min_distance: f32,
    pub quantization: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessPointsRequest {
    pub points: Vec<StrokePoint>,
    pub config: PointOptimizationConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawCommand {
    pub r#type: String,
    pub from_x: f32,
    pub from_y: f32,
    pub to_x: f32,
    pub to_y: f32,
    pub color: String,
    pub line_width: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchProcessDrawCommandsRequest {
    pub commands: Vec<DrawCommand>,
    pub min_distance: f32,
    pub max_batch_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectPointsRequest {
    pub points: Vec<StrokePoint>,
    pub config: PointOptimizationConfig,
    pub last_time: u64,
    pub last_x: f32,
    pub last_y: f32,
    pub current_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectPointsResponse {
    pub collected_points: Vec<StrokePoint>,
    pub last_time: u64,
    pub last_x: f32,
    pub last_y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathSmoothRequest {
    pub points: Vec<StrokePoint>,
    pub smoothness: f32,
    pub algorithm: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportCullRequest {
    pub strokes: Vec<Stroke>,
    pub viewport: Viewport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

// 内部函数：计算两点距离
#[inline]
fn distance(x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let dx = x2 - x1;
    let dy = y2 - y1;
    (dx * dx + dy * dy).sqrt()
}

// 内部函数：量化坐标
#[inline]
fn quantize_coord(coord: f32, step: f32) -> f32 {
    (coord / step).round() * step
}

// 内部函数：点到线段的垂直距离
#[inline]
fn perpendicular_distance(px: f32, py: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let a = px - x1;
    let b = py - y1;
    let c = x2 - x1;
    let d = y2 - y1;
    
    let dot = a * c + b * d;
    let len_sq = c * c + d * d;
    let mut param = -1.0;
    
    if len_sq != 0.0 {
        param = dot / len_sq;
    }
    
    let (xx, yy) = if param < 0.0 {
        (x1, y1)
    } else if param > 1.0 {
        (x2, y2)
    } else {
        (x1 + param * c, y1 + param * d)
    };
    
    distance(px, py, xx, yy)
}

// 内部函数：点简化
#[inline]
fn simplify_points_iterative(points: &[StrokePoint], epsilon: f32) -> Vec<StrokePoint> {
    let point_count = points.len();
    if point_count == 0 {
        return Vec::new();
    }
    
    if point_count <= 2 {
        return points.to_vec();
    }
    
    let mut result = Vec::with_capacity(point_count);
    let mut stack = Vec::with_capacity(16);
    
    stack.push((0, point_count - 1));
    
    while let Some((start, end)) = stack.pop() {
        if start >= end || start >= point_count || end >= point_count {
            if start < point_count {
                result.push(points[start].clone());
            }
            continue;
        }
        
        let mut max_dist = 0.0;
        let mut max_index = start;
        
        let start_point = &points[start];
        let end_point = &points[end];
        
        let step = if end - start > 100 {
            (end - start) / 100
        } else {
            1
        };
        
        let step = step.max(1);
        
        for i in ((start + 1)..end).step_by(step) {
            if i >= point_count {
                break;
            }
            let point = &points[i];
            let dist = perpendicular_distance(
                point.from_x,
                point.from_y,
                start_point.from_x,
                start_point.from_y,
                end_point.to_x,
                end_point.to_y
            );
            
            if dist > max_dist {
                max_dist = dist;
                max_index = i;
            }
        }
        
        let fine_start = (max_index.saturating_sub(step)).max(start + 1);
        let fine_end = (max_index + step).min(end - 1);
        
        if fine_start <= fine_end {
            for i in fine_start..=fine_end {
                if i >= point_count {
                    break;
                }
                let point = &points[i];
                let dist = perpendicular_distance(
                    point.from_x,
                    point.from_y,
                    start_point.from_x,
                    start_point.from_y,
                    end_point.to_x,
                    end_point.to_y
                );
                
                if dist > max_dist {
                    max_dist = dist;
                    max_index = i;
                }
            }
        }
        
        if max_dist > epsilon {
            stack.push((max_index, end));
            stack.push((start, max_index));
        } else {
            result.push(points[start].clone());
            result.push(points[end].clone());
        }
    }
    
    let mut unique_result = Vec::with_capacity(result.len());
    for point in result {
        if unique_result.is_empty() || {
            let last: &StrokePoint = unique_result.last().unwrap();
            !((point.from_x - last.from_x).abs() < 0.001 &&
              (point.from_y - last.from_y).abs() < 0.001 &&
              (point.to_x - last.to_x).abs() < 0.001 &&
              (point.to_y - last.to_y).abs() < 0.001)
        } {
            unique_result.push(point);
        }
    }
    
    unique_result
}

// 内部函数：线段与矩形相交检测
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

// 导出函数：处理笔画点
#[wasm_bindgen]
pub fn process_stroke_points(request_json: &str) -> String {
    let request: ProcessPointsRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_string(&ErrorResponse {
                error: format!("Failed to parse request: {}", e)
            }).unwrap_or_default();
        }
    };
    let mut processed_points = Vec::new();
    
    for point in request.points {
        let q_from_x = quantize_coord(point.from_x, request.config.quantization);
        let q_from_y = quantize_coord(point.from_y, request.config.quantization);
        let q_to_x = quantize_coord(point.to_x, request.config.quantization);
        let q_to_y = quantize_coord(point.to_y, request.config.quantization);
        
        if distance(q_from_x, q_from_y, q_to_x, q_to_y) >= request.config.min_distance {
            processed_points.push(StrokePoint {
                from_x: q_from_x,
                from_y: q_from_y,
                to_x: q_to_x,
                to_y: q_to_y,
            });
        }
    }
    
    let simplified = simplify_points_iterative(&processed_points, request.config.epsilon);
    
    serde_json::to_string(&simplified).unwrap_or_default()
}

// 导出函数：收集点
#[wasm_bindgen]
pub fn collect_points(request_json: &str) -> String {
    let request: CollectPointsRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_string(&ErrorResponse {
                error: format!("Failed to parse request: {}", e)
            }).unwrap_or_default();
        }
    };
    
    let mut collected_points = Vec::new();
    let mut last_time = request.last_time;
    
    for point in request.points {
        let q_from_x = quantize_coord(point.from_x, request.config.quantization);
        let q_from_y = quantize_coord(point.from_y, request.config.quantization);
        let q_to_x = quantize_coord(point.to_x, request.config.quantization);
        let q_to_y = quantize_coord(point.to_y, request.config.quantization);
        
        if distance(q_from_x, q_from_y, q_to_x, q_to_y) < request.config.min_distance {
            continue;
        }
        
        let now = request.current_time;
        
        if now - last_time < 30 {
            continue;
        }
        
        last_time = now;
        
        collected_points.push(StrokePoint {
            from_x: q_from_x,
            from_y: q_from_y,
            to_x: q_to_x,
            to_y: q_to_y
        });
        
        if collected_points.len() > 1500 {
            collected_points = simplify_points_iterative(&collected_points, request.config.epsilon);
        }
    }
    
    let response = CollectPointsResponse {
        collected_points,
        last_time,
        last_x: 0.0,
        last_y: 0.0
    };
    
    serde_json::to_string(&response).unwrap_or_default()
}

// 导出函数：批量处理绘制命令
#[wasm_bindgen]
pub fn batch_process_draw_commands(request_json: &str) -> String {
    let request: BatchProcessDrawCommandsRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_string(&ErrorResponse {
                error: format!("Failed to parse request: {}", e)
            }).unwrap_or_default();
        }
    };
    
    use std::collections::HashMap;
    let mut groups: HashMap<String, Vec<DrawCommand>> = HashMap::new();
    
    for command in request.commands {
        let dist = distance(command.from_x, command.from_y, command.to_x, command.to_y);
        if dist < request.min_distance {
            continue;
        }
        
        let key = format!("{}_{}_{}", command.r#type, command.color, command.line_width);
        groups.entry(key).or_default().push(command);
    }
    
    let mut optimized_commands = Vec::new();
    
    for (_, commands) in groups {
        optimized_commands.extend(commands);
    }
    
    serde_json::to_string(&optimized_commands).unwrap_or_default()
}

// 导出函数：路径平滑
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

// 导出函数：视口裁剪
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
