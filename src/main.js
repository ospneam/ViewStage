/**
 * ViewStage 主逻辑 —— 摄像头及展台应用核心
 * 架构: 图像层(img) + 批注层(canvas)，批注系统含笔画记录/压缩/撤销，图像处理由Rust后端并行
 * 性能: RAF批量绘制减少重绘；Blob URL替代Data URL节省内存
 */

import './batch-draw.js';
import ThemeManager from './themes/theme.js';
import {
    history_execute_command,
    DrawCommand,
    ClearCommand,
    SnapshotCommand,
    history_validate_undo,
    history_handle_undo,
    history_delete_all,
    history_validate_compact,
    history_fetch_undo_stack,
    history_fetch_commands_to_compact,
    history_format_compact,
    MAX_HISTORY_STEPS
} from './history.js';
import { DocLoader } from './modules/pdf/document_loader.js';

// === 全局变量 ===
let last_canvas_transform = { x: null, y: null, scale: null };
let currentAnimationId = null;
let pending_transform = null;
let transform_raf_id = null;

function main_update_transform_schedule(x, y, scale) {
    if (!pending_transform) {
        pending_transform = { x: 0, y: 0, scale: 1 };
    }
    pending_transform.x = x;
    pending_transform.y = y;
    pending_transform.scale = scale;
    
    if (transform_raf_id === null) {
        transform_raf_id = requestAnimationFrame(() => {
            if (pending_transform) {
                const pt = pending_transform;
                dom.canvasWrapper.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0) scale(${pt.scale})`;
                last_canvas_transform.x = pt.x;
                last_canvas_transform.y = pt.y;
                last_canvas_transform.scale = pt.scale;
                if (window.tileRenderer) {
                    window.tileRenderer.cancel_idle_shrink();
                    window.tileRenderer.update_visible_tile_dpr(pt.scale);
                }
            }
            transform_raf_id = null;
        });
    }
}

// === PDF.js 配置 ===
function main_init_pdfjs() {
    return DocLoader.init_pdfjs();
}

async function main_wait_pdfjs(maxWait = 5000) {
    return DocLoader.wait_pdfjs(maxWait);
}

// === 全局配置 ===

const DRAW_CONFIG = {
    penColor: null,
    penWidth: 5,
    penSizePresets: [2, 5, 10, 15, 21],
    eraserSize: 15,
    minScale: 0.5,
    maxScale: 3,
    maxScaleCamera: 2,
    maxScaleImage: 4,
    canvasW: 1000,
    canvasH: 600,
    screenW: 0,
    screenH: 0,
    dprLimit: 2,
    dpr: 1,
    dynamicDprEnabled: true,
    dprMin: 1,
    dprMax: 4,
    dprStep: 0.5,
    imageSmoothingQuality: 'high',
    baseDpr: window.devicePixelRatio || 1,
    canvasBgColor: '#2a2a2a',
    penColors: [
        '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
        '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e',
        '#14b8a6', '#64748b', '#1e293b', '#000000', '#ffffff'
    ],
    penSmoothness: 0.8,
    penEffectMode: 'limited'
};

// 选中第一号颜色作为默认笔色
if (DRAW_CONFIG.penColor === null && DRAW_CONFIG.penColors.length > 0) {
    DRAW_CONFIG.penColor = DRAW_CONFIG.penColors[0];
}

// 将配置暴露到全局，供 batch-draw.js 使用
window.DRAW_CONFIG = DRAW_CONFIG;

// 应用 DPR 限制（0=自动无限制）
function main_calc_capped_dpr(rawDpr, limit) {
    return limit > 0 ? Math.min(rawDpr, limit) : rawDpr;
}
window.main_calc_capped_dpr = main_calc_capped_dpr;

function main_fetch_safe_scale() {
    return Math.max(0.001, state.scale || 1);
}
window.main_fetch_safe_scale = main_fetch_safe_scale;

// === 钢笔笔锋效果管理器 ===
// 使用曲面细分算法，根据速度和压感动态调整线宽
// 效果分级: full(完整) | limited(限制) | off(关闭)

class RealPenManager {
    constructor() {
        this.tessellator = null;
        this.cached_tessellated = new WeakMap();
    }

    init_tessellator() {
        if (!this.tessellator && window.penTessellator) {
            this.tessellator = window.penTessellator;
        }
    }
    
    reset() {
        this.cached_tessellated = new WeakMap();
        this.init_tessellator();
    }
    
    update_position(x, y, timestamp) {
        return 0;
    }
    
    calc_line_width(baseWidth, velocity, pressure = 0.5) {
        const speedScale = Math.max(0.4, Math.min(2.5, baseWidth / 4));
        const maxSpeed = 2.5 * speedScale;
        const minSpeed = 0.2 * speedScale;
        const clamped = Math.max(0, Math.min(1, (velocity - minSpeed) / (maxSpeed - minSpeed)));
        const eased = clamped * clamped * (3 - 2 * clamped);
        const speedFactor = 1 - eased * 0.75;
        const pressureFactor = 0.85 + (pressure * 0.3);
        return baseWidth * speedFactor * pressureFactor;
    }

    _build_smooth_points(rawPoints, smoothness) {
        if (rawPoints.length < 2) return rawPoints;

        const result = [];
        const steps = Math.max(3, Math.round(smoothness * 10));
        const ctrl = rawPoints;

        for (let i = 0; i < ctrl.length - 1; i++) {
            const p0 = ctrl[Math.max(0, i - 1)];
            const p1 = ctrl[i];
            const p2 = ctrl[Math.min(ctrl.length - 1, i + 1)];
            const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];

            for (let j = 0; j <= steps; j++) {
                if (i > 0 && j === 0) continue;
                const t = j / steps;
                const t2 = t * t;
                const t3 = t2 * t;
                const x = 0.5 * (
                    (2 * p1.x) +
                    (-p0.x + p2.x) * t +
                    (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                    (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
                );
                const y = 0.5 * (
                    (2 * p1.y) +
                    (-p0.y + p2.y) * t +
                    (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                    (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
                );
                result.push({ x, y });
            }
        }

        return result;
    }

    build_tessellated_stroke(stroke, mode = null) {
        this.init_tessellator();
        if (!this.tessellator) return null;
        
        const effect_mode = mode || DRAW_CONFIG.penEffectMode || 'off';
        if (effect_mode === 'off') return null;
        
        if (this.cached_tessellated.has(stroke)) {
            return this.cached_tessellated.get(stroke);
        }
        
        const points = stroke.points;
        const base_width = stroke.lineWidth || DRAW_CONFIG.penWidth;
        const color = stroke.color || DRAW_CONFIG.penColor;
        const storedWidths = stroke.storedWidths;
        
        if (!points || points.length < 1) return null;

        // 有存储宽度时：直接构建 segments，绕过 tessellator 的速度重算
        // 存储宽度来自 batch-draw 的实时计算（含真实指针时序），确保与预览完全一致
        if (storedWidths && storedWidths.length === points.length) {
            const raw = [{ x: points[0].fromX, y: points[0].fromY }];
            for (let i = 0; i < points.length; i++) {
                raw.push({ x: points[i].toX, y: points[i].toY });
            }
            if (raw.length < 2) return null;

            const segments = [];
            for (let i = 0; i < storedWidths.length; i++) {
                segments.push({
                    x1: raw[i].x, y1: raw[i].y,
                    x2: raw[i + 1].x, y2: raw[i + 1].y,
                    line_width: Math.max(0.5, storedWidths[i])
                });
            }

            const result = { segments, color };
            if (result) {
                this.cached_tessellated.set(stroke, result);
            }
            return result;
        }

        // 无存储宽度：走标准 tessellator 速度重算路径
        const raw = [{ x: points[0].fromX, y: points[0].fromY }];
        for (let i = 0; i < points.length; i++) {
            raw.push({ x: points[i].toX, y: points[i].toY });
        }
        if (raw.length < 2) return null;

        const filtered = [raw[0]];
        for (let i = 1; i < raw.length; i++) {
            const prev = filtered[filtered.length - 1];
            const curr = raw[i];
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            if (dx * dx + dy * dy >= 1) {
                filtered.push(curr);
            }
        }
        if (filtered.length < 2) return null;

        let input_points;
        let density = 1;
        if (effect_mode === 'full') {
            const smoothness = DRAW_CONFIG.penSmoothness ?? 0.8;
            const steps = Math.max(3, Math.round(smoothness * 10));
            density = steps;
            input_points = this._build_smooth_points(filtered, smoothness);
        } else if (effect_mode === 'limited') {
            const smoothness = (DRAW_CONFIG.penSmoothness ?? 0.8) * 0.5;
            const steps = Math.max(3, Math.round(smoothness * 10));
            density = Math.max(2, steps);
            input_points = this._build_smooth_points(filtered, smoothness);
        } else {
            input_points = filtered;
        }
        if (!input_points || input_points.length < 2) return null;

        const stroke_data = [];
        for (let i = 0; i < input_points.length; i++) {
            if (i === 0) {
                stroke_data.push({ fromX: input_points[i].x, fromY: input_points[i].y, toX: input_points[i].x, toY: input_points[i].y });
            } else {
                const prev = input_points[i - 1];
                stroke_data.push({ fromX: prev.x, fromY: prev.y, toX: input_points[i].x, toY: input_points[i].y });
            }
        }

        const result = this.tessellator.tessellator_build_stroke_from_stroke_data(
            { points: stroke_data, lineWidth: base_width, color },
            { density, noStartTaper: stroke.noStartTaper }
        );
        
        if (result) {
            this.cached_tessellated.set(stroke, result);
        }
        return result;
    }

    render_tessellated_stroke(ctx, tessellated_stroke) {
        this.init_tessellator();
        if (!this.tessellator || !tessellated_stroke) return false;
        
        this.tessellator.tessellator_render_stroke(ctx, tessellated_stroke);
        return true;
    }
    
    invalidate_cache() {
        this.cached_tessellated = new WeakMap();
    }
}

const realPenManager = new RealPenManager();

function main_stroke_clone(strokes, deep = false) {
    if (!strokes || strokes.length === 0) return [];
    if (deep) {
        return strokes.map(stroke => ({
            type: stroke.type,
            points: stroke.points ? stroke.points.map(p => ({ ...p })) : [],
            color: stroke.color,
            lineWidth: stroke.lineWidth,
            eraserSize: stroke.eraserSize,
            eraserSizeRaw: stroke.eraserSizeRaw,
            scale: stroke.scale,
            bounds: stroke.bounds ? { ...stroke.bounds } : undefined,
            variableWidths: stroke.variableWidths ? [...stroke.variableWidths] : null,
            storedWidths: stroke.storedWidths ? [...stroke.storedWidths] : undefined,
            noStartTaper: stroke.noStartTaper,
            savedStrokeHistory: stroke.savedStrokeHistory ? main_stroke_clone(stroke.savedStrokeHistory, true) : undefined,
            savedBaseImageURL: stroke.savedBaseImageURL
        }));
    }
    return strokes.map(stroke => ({
        type: stroke.type,
        points: stroke.points,
        color: stroke.color,
        lineWidth: stroke.lineWidth,
        eraserSize: stroke.eraserSize,
        eraserSizeRaw: stroke.eraserSizeRaw,
        scale: stroke.scale,
        bounds: stroke.bounds,
        variableWidths: stroke.variableWidths,
        storedWidths: stroke.storedWidths,
        noStartTaper: stroke.noStartTaper,
        savedStrokeHistory: stroke.savedStrokeHistory,
        savedBaseImageURL: stroke.savedBaseImageURL
    }));
}

function main_main_stroke_clone_deep(strokes) {
    return main_stroke_clone(strokes, true);
}

// StrokeQuadTree —— 四叉树空间索引，用于快速查找与脏区域相交的笔画
class StrokeQuadTree {
    constructor(boundary, capacity = 8, maxDepth = 6, depth = 0) {
        this.boundary = boundary;
        this.capacity = capacity;
        this.maxDepth = maxDepth;
        this.depth = depth;
        this.strokes = [];
        this.children = null;
    }
    
    insert(stroke) {
        if (!stroke.bounds) return false;
        
        if (!this.intersects(stroke.bounds)) return false;
        
        if (this.children) {
            return this.insert_to_children(stroke);
        }
        
        this.strokes.push(stroke);
        
        if (this.strokes.length > this.capacity && this.depth < this.maxDepth) {
            this.subdivide();
        }
        
        return true;
    }
    
    insert_to_children(stroke) {
        let inserted = false;
        for (const child of this.children) {
            if (child.insert(stroke)) {
                inserted = true;
            }
        }
        return inserted;
    }
    
    subdivide() {
        const { x, y, width, height } = this.boundary;
        const hw = width / 2;
        const hh = height / 2;
        
        this.children = [
            new StrokeQuadTree({ x, y, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1),
            new StrokeQuadTree({ x: x + hw, y, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1),
            new StrokeQuadTree({ x, y: y + hh, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1),
            new StrokeQuadTree({ x: x + hw, y: y + hh, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1)
        ];
        
        for (const stroke of this.strokes) {
            this.insert_to_children(stroke);
        }
        this.strokes = [];
    }
    
    query(range, found = new Set()) {
        if (!this.intersects(range)) return found;
        
        for (const stroke of this.strokes) {
            if (this.stroke_intersects(stroke, range)) {
                found.add(stroke);
            }
        }
        
        if (this.children) {
            for (const child of this.children) {
                child.query(range, found);
            }
        }
        
        return found;
    }
    
    intersects(bounds) {
        const padding = 5;
        const bMinX = bounds.minX != null ? bounds.minX : bounds.x;
        const bMaxX = bounds.maxX != null ? bounds.maxX : bounds.x + bounds.width;
        const bMinY = bounds.minY != null ? bounds.minY : bounds.y;
        const bMaxY = bounds.maxY != null ? bounds.maxY : bounds.y + bounds.height;
        return !(bMaxX + padding < this.boundary.x ||
                 bMinX - padding > this.boundary.x + this.boundary.width ||
                 bMaxY + padding < this.boundary.y ||
                 bMinY - padding > this.boundary.y + this.boundary.height);
    }
    
    stroke_intersects(stroke, range) {
        if (!stroke.bounds) return true;
        const padding = Math.max(stroke.lineWidth || 5, stroke.eraserSize || 5);
        return !(stroke.bounds.maxX + padding < range.x ||
                 stroke.bounds.minX - padding > range.x + range.width ||
                 stroke.bounds.maxY + padding < range.y ||
                 stroke.bounds.minY - padding > range.y + range.height);
    }
    
    clear() {
        this.strokes = [];
        this.children = null;
    }
    
    build(strokes) {
        this.clear();
        for (const stroke of strokes) {
            this.insert(stroke);
        }
    }
}

// 全局四叉树索引
let strokeQuadTree = null;

// === 全局状态 ===

let state = {
    drawMode: 'move',
    isDrawing: false,
    isDragging: false,
    isScaling: false,
    canvasX: 0,
    canvasY: 0,
    scale: 1,
    lastX: 0,
    lastY: 0,
    cameraViewState: {
        scale: 1,
        canvasX: 0,
        canvasY: 0,
        strokeHistory: [],
        baseImageURL: null
    },
    startDragX: 0,
    startDragY: 0,
    startScale: 1,
    startDistanceSq: 0,
    startScaleX: 0,
    startScaleY: 0,
    startCanvasX: 0,
    startCanvasY: 0,
    strokeHistory: [],
    baseImageURL: null,
    baseImageObj: null,
    baseImageLoadId: 0,
    currentStroke: null,
    moveBound: {
        minX: 0, maxX: 0,
        minY: 0, maxY: 0
    },
    cameraStream: null,
    isCameraOpen: false,
    isCameraReady: false,
    cameraAvailable: true,
    isMirrored: false,
    cameraAnimationId: null,
    cameraRotation: 0,
    camera_brightness: 10,
    camera_contrast: 1.4,
    useFrontCamera: false,
    defaultCameraId: null,
    cameraWidth: 1280,
    cameraHeight: 720,
    wasCameraOpenBeforeMinimize: false,
    currentImage: null,
    imageList: [],
    currentImageIndex: -1,
    fileList: [],
    currentFolderIndex: -1,
    currentFolderPageIndex: -1,
    pdfDocuments: new Map(),
    loadedPages: new Set(),
    currentPressure: 0.5,
    currentVelocity: 0,
    currentLineWidth: 0,
    lastLineWidth: 0
};

const MAX_PDF_CACHE = 10;

// === 源ID管理系统 ===
// 统一管理所有源（摄像头、图片、文档）的缩放和批注数据

let sourceIdCounters = {
    pic: 0,
    doc: 0
};

function main_calculate_md5(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const original_len = data.length;
    const padded_len = (((original_len + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(padded_len);
    buffer.set(data);
    buffer[original_len] = 0x80;

    const bit_len = original_len * 8;
    for (let i = 0; i < 8; i++) {
        buffer[padded_len - 8 + i] = Math.floor(bit_len / Math.pow(256, i)) & 0xff;
    }

    const shifts = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const table = Array.from({ length: 64 }, (_, i) =>
        Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
    );

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const add32 = (a, b) => (a + b) >>> 0;
    const left_rotate = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

    for (let offset = 0; offset < padded_len; offset += 64) {
        const m = new Uint32Array(16);
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            m[i] = (buffer[j] | (buffer[j + 1] << 8) | (buffer[j + 2] << 16) | (buffer[j + 3] << 24)) >>> 0;
        }

        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;

        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const tmp = d;
            d = c;
            c = b;
            b = add32(b, left_rotate(add32(add32(a, f >>> 0), add32(table[i], m[g])), shifts[i]));
            a = tmp;
        }

        a0 = add32(a0, a);
        b0 = add32(b0, b);
        c0 = add32(c0, c);
        d0 = add32(d0, d);
    }

    const word_to_hex = (word) => {
        let out = '';
        for (let i = 0; i < 4; i++) {
            out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return out;
    };

    return word_to_hex(a0) + word_to_hex(b0) + word_to_hex(c0) + word_to_hex(d0);
}

let currentSourceId = null;

let sourceDataStore = {};

const MAX_SOURCE_CACHE = 50;

// 生成源ID
function main_create_source_id(type, pageIndex = null) {
    if (type === 'cam') {
        return 'cam';
    } else if (type === 'pic') {
        sourceIdCounters.pic++;
        return `pic-${sourceIdCounters.pic}`;
    } else if (type === 'doc') {
        if (pageIndex !== null && pageIndex !== undefined) {
            return `doc-${sourceIdCounters.doc}-${pageIndex}`;
        } else {
            console.error('[错误] main_create_source_id: 文档类型必须提供pageIndex参数');
            sourceIdCounters.doc++;
            return `doc-${sourceIdCounters.doc}-unknown`;
        }
    }
    
    console.error(`[错误] main_create_source_id: 未知的类型参数: ${type}`);
    return `unknown-${Date.now()}`;
}

// 保存当前源数据
function main_save_current_source_data() {
    if (!currentSourceId) return;
    
    const keys = Object.keys(sourceDataStore);
    if (keys.length >= MAX_SOURCE_CACHE && !sourceDataStore[currentSourceId]) {
        let oldestKey = null;
        let oldestTime = Infinity;
        
        for (const key of keys) {
            if (sourceDataStore[key].timestamp < oldestTime) {
                oldestTime = sourceDataStore[key].timestamp;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            delete sourceDataStore[oldestKey];
            console.log(`[源管理] 缓存已满,移除最旧的源: ${oldestKey}`);
        }
    }
    
    sourceDataStore[currentSourceId] = {
        scale: state.scale,
        canvasX: state.canvasX,
        canvasY: state.canvasY,
        strokeHistory: main_main_stroke_clone_deep(state.strokeHistory),
        baseImageURL: state.baseImageURL,
        timestamp: Date.now()
    };
    
    console.log(`[源管理] 保存数据: ${currentSourceId}, 缩放: ${state.scale.toFixed(2)}, 笔画: ${state.strokeHistory.length}`);
}

// 加载指定源数据
function main_load_source_data(sourceId) {
    if (!sourceId) {
        console.warn('[源管理] main_load_source_data: sourceId为空,跳过加载');
        return;
    }
    
    const data = sourceDataStore[sourceId];
    if (data) {
        state.scale = data.scale || 1;
        state.canvasX = data.canvasX || -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
        state.canvasY = data.canvasY || -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;
        state.strokeHistory = main_main_stroke_clone_deep(data.strokeHistory || []);
        state.baseImageURL = data.baseImageURL || null;
        state.baseImageObj = null;
        history_delete_all();
        
        data.timestamp = Date.now();
        
        console.log(`[源管理] 加载数据: ${sourceId}, 缩放: ${state.scale.toFixed(2)}, 笔画: ${state.strokeHistory.length}`);
    } else {
        // 新源，使用默认值
        state.scale = 1;
        state.canvasX = -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
        state.canvasY = -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;
        state.strokeHistory = [];
        state.baseImageURL = null;
        state.baseImageObj = null;
        history_delete_all();
        
        console.log(`[源管理] 新源初始化: ${sourceId}`);
    }
    
    currentSourceId = sourceId;
}

// 切换到新源：保存当前源 → 加载目标源 → 重绘 → 刷新UI
async function main_update_source(newSourceId) {
    main_save_current_source_data();
    main_load_source_data(newSourceId);
    main_delete_draw_canvas();
    if (state.strokeHistory.length > 0) {
        await main_render_all_strokes();
    }
    main_update_move_bound();
    main_update_canvas_position();
    main_update_canvas_transform();
    main_update_history_button_status();
}

let dom = {};  // DOM 元素引用缓存

// 将 dom 暴露到全局，供 batch-draw.js 使用
window.dom = dom;
window.state = state;

let cachedCanvasRect = null;
let cachedVisibleRect = null;
let cachedVisibleRectScale = null;
let cachedVisibleRectX = null;
let cachedVisibleRectY = null;

const OFFSCREEN_MAX_PHYSICAL = 3840;
const OFFSCREEN_POOL_MAX = 2;
const OFFSCREEN_POOL_IDLE_MS = 30000;
const _offscreenPool = [];
let _offscreenPoolTimer = null;

function main_clear_offscreen_pool() {
    for (const entry of _offscreenPool) {
        entry.canvas = null;
        entry.ctx = null;
    }
    _offscreenPool.length = 0;
}

function main_schedule_offscreen_pool_evict() {
    clearTimeout(_offscreenPoolTimer);
    _offscreenPoolTimer = setTimeout(() => {
        _offscreenPoolTimer = null;
        main_clear_offscreen_pool();
    }, OFFSCREEN_POOL_IDLE_MS);
}

function main_fetch_offscreen_canvas() {
    clearTimeout(_offscreenPoolTimer);
    let w = DRAW_CONFIG.canvasW * DRAW_CONFIG.dpr;
    let h = DRAW_CONFIG.canvasH * DRAW_CONFIG.dpr;
    if (w > OFFSCREEN_MAX_PHYSICAL || h > OFFSCREEN_MAX_PHYSICAL) {
        const s = OFFSCREEN_MAX_PHYSICAL / Math.max(w, h);
        w = Math.round(w * s);
        h = Math.round(h * s);
    }
    let entry;
    for (let i = _offscreenPool.length - 1; i >= 0; i--) {
        if (_offscreenPool[i].canvas.width >= w && _offscreenPool[i].canvas.height >= h) {
            entry = _offscreenPool.splice(i, 1)[0];
            break;
        }
    }
    if (!entry) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { alpha: true });
        entry = { canvas, ctx };
    }
    entry.canvas.width = w;
    entry.canvas.height = h;
    entry.ctx.setTransform(1, 0, 0, 1, 0, 0);
    entry.ctx.scale(w / DRAW_CONFIG.canvasW, h / DRAW_CONFIG.canvasH);
    return entry;
}

function main_release_offscreen_canvas(offscreen) {
    if (_offscreenPool.length < OFFSCREEN_POOL_MAX) {
        _offscreenPool.push(offscreen);
    }
    main_schedule_offscreen_pool_evict();
}

function main_delete_cached_rect() {
    cachedCanvasRect = null;
}

function main_fetch_cached_canvas_rect() {
    if (!cachedCanvasRect) {
        cachedCanvasRect = dom.canvasContainer.getBoundingClientRect();
    }
    return cachedCanvasRect;
}

// 监听系统关联打开的PDF文件
function main_setup_pdf_file_open() {
    if (!window.__TAURI__) {
        console.log('非 Tauri 环境，跳过文件打开监听');
        return;
    }
    
    console.log('开始注册文件打开事件监听...');
    
    const { listen } = window.__TAURI__.event;
    
    listen('file-opened', (event) => {
        console.log('========== 收到文件打开事件 ==========');
        console.log('完整事件对象:', JSON.stringify(event, null, 2));
        console.log('Payload 类型:', typeof event.payload);
        console.log('Payload 内容:', event.payload);
        
        let filePath = event.payload;
        
        if (typeof filePath === 'string') {
            if (filePath.startsWith('file://')) {
                filePath = decodeURIComponent(filePath.replace('file://', ''));
            }
            console.log('最终文件路径:', filePath);
            main_load_pdf_from_path(filePath);
        } else {
            console.error('无法解析文件路径，payload:', event.payload);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.fileError') || '文件错误',
                window.i18n?.format_translate('errors.fileParseError') || '无法解析文件路径'
            );
        }
    }).then(() => {
        console.log('file-opened 事件监听注册成功');
    }).catch(err => {
        console.error('注册 file-opened 事件监听失败:', err);
    });
    
    listen('opener://open-file', (event) => {
        console.log('========== 收到 opener 事件 ==========');
        console.log('完整事件对象:', JSON.stringify(event, null, 2));
        
        let filePath = null;
        
        if (typeof event.payload === 'string') {
            filePath = event.payload;
        } else if (event.payload && typeof event.payload === 'object') {
            filePath = event.payload.path || event.payload.url || event.payload.filePath || event.payload.uri;
        }
        
        if (filePath) {
            if (filePath.startsWith('file://')) {
                filePath = decodeURIComponent(filePath.replace('file://', ''));
            }
            console.log('最终文件路径:', filePath);
            main_load_pdf_from_path(filePath);
        }
    }).catch(err => {
        console.log('opener 事件监听可选:', err);
    });
    
    listen('rotate-image', (event) => {
        const direction = event.payload;
        main_update_image_rotation(direction);
    }).catch(err => {
        console.error('rotate-image 事件监听失败:', err);
    });
    
    listen('mirror-changed', (event) => {
        state.isMirrored = event.payload;
        if (state.isCameraOpen) {
            main_update_camera_video_style();
        }
        console.log('镜像状态已更改:', state.isMirrored);
    }).catch(err => {
        console.error('mirror-changed 事件监听失败:', err);
    });
    
    listen('switch-camera', () => {
        main_update_camera();
        console.log('切换摄像头');
    }).catch(err => {
        console.error('switch-camera 事件监听失败:', err);
    });
    
    listen('settings-changed', (event) => {
        const settings = event.payload;
        console.log('收到设置更改通知:', settings);
        
        let needRestartCamera = false;
        
        if (settings.defaultCamera !== undefined) {
            state.defaultCameraId = settings.defaultCamera;
            console.log('默认摄像头已更改:', settings.defaultCamera);
            needRestartCamera = true;
        }
        
        if (settings.cameraWidth !== undefined && settings.cameraHeight !== undefined) {
            state.cameraWidth = settings.cameraWidth;
            state.cameraHeight = settings.cameraHeight;
            console.log('摄像头分辨率已更改:', settings.cameraWidth, 'x', settings.cameraHeight);
            needRestartCamera = true;
        }
        
        if (settings.dynamicDprEnabled !== undefined) {
            DRAW_CONFIG.dynamicDprEnabled = settings.dynamicDprEnabled;
        }
        if (settings.dprMin !== undefined) {
            DRAW_CONFIG.dprMin = settings.dprMin;
        }
        if (settings.dprMax !== undefined) {
            DRAW_CONFIG.dprMax = settings.dprMax;
        }
        if (settings.dprStep !== undefined) {
            DRAW_CONFIG.dprStep = settings.dprStep;
        }
        if (settings.dynamicDprEnabled !== undefined || settings.dprMin !== undefined ||
            settings.dprMax !== undefined || settings.dprStep !== undefined) {
            if (window.tileRenderer) {
                window.tileRenderer.update_visible_tile_dpr(state.scale, true, true);
            }
        }

        if (settings.penColors && Array.isArray(settings.penColors)) {
            DRAW_CONFIG.penColors = settings.penColors.map(color => {
                if (typeof color === 'object' && color.r !== undefined) {
                    return main_calc_rgb_to_hex(color.r, color.g, color.b);
                }
                return color;
            });
            main_update_color_buttons();
            console.log('画笔颜色已更改:', DRAW_CONFIG.penColors);
        }
        
        if (settings.penSizePresets && Array.isArray(settings.penSizePresets)) {
            DRAW_CONFIG.penSizePresets = settings.penSizePresets;
            main_build_pen_presets(settings.penSizePresets);
            console.log('画笔预设已更改:', settings.penSizePresets);
        }
        
        if (settings.theme !== undefined) {
            ThemeManager.theme_update_active(settings.theme).then(() => {
                const canvasBgColor = ThemeManager.theme_fetch_canvas_bg_color();
                DRAW_CONFIG.canvasBgColor = canvasBgColor;
                main_update_canvas_bg_color(canvasBgColor);
                
                const noCameraMsg = document.getElementById('noCameraMessage');
                if (noCameraMsg && noCameraMsg.style.display !== 'none') {
                    const style = ThemeManager.theme_fetch_no_camera_style();
                    noCameraMsg.innerHTML = `
                        <div style="font-size: 2.5vw; color: ${style.textColor}; margin-bottom: 2vh; text-shadow: ${style.textShadow};">( $ _ $ )</div>
                        <div style="font-size: 1.2vw; color: ${style.secondaryTextColor}; margin-bottom: 1vh; text-shadow: ${style.textShadow};">${window.i18n?.format_translate('camera.deviceNotFound') || '找不到展台设备'}</div>
                        <div style="font-size: 0.9vw; color: ${style.tertiaryTextColor}; text-shadow: ${style.textShadow};">${noCameraMsg.dataset.message || ''}</div>
                    `;
                }
                
                console.log('主题已更改:', settings.theme);
            });
        }

        if (settings.blackboardEnabled !== undefined) {
            const bb = window.blackboardManager;
            if (settings.blackboardEnabled === false) {
                if (bb && bb.is_open) {
                    bb.close();
                }
                dom.btnBlackboard.style.display = 'none';
            } else {
                dom.btnBlackboard.style.display = '';
            }
        }
        
        if (needRestartCamera && state.isCameraOpen) {
            console.log('摄像头设置已更改，重新初始化摄像头...');
            main_update_camera_state(false).then(() => {
                setTimeout(() => {
                    main_update_camera_state(true);
                }, 300);
            });
        }
    }).catch(err => {
        console.error('settings-changed 事件监听失败:', err);
    });
    
}

async function main_render_pdf_pages_lazy(pdf, totalPages, initialPages = 3, docNumber = null) {
    return DocLoader.render_pdf_pages_lazy(pdf, totalPages, initialPages, docNumber);
}

const PDF_INITIAL_RENDER_PAGES = 20;

async function main_load_pdf_from_path(filePath) {
    if (currentSourceId) {
        main_save_current_source_data();
    }
    
    const wasCameraOpen = state.isCameraOpen;
    
    if (state.isCameraOpen) {
        await main_update_camera_state(false);
    }
    
    console.log('开始加载文件:', filePath);
    
    const fileName_lower = filePath.toLowerCase();
    const isWord = fileName_lower.endsWith('.docx') || fileName_lower.endsWith('.doc');
    
    if (isWord) {
        main_show_loading_overlay(window.i18n?.format_translate('loading.detectingOffice') || '正在检测 Office 软件...');
        
        const { invoke } = window.__TAURI__.core;
        const { fs } = window.__TAURI__;
        
        let detection;
        try {
            detection = await invoke('office_detect_all');
            console.log('Office 检测结果:', detection);
            if (detection.recommended === 'None') {
                main_hide_loading_overlay();
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.officeNotInstalled') || 'Office 未安装',
                    window.i18n?.format_translate('errors.officeNotInstalledDesc') || '未检测到可用的 Office 软件\n\n请安装以下软件之一：\n• Microsoft Word\n• WPS Office\n• LibreOffice\n\n或将 Word 文档另存为 PDF 后导入'
                );
                if (wasCameraOpen) await main_update_camera_state(true);
                return;
            }
        } catch (e) {
            main_hide_loading_overlay();
            console.log('检测 Office 失败:', e);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.officeDetectFailed') || '检测失败',
                window.i18n?.format_translate('errors.officeDetectFailedDesc') || '检测 Office 软件失败，请重试'
            );
            if (wasCameraOpen) await main_update_camera_state(true);
            return;
        }
        
        main_update_loading_progress(window.i18n?.format_translate('loading.readingFile') || '正在读取文件...');
        
        let fileData;
        try {
            fileData = await fs.readFile(filePath);
        } catch (readError) {
            main_hide_loading_overlay();
            console.error('文件读取失败:', readError);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.readFailed') || '读取失败',
                window.i18n?.format_translate('errors.readFailedDesc') || '无法读取文件'
            );
            if (wasCameraOpen) await main_update_camera_state(true);
            return;
        }
        
        let uint8Array;
        if (Array.isArray(fileData)) {
            uint8Array = new Uint8Array(fileData);
        } else {
            uint8Array = new Uint8Array(fileData);
        }
        
        console.log('文件大小:', uint8Array.length, '字节');
        const fileMd5 = main_calculate_md5(uint8Array);
        fileData = null;
        uint8Array = null;
        
        main_update_loading_progress(window.i18n?.format_translate('loading.processingWord') || '正在处理 Word 文档...');
        
        let pdfPath = null;
        try {
            pdfPath = await invoke('office_convert_docx_to_pdf', {
                docxPath: filePath
            });
            console.log('Word 文档已转换为 PDF:', pdfPath);
        } catch (convertError) {
            main_hide_loading_overlay();
            console.error('Word 转换失败:', convertError);
            const errorMsg = String(convertError);
            let friendlyMsg = window.i18n?.format_translate('errors.wordConvertFailed') || 'Word 文档转换失败';
            
            if (errorMsg.includes('Office') || errorMsg.includes('Word') || errorMsg.includes('WPS')) {
                friendlyMsg = window.i18n?.format_translate('errors.officeCallFailed') || 'Office 软件调用失败\n\n可能的原因：\n• Office 软件未正确安装\n• 文件被其他程序占用\n• 文件格式不支持';
            }
            
            main_show_error_dialog(
                window.i18n?.format_translate('errors.convertFailed') || '转换失败',
                friendlyMsg,
                () => {
                    main_load_pdf_from_path(filePath);
                }
            );
            if (wasCameraOpen) await main_update_camera_state(true);
            return;
        }
        
        main_update_loading_progress(window.i18n?.format_translate('loading.renderingPage') || '正在渲染页面...');
        
        try {
            const pdfReady = await main_wait_pdfjs();
            if (!pdfReady) {
                main_hide_loading_overlay();
                console.error('PDF.js 库加载超时');
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.loadFailed') || '加载失败',
                    window.i18n?.format_translate('errors.pdfLoadTimeout') || 'PDF 库加载超时\n\n请重启应用后重试'
                );
                if (wasCameraOpen) await main_update_camera_state(true);
                return;
            }
            
            let pdfBytes = await fs.readFile(pdfPath);
            let pdfArrayBuffer = pdfBytes.buffer;
            const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
            pdfBytes = null;
            pdfArrayBuffer = null;
            console.log('PDF加载成功，页数:', pdf.numPages);
            
            const totalPages = pdf.numPages;
            const fileName = filePath.split(/[/\\]/).pop().replace(/\.(pdf|docx|doc)$/i, '');
            const docNumber = sourceIdCounters.doc++;
            
            const folder = {
                name: fileName,
                pages: [],
                isPdf: true,
                pdfDoc: pdf,
                totalPages: totalPages,
                docNumber: docNumber,
                fileMd5: fileMd5
            };
            
            if (state.pdfDocuments.size >= MAX_PDF_CACHE) {
                const firstKey = state.pdfDocuments.keys().next().value;
                main_delete_pdf_blob_urls(firstKey);
                state.pdfDocuments.delete(firstKey);
                console.log(`[PDF缓存] 缓存已满,移除文档: ${firstKey}`);
            }
            
            state.pdfDocuments.set(docNumber, pdf);
            
            const processedPages = await main_render_pdf_pages_lazy(pdf, totalPages, PDF_INITIAL_RENDER_PAGES, docNumber);
            folder.pages = processedPages;
            
            state.fileList.push(folder);
            main_update_file_sidebar_content();
            main_show_file_sidebar();
            
            main_hide_loading_overlay();
            console.log(`文件已导入: ${folder.name}，共${folder.pages.length}页`);
            
            if (wasCameraOpen) await main_update_camera_state(true);
            
            try {
                await fs.remove(pdfPath);
            } catch (e) {
                console.log('清理转换的 PDF 失败:', e);
            }
        } catch (error) {
            main_hide_loading_overlay();
            console.error('文件导入失败:', error);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.importFailed') || '导入失败',
                window.i18n?.format_translate('errors.importFailedDesc') || '文件导入失败，请确保文件格式正确'
            );
            if (wasCameraOpen) await main_update_camera_state(true);
        }
        
        return;
    }
    
    main_show_loading_overlay(window.i18n?.format_translate('loading.importingFile') || '正在导入文件...');
    
    try {
        const pdfReady = await main_wait_pdfjs();
        if (!pdfReady) {
            main_hide_loading_overlay();
            console.error('PDF.js 库加载超时');
            main_show_error_dialog(
                window.i18n?.format_translate('errors.loadFailed') || '加载失败',
                window.i18n?.format_translate('errors.pdfLoadTimeout') || 'PDF 库加载超时\n\n请重启应用后重试'
            );
            if (wasCameraOpen) await main_update_camera_state(true);
            return;
        }
        
        const { fs } = window.__TAURI__;
        
        let fileData;
        try {
            fileData = await fs.readFile(filePath);
            console.log('文件读取成功，数据类型:', typeof fileData, '是否数组:', Array.isArray(fileData));
        } catch (readError) {
            console.error('文件读取失败:', readError);
            main_hide_loading_overlay();
            main_show_error_dialog(
                window.i18n?.format_translate('errors.readFailed') || '读取失败',
                window.i18n?.format_translate('errors.readFailedDesc') || '无法读取文件'
            );
            if (wasCameraOpen) await main_update_camera_state(true);
            return;
        }
        
        let uint8Array;
        if (Array.isArray(fileData)) {
            uint8Array = new Uint8Array(fileData);
        } else if (fileData instanceof ArrayBuffer) {
            uint8Array = new Uint8Array(fileData);
        } else {
            uint8Array = new Uint8Array(fileData);
        }
        
        console.log('PDF数据大小:', uint8Array.length);
        const fileMd5 = main_calculate_md5(uint8Array);
        
        const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
        fileData = null;
        uint8Array = null;
        console.log('PDF加载成功，页数:', pdf.numPages);
        
        const totalPages = pdf.numPages;
        const fileName = filePath.split(/[/\\]/).pop().replace(/\.(pdf|docx|doc)$/i, '');
        const docNumber = sourceIdCounters.doc++;
        
        const folder = {
            name: fileName,
            pages: [],
            isWord: false,
            pdfDoc: pdf,
            totalPages: totalPages,
            docNumber: docNumber,
            fileMd5: fileMd5
        };
        
        const processedPages = await main_render_pdf_pages_lazy(pdf, totalPages, PDF_INITIAL_RENDER_PAGES, docNumber);
        folder.pages = processedPages;
        
        state.fileList.push(folder);
        main_update_file_sidebar_content();
        main_show_file_sidebar();
        
        main_hide_loading_overlay();
        console.log(`文件已导入: ${folder.name}，共${folder.pages.length}页`);
        
        if (wasCameraOpen) await main_update_camera_state(true);
    } catch (error) {
        main_hide_loading_overlay();
        console.error('文件导入失败:', error);
        main_show_error_dialog(
            window.i18n?.format_translate('errors.importFailed') || '导入失败',
            window.i18n?.format_translate('errors.importFailedDesc') || '文件导入失败，请确保文件格式正确'
        );
        if (wasCameraOpen) await main_update_camera_state(true);
    }
}

// 处理窗口大小变化（防抖 150ms）
let resizeTimeout = null;

function main_handle_resize() {
    main_delete_cached_rect();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        const container = dom.canvasContainer;
        const newScreenW = container.clientWidth;
        const newScreenH = container.clientHeight;
        
        if (newScreenW !== DRAW_CONFIG.screenW || newScreenH !== DRAW_CONFIG.screenH) {
            main_update_canvas_size(newScreenW, newScreenH);
        }
    }, 150);
}

// 调整画布大小
async function main_update_canvas_size(newScreenW, newScreenH) {
    const oldScale = state.scale;
    const oldCanvasX = state.canvasX;
    const oldCanvasY = state.canvasY;
    
    if (window.tileRenderer) {
        window.tileRenderer.destroy_all();
    }
    
    DRAW_CONFIG.screenW = newScreenW;
    DRAW_CONFIG.screenH = newScreenH;
    
    DRAW_CONFIG.canvasW = Math.floor(newScreenW * 2);
    DRAW_CONFIG.canvasH = Math.floor(newScreenH * 2);
    
    DRAW_CONFIG.dpr = window.main_calc_capped_dpr(DRAW_CONFIG.baseDpr, DRAW_CONFIG.dprLimit);
    
    main_update_move_bound();
    
    dom.imageElement.style.width = DRAW_CONFIG.canvasW + 'px';
    dom.imageElement.style.height = DRAW_CONFIG.canvasH + 'px';
    dom.canvasWrapper.style.width = DRAW_CONFIG.canvasW + 'px';
    dom.canvasWrapper.style.height = DRAW_CONFIG.canvasH + 'px';
    
    window.tileRenderer.init_tiles(dom.canvasWrapper);
    
    if (window.batchDrawManager) {
        window.batchDrawManager.resize_overlay(newScreenW, newScreenH, DRAW_CONFIG.dpr);
    }
    
    if (state.currentImage) {
        main_render_image_centered(state.currentImage);
    }
    
    if (state.strokeHistory.length > 0 || state.baseImageObj) {
        await main_render_all_strokes();
    }
    
    state.scale = oldScale;
    state.canvasX = oldCanvasX;
    state.canvasY = oldCanvasY;
    
    main_update_move_bound();
    main_update_canvas_position();
    main_update_canvas_transform();
    
    console.log(`窗口调整: 屏幕 ${newScreenW}x${newScreenH}, 画布 ${DRAW_CONFIG.canvasW}x${DRAW_CONFIG.canvasH}, DPR ${DRAW_CONFIG.dpr.toFixed(2)}`);
}

// 更新画布背景颜色
function main_update_canvas_bg_color(color) {
    if (dom.canvasContainer) {
        dom.canvasContainer.style.backgroundColor = color;
    }
    if (dom.canvasWrapper) {
        dom.canvasWrapper.style.backgroundColor = color;
    }
}

let cachedMoveBoundScale = null;

function main_update_move_bound() {
    if (cachedMoveBoundScale === state.scale) {
        return;
    }
    cachedMoveBoundScale = state.scale;
    
    const screenW = DRAW_CONFIG.screenW;
    const screenH = DRAW_CONFIG.screenH;
    const scaledW = DRAW_CONFIG.canvasW * state.scale;
    const scaledH = DRAW_CONFIG.canvasH * state.scale;
    
    if (scaledW >= screenW) {
        state.moveBound.minX = -(scaledW - screenW);
        state.moveBound.maxX = 0;
    } else {
        state.moveBound.minX = (screenW - scaledW) / 2;
        state.moveBound.maxX = (screenW - scaledW) / 2;
    }
    
    if (scaledH >= screenH) {
        state.moveBound.minY = -(scaledH - screenH);
        state.moveBound.maxY = 0;
    } else {
        state.moveBound.minY = (screenH - scaledH) / 2;
        state.moveBound.maxY = (screenH - scaledH) / 2;
    }
}

function main_update_canvas_position() {
    const eps = 0.001;
    state.canvasX = Math.max(state.moveBound.minX - eps, Math.min(state.moveBound.maxX + eps, state.canvasX));
    state.canvasY = Math.max(state.moveBound.minY - eps, Math.min(state.moveBound.maxY + eps, state.canvasY));
}

function main_fetch_visible_rect() {
    if (cachedVisibleRectScale === state.scale && 
        cachedVisibleRectX === state.canvasX && 
        cachedVisibleRectY === state.canvasY && 
        cachedVisibleRect) {
        return cachedVisibleRect;
    }
    
    cachedVisibleRectScale = state.scale;
    cachedVisibleRectX = state.canvasX;
    cachedVisibleRectY = state.canvasY;
    
    const scale = state.scale || 1;
    const screenW = DRAW_CONFIG.screenW;
    const screenH = DRAW_CONFIG.screenH;
    
    let visibleX = Math.max(0, -state.canvasX / scale);
    let visibleY = Math.max(0, -state.canvasY / scale);
    let visibleW = Math.min(DRAW_CONFIG.canvasW - visibleX, screenW / scale);
    let visibleH = Math.min(DRAW_CONFIG.canvasH - visibleY, screenH / scale);
    
    const padding = 10;
    visibleX = Math.max(0, visibleX - padding);
    visibleY = Math.max(0, visibleY - padding);
    visibleW = Math.min(DRAW_CONFIG.canvasW - visibleX, visibleW + padding * 2);
    visibleH = Math.min(DRAW_CONFIG.canvasH - visibleY, visibleH + padding * 2);
    
    cachedVisibleRect = {
        x: visibleX,
        y: visibleY,
        width: visibleW,
        height: visibleH
    };
    
    return cachedVisibleRect;
}

function main_validate_stroke_visible(stroke, visibleRect) {
    if (!stroke.bounds) return true;
    
    return !(stroke.bounds.maxX < visibleRect.x ||
             stroke.bounds.minX > visibleRect.x + visibleRect.width ||
             stroke.bounds.maxY < visibleRect.y ||
             stroke.bounds.minY > visibleRect.y + visibleRect.height);
}

// 绑定所有事件
function main_setup_all_events() {
    main_setup_mode_events();
    main_setup_tool_events();
    main_setup_pen_control_events();
    main_setup_canvas_mouse_events();
    main_setup_canvas_touch_events();
    main_setup_settings_events();
    main_setup_click_outside();
    if (window.blackboardManager) {
        window.blackboardManager.setup_toolbar_events();
    }
}

// 设置面板事件
function main_setup_settings_events() {
    document.getElementById('btnRotateLeft')?.addEventListener('click', () => {
        main_update_image_rotation('left');
    });
    
    document.getElementById('btnRotateRight')?.addEventListener('click', () => {
        main_update_image_rotation('right');
    });

    // 亮度 / 对比度 / 黑白 控件
    const brightnessEl = document.getElementById('cameraBrightness');
    const brightnessVal = document.getElementById('cameraBrightnessValue');
    const contrastEl = document.getElementById('cameraContrast');
    const contrastVal = document.getElementById('cameraContrastValue');
    const grayscaleGroup = document.getElementById('cameraGrayscaleGroup');

    // brightness / contrast / grayscale input: only apply to current session (do not persist)
    brightnessEl?.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        state.camera_brightness = v;
        if (brightnessVal) brightnessVal.textContent = String(v);
        main_apply_camera_filters();
    });

    contrastEl?.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10) / 100.0;
        state.camera_contrast = v;
        if (contrastVal) contrastVal.textContent = v.toFixed(2);
        main_apply_camera_filters();
    });

    grayscaleGroup?.addEventListener('click', (e) => {
        const btn = e.target.closest('.option-btn');
        if (!btn) return;
        const value = btn.dataset.value;
        grayscaleGroup.querySelectorAll('.option-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        grayscaleGroup.dataset.active = value;
        state.camera_grayscale = value === 'on' ? 1 : 0;
        main_apply_camera_filters();
    });

    // reset sliders
    document.getElementById('btnResetSliders')?.addEventListener('click', () => {
        const brightnessInput = document.getElementById('cameraBrightness');
        const brightnessVal = document.getElementById('cameraBrightnessValue');
        const contrastInput = document.getElementById('cameraContrast');
        const contrastVal = document.getElementById('cameraContrastValue');
        const grayscaleGroup = document.getElementById('cameraGrayscaleGroup');

        if (brightnessInput) {
            brightnessInput.value = '10';
            state.camera_brightness = 10;
            if (brightnessVal) brightnessVal.textContent = '10';
        }
        if (contrastInput) {
            contrastInput.value = '140';
            state.camera_contrast = 1.4;
            if (contrastVal) contrastVal.textContent = '1.40';
        }
        if (grayscaleGroup) {
            grayscaleGroup.querySelectorAll('.option-btn').forEach(b => b.classList.remove('active'));
            const offBtn = grayscaleGroup.querySelector('.option-btn[data-value="off"]');
            if (offBtn) {
                offBtn.classList.add('active');
                grayscaleGroup.dataset.active = 'off';
            }
            state.camera_grayscale = 0;
        }
        main_apply_camera_filters();
    });
}

// 点击外部关闭面板
function main_setup_click_outside() {
    document.addEventListener('click', (e) => {
        const panel = dom.penControlPanel;
        const isClickInsidePanel = panel.contains(e.target);
        const isClickOnBtnComment = dom.btnComment.contains(e.target);
        const isClickOnBtnEraser = dom.btnEraser.contains(e.target);
        
        if (!isClickInsidePanel && !isClickOnBtnComment && !isClickOnBtnEraser) {
            main_hide_pen_control_panel();
        }
        
        const settingsPanel = dom.settingsPanel;
        const isClickInsideSettings = settingsPanel.contains(e.target);
        const isClickOnBtnSettings = dom.btnSettings.contains(e.target);
        
        if (!isClickInsideSettings && !isClickOnBtnSettings) {
            main_hide_settings_panel();
        }
    });
}

// 模式切换事件
function main_setup_mode_events() {
    dom.btnMove.addEventListener('click', () => {
        main_update_mode('move');
    });
    dom.btnComment.addEventListener('click', () => {
        main_update_mode('comment');
    });
    dom.btnEraser.addEventListener('click', () => {
        main_update_mode('eraser');
    });
    
    dom.btnComment.addEventListener('dblclick', (e) => {
        e.preventDefault();
        main_show_pen_control_panel(dom.btnComment, 'comment');
    });
    
    dom.btnEraser.addEventListener('dblclick', (e) => {
        e.preventDefault();
        main_show_pen_control_panel(dom.btnEraser, 'eraser');
    });
}

// 切换模式
async function main_update_mode(mode) {
    const bb = window.blackboardManager;
    if (bb?.is_open) {
        if (bb.is_drawing) {
            bb.is_drawing = false;
            await bb._submit_stroke();
        }
        bb.draw_mode = mode;

        [dom.btnMove, dom.btnComment, dom.btnEraser].forEach(btn => {
            btn.classList.remove('primary-btn');
        });

        switch (mode) {
            case 'move':
                if (dom.btnMove) dom.btnMove.classList.add('primary-btn');
                if (bb.bb_wrapper) bb.bb_wrapper.style.cursor = 'grab';
                bb._hide_eraser_hint();
                break;
            case 'comment':
                if (dom.btnComment) dom.btnComment.classList.add('primary-btn');
                if (bb.bb_wrapper) bb.bb_wrapper.style.cursor = 'crosshair';
                bb._hide_eraser_hint();
                main_update_pen_style();
                break;
            case 'eraser':
                if (dom.btnEraser) dom.btnEraser.classList.add('primary-btn');
                if (bb.bb_wrapper) bb.bb_wrapper.style.cursor = 'none';
                bb._show_eraser_hint();
                main_update_eraser_style();
                break;
        }

        console.log(`[黑板] 切换到 ${mode} 模式`);
        return;
    }

    // 切换模式前提交当前未完成的笔画并重置绘制状态
    if (state.isDrawing) {
        state.isDrawing = false;
        main_hide_drawing_mode();
        await main_submit_stroke();
        batchDrawManager.batch_draw_delete_all();
    }
    state.isDragging = false;
    state.isScaling = false;
    
    main_hide_pen_control_panel();
    
    [dom.btnMove, dom.btnComment, dom.btnEraser].forEach(btn => {
        btn.classList.remove('primary-btn');
    });
    
    dom.canvasWrapper.classList.remove('drawing', 'eraser', 'dragging');
    
    state.drawMode = mode;
    
    switch (mode) {
        case 'move':
            dom.btnMove.classList.add('primary-btn');
            dom.canvasWrapper.style.cursor = 'grab';
            main_hide_eraser_hint();
            break;
        case 'comment':
            dom.btnComment.classList.add('primary-btn');
            dom.canvasWrapper.classList.add('drawing');
            dom.canvasWrapper.style.cursor = 'crosshair';
            main_hide_eraser_hint();
            main_update_pen_style();
            break;
        case 'eraser':
            dom.btnEraser.classList.add('primary-btn');
            dom.canvasWrapper.classList.add('eraser');
            dom.canvasWrapper.style.cursor = 'none';
            main_show_eraser_hint();
            main_update_eraser_style();
            break;
    }
    
    console.log(`切换到 ${mode} 模式`);
}

// 工具按钮事件
function main_setup_tool_events() {
    dom.btnUndo.addEventListener('click', () => {
        if (window.blackboardManager?.is_open) {
            window.blackboardManager.handle_undo();
        } else {
            main_handle_undo();
        }
    });
    dom.btnClear.addEventListener('click', () => {
        if (window.blackboardManager?.is_open) {
            window.blackboardManager.handle_clear();
        } else {
            main_delete_all_drawings();
        }
    });
    dom.btnPhoto.addEventListener('click', main_save_photo);
    dom.btnSettings.addEventListener('click', main_show_settings);
    dom.btnSave.addEventListener('click', main_handle_file_sidebar_toggle);
    dom.btnMinimize.addEventListener('click', main_hide_window);
    dom.btnMenu.addEventListener('click', main_handle_menu_toggle);
    dom.btnExpand.addEventListener('click', main_handle_sidebar_toggle);
    dom.btnBlackboard.addEventListener('click', () => {
        const bb = window.blackboardManager;
        if (bb) {
            if (bb.is_open) {
                bb.close();
            } else {
                bb.open();
            }
        }
    });
}

// 菜单弹出
function main_handle_menu_toggle() {
    const existingMenu = document.getElementById('menuPopup');
    if (existingMenu) {
        main_hide_menu();
    } else {
        main_show_menu();
    }
}

function main_show_menu() {
    const menuPopup = document.createElement('div');
    menuPopup.id = 'menuPopup';
    menuPopup.className = 'menu-popup';
    menuPopup.innerHTML = `
        <button class="menu-item" id="menuSettings">
            ${ThemeManager.theme_fetch_icon('settings', { alt: window.i18n?.format_translate('toolbar.settings') || '设置' })}
            ${window.i18n?.format_translate('toolbar.settings') || '设置'}
        </button>
        <button class="menu-item" id="menuClose">
            ${ThemeManager.theme_fetch_icon('close', { alt: window.i18n?.format_translate('common.close') || '关闭' })}
            ${window.i18n?.format_translate('common.close') || '关闭'}
        </button>
    `;
    
    dom.canvasContainer.appendChild(menuPopup);
    
    document.getElementById('menuSettings').addEventListener('click', () => {
        main_hide_menu();
        main_show_settings_window();
    });
    
    document.getElementById('menuClose').addEventListener('click', () => {
        main_hide_menu();
        main_submit_close_window();
    });
    
    setTimeout(() => {
        document.addEventListener('click', main_handle_menu_outside_click);
    }, 0);
}

function main_hide_menu() {
    const menuPopup = document.getElementById('menuPopup');
    if (menuPopup) {
        menuPopup.remove();
    }
    document.removeEventListener('click', main_handle_menu_outside_click);
}

function main_handle_menu_outside_click(e) {
    const menuPopup = document.getElementById('menuPopup');
    const btnMenu = dom.btnMenu;
    
    if (menuPopup && !menuPopup.contains(e.target) && !btnMenu.contains(e.target)) {
        main_hide_menu();
    }
}

// 最小化窗口
async function main_hide_window() {
    if (window.__TAURI__?.window?.getCurrentWindow) {
        const appWindow = window.__TAURI__.window.getCurrentWindow();
        
        // 如果摄像头开启，先关闭摄像头
        if (state.isCameraOpen) {
            await main_update_camera_state(false);
            state.wasCameraOpenBeforeMinimize = true;
            console.log('摄像头已关闭（最小化）');
        }
        
        await appWindow.minimize();
        console.log('窗口已最小化');
    } else {
        console.log('Tauri API 不可用');
    }
}

// 监听窗口最小化和恢复事件
function main_setup_minimize_listeners() {
    if (window.__TAURI__) {
        const { getCurrentWindow } = window.__TAURI__.window;
        
        let isRestoring = false;
        
        const main_handle_restore = async () => {
            if (isRestoring) return;
            isRestoring = true;
            try {
                await main_init_camera_if_needed();
            } finally {
                setTimeout(() => {
                    isRestoring = false;
                }, 300);
            }
        };
        
        getCurrentWindow().listen('tauri://restore', main_handle_restore);
        getCurrentWindow().listen('tauri://show', main_handle_restore);
        getCurrentWindow().listen('tauri://focus', main_handle_restore);
    }
}

// 恢复摄像头（如果需要）
async function main_init_camera_if_needed() {
    // 如果之前摄像头是开启的，重新开启摄像头
    if (state.wasCameraOpenBeforeMinimize && !state.isCameraOpen) {
        try {
            await main_update_camera_state(true);
            console.log('摄像头已重新开启');
            // 只有在成功开启后才重置状态
            state.wasCameraOpenBeforeMinimize = false;
        } catch (error) {
            console.error('重新开启摄像头失败:', error);
            // 开启失败时保持状态，以便下次尝试
        }
    }
}

// 关闭窗口
async function main_submit_close_window() {
    if (window.__TAURI__?.window?.getCurrentWindow) {
        await window.documentReaderManager?.delete_annotation_cache_files?.();
        const appWindow = window.__TAURI__.window.getCurrentWindow();
        await appWindow.close();
        console.log('窗口已关闭');
    } else {
        console.log('Tauri API 不可用');
    }
}

// 动态构建画笔预设按钮
function main_build_pen_presets(presets) {
    const container = dom.penSizePresets;
    container.querySelectorAll('.size-preset-btn').forEach(b => b.remove());
    const valueSpan = container.querySelector('.pen-size-label');
    presets.forEach(value => {
        const btn = document.createElement('button');
        btn.className = 'size-preset-btn';
        btn.dataset.value = value;
        btn.style.setProperty('--dot-size', Math.round(value + 4) + 'px');
        btn.addEventListener('click', () => {
            DRAW_CONFIG.penWidth = value;
            container.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            dom.penSizeValue.textContent = `${value}px`;
            if (state.drawMode === 'comment') {
                main_update_pen_style();
            }
        });
        container.insertBefore(btn, valueSpan);
    });
    const active = container.querySelector(`[data-value="${DRAW_CONFIG.penWidth}"]`);
    if (active) active.classList.add('active');
    main_update_pen_preset_dot_color();
    dom.penSizeValue.textContent = `${DRAW_CONFIG.penWidth}px`;
}

// 笔触控制事件
function main_setup_pen_control_events() {
    main_build_pen_presets(DRAW_CONFIG.penSizePresets);
    
    // 橡皮预设尺寸点击
    dom.eraserSizePresets.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const value = parseInt(btn.dataset.value);
            DRAW_CONFIG.eraserSize = value;
            dom.eraserSizePresets.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            dom.eraserSizeValue.textContent = `${value}px`;
            main_update_eraser_hint_size();
            if (state.drawMode === 'eraser') {
                main_update_eraser_style();
            }
        });
    });
    
    // 初始化橡皮选中状态
    const eraserActive = dom.eraserSizePresets.querySelector(`[data-value="${DRAW_CONFIG.eraserSize}"]`);
    if (eraserActive) eraserActive.classList.add('active');
    
    // 颜色按钮点击事件
    const colorButtons = document.querySelectorAll('.pen-color-btn');
    colorButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index);
            const color = DRAW_CONFIG.penColors[index];
            if (color) {
                DRAW_CONFIG.penColor = color;
                main_update_pen_preset_dot_color();
                
                // 更新选中状态
                colorButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                if (state.drawMode === 'comment') {
                    main_update_pen_style();
                }
            }
        });
    });
    
    // 初始化颜色按钮
    main_update_color_buttons();
}

// RGB转十六进制颜色
function main_calc_rgb_to_hex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

// 十六进制颜色转RGB
function main_calc_hex_to_rgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function main_update_color_buttons() {
    const colorButtons = document.querySelectorAll('.pen-color-btn');
    colorButtons.forEach((btn, index) => {
        if (DRAW_CONFIG.penColors[index]) {
            btn.dataset.color = DRAW_CONFIG.penColors[index];
            btn.style.backgroundColor = DRAW_CONFIG.penColors[index];
            btn.title = window.i18n?.format_translate('settings.colorN', { n: index + 1 }) || `颜色${index + 1}`;
            
            if (DRAW_CONFIG.penColors[index].toLowerCase() === '#000000') {
                btn.classList.add('dark-color');
            } else {
                btn.classList.remove('dark-color');
            }
            
            if (DRAW_CONFIG.penColors[index].toLowerCase() === '#ffffff') {
                btn.classList.add('light-color');
            } else {
                btn.classList.remove('light-color');
            }
        }
    });
    main_update_color_button_active();
}

function main_update_color_button_active() {
    const colorButtons = document.querySelectorAll('.pen-color-btn');
    colorButtons.forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.color === DRAW_CONFIG.penColor) {
            btn.classList.add('active');
        }
    });
    main_update_pen_preset_dot_color();
}

function main_update_pen_preset_dot_color() {
    dom.penSizePresets.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.style.setProperty('--dot-color', DRAW_CONFIG.penColor);
    });
}

// 设置笔触样式
function main_update_pen_style() {
    main_reset_context_state();
}

function main_update_eraser_style() {
    main_reset_context_state();
}

function main_start_drawing_mode() {
    dom.canvasWrapper.classList.add('drawing');
}

function main_hide_drawing_mode() {
    dom.canvasWrapper.classList.remove('drawing');
}

// 橡皮提示框 — 固定屏幕像素尺寸，不随缩放变化
function main_update_eraser_hint_size() {
    dom.eraserHint.style.width = `${DRAW_CONFIG.eraserSize}px`;
    dom.eraserHint.style.height = `${DRAW_CONFIG.eraserSize}px`;
}

function main_show_eraser_hint() {
    dom.eraserHint.classList.add('active');
}

function main_hide_eraser_hint() {
    dom.eraserHint.classList.remove('active');
    if (eraserHintRafId !== null) {
        cancelAnimationFrame(eraserHintRafId);
        eraserHintRafId = null;
    }
    eraserHintPendingPos = null;
}

function main_show_pen_control_panel(targetBtn, mode) {
    const panel = dom.penControlPanel;
    const btnRect = targetBtn.getBoundingClientRect();
    const containerRect = document.querySelector('.main-function').getBoundingClientRect();
    
    const penSizeControl = panel.querySelector('.pen-size-presets:nth-child(1)');
    const colorButtons = panel.querySelector('.pen-color-buttons');
    const eraserSizeControl = panel.querySelector('.pen-size-presets:nth-child(3)');
    
    if (mode === 'comment') {
        if (penSizeControl) penSizeControl.style.display = 'flex';
        if (colorButtons) colorButtons.style.display = 'grid';
        if (eraserSizeControl) eraserSizeControl.style.display = 'none';
    } else if (mode === 'eraser') {
        if (penSizeControl) penSizeControl.style.display = 'none';
        if (colorButtons) colorButtons.style.display = 'none';
        if (eraserSizeControl) eraserSizeControl.style.display = 'flex';
    }
    
    // 重置面板布局 → 强制重排获取准确尺寸 → 计算并约束位置
    panel.style.position = 'absolute';
    panel.style.bottom = 'auto';
    panel.style.top = 'auto';
    panel.style.right = 'auto';
    panel.style.left = 'auto';
    panel.style.visibility = 'hidden';
    panel.style.opacity = '0';
    panel.classList.remove('visible');
    
    panel.offsetHeight;
    
    const panelWidth = panel.offsetWidth || (mode === 'comment' ? 380 : 240);
    const panelHeight = panel.offsetHeight || 120;
    
    let left = btnRect.left - containerRect.left + (btnRect.width / 2) - (panelWidth / 2);
    let top = btnRect.top - containerRect.top - panelHeight - 15;
    
    const containerPadding = 10;
    left = Math.max(containerPadding, Math.min(left, containerRect.width - panelWidth - containerPadding));
    
    // 面板顶部超出容器时改显示在按钮下方
    if (top < containerPadding) {
        top = btnRect.bottom - containerRect.top + 15;
    }
    
    // 设置最终位置并显示面板
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.visibility = 'visible';
    panel.style.opacity = '1';
    panel.classList.add('visible');
}

function main_hide_pen_control_panel() {
    const panel = dom.penControlPanel;
    if (!panel.classList.contains('visible')) return;
    panel.classList.remove('visible');
    panel.style.opacity = '0';
    panel.style.visibility = 'hidden';
}

let eraserHintRafId = null;
let eraserHintPendingPos = null;

function main_update_eraser_hint_position(clientX, clientY) {
    eraserHintPendingPos = { clientX, clientY };
    
    if (eraserHintRafId !== null) return;
    
    eraserHintRafId = requestAnimationFrame(() => {
        eraserHintRafId = null;
        if (!eraserHintPendingPos) return;
        
        const { clientX, clientY } = eraserHintPendingPos;
        eraserHintPendingPos = null;
        
        const rect = main_fetch_cached_canvas_rect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        dom.eraserHint.style.left = `${x}px`;
        dom.eraserHint.style.top = `${y}px`;
        dom.eraserHint.style.transform = 'translate(-50%, -50%)';
    });
}

// === 画布交互事件：鼠标/触控 绘制、拖拽、缩放 ===

function main_setup_canvas_mouse_events() {
    if (window.PointerEvent) {
        dom.canvasWrapper.addEventListener('pointerdown', main_handle_pointer_down);
        dom.canvasWrapper.addEventListener('pointermove', main_handle_pointer_move);
        dom.canvasWrapper.addEventListener('pointerup', main_handle_pointer_up);
        dom.canvasWrapper.addEventListener('pointerleave', main_handle_pointer_leave);
        dom.canvasWrapper.addEventListener('pointercancel', main_handle_pointer_up);
    } else {
        dom.canvasWrapper.addEventListener('mousedown', main_handle_mouse_down);
        dom.canvasWrapper.addEventListener('mousemove', main_handle_mouse_move);
        dom.canvasWrapper.addEventListener('mouseup', main_handle_mouse_up);
        dom.canvasWrapper.addEventListener('mouseleave', main_handle_mouse_leave);
    }
    dom.canvasWrapper.addEventListener('wheel', main_handle_wheel, { passive: true });
}

/**
 * Pointer 按下处理
 */
function main_handle_pointer_down(e) {
    if (window.tileRenderer) window.tileRenderer.cancel_idle_shrink();
    e.preventDefault();
    state.drawCanvasRect = dom.canvasWrapper.getBoundingClientRect();
    
    state.currentPressure = e.pressure || 0.5;
    
    if (state.drawMode === 'move') {
        state.isDragging = true;
        state.startDragX = e.clientX - state.canvasX;
        state.startDragY = e.clientY - state.canvasY;
        dom.canvasWrapper.classList.add('dragging');
    } else if (state.drawMode === 'comment') {
        main_hide_pen_control_panel();
        state.isDrawing = true;
        main_start_drawing_mode();
        state.cachedInvScale = 1 / main_fetch_safe_scale();
        state.lastX = (e.clientX - state.drawCanvasRect.left) * state.cachedInvScale;
        state.lastY = (e.clientY - state.drawCanvasRect.top) * state.cachedInvScale;
        main_start_stroke('draw');
    } else if (state.drawMode === 'eraser') {
        main_hide_pen_control_panel();
        state.isDrawing = true;
        main_start_drawing_mode();
        state.cachedInvScale = 1 / main_fetch_safe_scale();
        state.lastX = (e.clientX - state.drawCanvasRect.left) * state.cachedInvScale;
        state.lastY = (e.clientY - state.drawCanvasRect.top) * state.cachedInvScale;
        main_start_stroke('erase');
    }
}

/**
 * Pointer 移动处理
 */
function main_handle_pointer_move(e) {
    e.preventDefault();
    
    state.currentPressure = e.pressure || 0.5;
    
    if (state.drawMode === 'eraser') {
        main_update_eraser_hint_position(e.clientX, e.clientY);
    }
    
    if (state.isDragging) {
        state.canvasX = e.clientX - state.startDragX;
        state.canvasY = e.clientY - state.startDragY;
        main_update_canvas_position();
        
        main_update_transform_schedule(state.canvasX, state.canvasY, state.scale);
    } else if (state.isDrawing) {
        const rect = state.drawCanvasRect;
        const invScale = state.cachedInvScale;
        const x = (e.clientX - rect.left) * invScale;
        const y = (e.clientY - rect.top) * invScale;
        
        const dx = x - state.lastX;
        const dy = y - state.lastY;
        const distSq = dx * dx + dy * dy;
        
        if (distSq > 1) {
            main_save_stroke_point(state.lastX, state.lastY, x, y, state.currentPressure);
            
            batchDrawManager.batch_draw_create_command(
                state.cachedDrawType, 
                state.lastX, 
                state.lastY, 
                x, 
                y, 
                state.cachedDrawColor, 
                state.cachedDrawLineWidth
            );
            
            state.lastX = x;
            state.lastY = y;
        }
    }
}

async function main_handle_pointer_up(e) {
    if (state.isDragging) {
        state.isDragging = false;
        dom.canvasWrapper.classList.remove('dragging');
    }
    if (state.isDrawing) {
        state.isDrawing = false;
        main_flush_last_segment(e.clientX, e.clientY);
        main_hide_drawing_mode();
        await main_submit_stroke();
    }
}

async function main_handle_pointer_leave(e) {
    if (state.isDragging) {
        state.isDragging = false;
        dom.canvasWrapper.classList.remove('dragging');
    }
    if (state.isDrawing) {
        state.isDrawing = false;
        main_flush_last_segment(e.clientX, e.clientY);
        main_hide_drawing_mode();
        await main_submit_stroke();
    }
}

function main_flush_last_segment(clientX, clientY) {
    if (!state.drawCanvasRect) return;
    const invScale = state.cachedInvScale;
    const x = (clientX - state.drawCanvasRect.left) * invScale;
    const y = (clientY - state.drawCanvasRect.top) * invScale;
    const dx = x - state.lastX;
    const dy = y - state.lastY;
    if (dx !== 0 || dy !== 0) {
        main_save_stroke_point(state.lastX, state.lastY, x, y, state.currentPressure);
        batchDrawManager.batch_draw_create_command(
            state.cachedDrawType,
            state.lastX,
            state.lastY,
            x,
            y,
            state.cachedDrawColor,
            state.cachedDrawLineWidth
        );
        state.lastX = x;
        state.lastY = y;
    }
}

// 鼠标事件降级处理
function main_handle_mouse_down(e) {
    e.preventDefault();
    state.drawCanvasRect = dom.canvasWrapper.getBoundingClientRect();
    
    if (state.drawMode === 'move') {
        state.isDragging = true;
        state.startDragX = e.clientX - state.canvasX;
        state.startDragY = e.clientY - state.canvasY;
        dom.canvasWrapper.classList.add('dragging');
    } else if (state.drawMode === 'comment') {
        main_hide_pen_control_panel();
        state.isDrawing = true;
        main_start_drawing_mode();
        state.cachedInvScale = 1 / main_fetch_safe_scale();
        state.lastX = (e.clientX - state.drawCanvasRect.left) * state.cachedInvScale;
        state.lastY = (e.clientY - state.drawCanvasRect.top) * state.cachedInvScale;
        main_start_stroke('draw');
    } else if (state.drawMode === 'eraser') {
        main_hide_pen_control_panel();
        state.isDrawing = true;
        main_start_drawing_mode();
        state.cachedInvScale = 1 / main_fetch_safe_scale();
        state.lastX = (e.clientX - state.drawCanvasRect.left) * state.cachedInvScale;
        state.lastY = (e.clientY - state.drawCanvasRect.top) * state.cachedInvScale;
        main_start_stroke('erase');
    }
}

function main_handle_mouse_move(e) {
    e.preventDefault();
    
    if (state.drawMode === 'eraser') {
        main_update_eraser_hint_position(e.clientX, e.clientY);
    }
    
    if (state.isDragging) {
        state.canvasX = e.clientX - state.startDragX;
        state.canvasY = e.clientY - state.startDragY;
        main_update_canvas_position();
        
        const transform = `translate3d(${state.canvasX}px, ${state.canvasY}px, 0) scale(${state.scale})`;
        dom.canvasWrapper.style.transform = transform;
        
        last_canvas_transform.x = state.canvasX;
        last_canvas_transform.y = state.canvasY;
        last_canvas_transform.scale = state.scale;
    } else if (state.isDrawing) {
        const rect = state.drawCanvasRect;
        const invScale = state.cachedInvScale;
        const x = (e.clientX - rect.left) * invScale;
        const y = (e.clientY - rect.top) * invScale;
        
        const dx = x - state.lastX;
        const dy = y - state.lastY;
        const distSq = dx * dx + dy * dy;
        
        if (distSq > 1) {
            main_save_stroke_point(state.lastX, state.lastY, x, y);
            
            batchDrawManager.batch_draw_create_command(
                state.cachedDrawType, 
                state.lastX, 
                state.lastY, 
                x, 
                y, 
                state.cachedDrawColor, 
                state.cachedDrawLineWidth
            );
            
            state.lastX = x;
            state.lastY = y;
        }
    }
}

async function main_handle_mouse_up(e) {
    if (state.isDragging) {
        state.isDragging = false;
        dom.canvasWrapper.classList.remove('dragging');
    }
    if (state.isDrawing) {
        state.isDrawing = false;
        main_hide_drawing_mode();
        await main_submit_stroke();
    }
}

async function main_handle_mouse_leave(e) {
    if (state.isDragging) {
        state.isDragging = false;
        dom.canvasWrapper.classList.remove('dragging');
    }
    if (state.isDrawing) {
        state.isDrawing = false;
        main_hide_drawing_mode();
        await main_submit_stroke();
    }
}

function main_handle_wheel(e) {
    if (window.tileRenderer) window.tileRenderer.cancel_idle_shrink();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const maxScale = state.isCameraOpen ? DRAW_CONFIG.maxScaleCamera : DRAW_CONFIG.maxScaleImage;
    const newScale = Math.max(DRAW_CONFIG.minScale, Math.min(maxScale, state.scale + delta));
    
    if (newScale !== state.scale) {
        const containerRect = main_fetch_cached_canvas_rect();
        const mouseX = e.clientX - containerRect.left;
        const mouseY = e.clientY - containerRect.top;
        
        const oldScale = state.scale;
        
        const scaleRatio = newScale / oldScale;
        const targetX = mouseX - (mouseX - state.canvasX) * scaleRatio;
        const targetY = mouseY - (mouseY - state.canvasY) * scaleRatio;
        
        state.scale = newScale;
        state.canvasX = targetX;
        state.canvasY = targetY;
        
        main_update_move_bound();
        main_update_canvas_position();
        main_update_canvas_transform_smooth(state.canvasX, state.canvasY, state.scale, 100);
        
        main_update_eraser_hint_size();
        if (window.tileRenderer) window.tileRenderer.mark_all();
    }
}

// 画布触控事件
function main_setup_canvas_touch_events() {
    dom.canvasWrapper.addEventListener('touchstart', main_handle_touch_start, { passive: false });
    dom.canvasWrapper.addEventListener('touchmove', main_handle_touch_move, { passive: false });
    dom.canvasWrapper.addEventListener('touchend', main_handle_touch_end, { passive: false });
    dom.canvasWrapper.addEventListener('touchcancel', main_handle_touch_end, { passive: false });
}

async function main_handle_touch_start(e) {
    e.preventDefault();
    const touches = e.touches;
    state.drawCanvasRect = dom.canvasWrapper.getBoundingClientRect();
    
    // 在支持 PointerEvent 的设备上，TouchEvent 只处理多指手势，单指完全由 PointerEvent 处理
    if (window.PointerEvent) {
        if (touches.length === 1) {
            return;
        }
        // 2+ 指继续执行下面的缩放逻辑
    } else {
        // 不支持 PointerEvent 的设备，通过 isDrawing 防重入
        if (touches.length === 1 && state.isDrawing) {
            return;
        }
    }
    
    if (touches.length === 1) {
        const touch = touches[0];
        if (state.drawMode === 'move') {
            state.isDragging = true;
            state.startDragX = touch.clientX - state.canvasX;
            state.startDragY = touch.clientY - state.canvasY;
        dom.canvasWrapper.classList.add('dragging');
    } else if (state.drawMode === 'comment') {
        main_hide_pen_control_panel();
        state.isDrawing = true;
        main_start_drawing_mode();
            state.cachedInvScale = 1 / main_fetch_safe_scale();
            state.lastX = (touch.clientX - state.drawCanvasRect.left) * state.cachedInvScale;
            state.lastY = (touch.clientY - state.drawCanvasRect.top) * state.cachedInvScale;
            main_start_stroke('draw');
        } else if (state.drawMode === 'eraser') {
            main_hide_pen_control_panel();
            state.isDrawing = true;
            main_start_drawing_mode();
            main_update_eraser_hint_position(touch.clientX, touch.clientY);
            state.cachedInvScale = 1 / main_fetch_safe_scale();
            state.lastX = (touch.clientX - state.drawCanvasRect.left) * state.cachedInvScale;
            state.lastY = (touch.clientY - state.drawCanvasRect.top) * state.cachedInvScale;
            main_start_stroke('erase');
        }
    } else if (touches.length === 2) {
        // 双指缩放前先提交当前未完成的笔画
        if (state.isDrawing) {
            state.isDrawing = false;
            main_hide_drawing_mode();
            await main_submit_stroke();
            batchDrawManager.batch_draw_delete_all();
            state.cachedInvScale = 1 / main_fetch_safe_scale();
        }
        state.isScaling = true;
        state.isDragging = false;
        state.startDistanceSq = main_calc_touch_distance_squared(touches[0], touches[1]);
        state.startScale = state.scale;
        state.startScaleX = (touches[0].clientX + touches[1].clientX) / 2;
        state.startScaleY = (touches[0].clientY + touches[1].clientY) / 2;
        state.startCanvasX = state.canvasX;
        state.startCanvasY = state.canvasY;
        dom.canvasWrapper.classList.add('dragging');
    }
}

function main_handle_touch_move(e) {
    e.preventDefault();
    if (window.tileRenderer) window.tileRenderer.cancel_idle_shrink();
    const touches = e.touches;
    
    // 在支持 PointerEvent 的设备上，TouchEvent 只处理多指手势
    if (window.PointerEvent && touches.length === 1) {
        return;
    }
    
    // 不支持 PointerEvent 设备的防重入检查
    if (touches.length === 1 && state.isDrawing) {
        return;
    }
    
    if (touches.length === 1 && state.isDragging) {
        const touch = touches[0];
        state.canvasX = touch.clientX - state.startDragX;
        state.canvasY = touch.clientY - state.startDragY;
        main_update_canvas_position();
        
        const transform = `translate3d(${state.canvasX}px, ${state.canvasY}px, 0) scale(${state.scale})`;
        dom.canvasWrapper.style.transform = transform;
        
        last_canvas_transform.x = state.canvasX;
        last_canvas_transform.y = state.canvasY;
        last_canvas_transform.scale = state.scale;
    } else if (touches.length === 1 && state.isDrawing) {
        const touch = touches[0];
        if (state.drawMode === 'eraser') {
            main_update_eraser_hint_position(touch.clientX, touch.clientY);
        }
        
        const invScale = state.cachedInvScale;
        const x = (touch.clientX - state.drawCanvasRect.left) * invScale;
        const y = (touch.clientY - state.drawCanvasRect.top) * invScale;
        
        const pressure = (touch.force > 0) ? touch.force : 0.5;
        
        const dx = x - state.lastX;
        const dy = y - state.lastY;
        const distSq = dx * dx + dy * dy;
        
        if (distSq > 1) {
            main_save_stroke_point(state.lastX, state.lastY, x, y, pressure);
            
            batchDrawManager.batch_draw_create_command(
                state.cachedDrawType, 
                state.lastX, 
                state.lastY, 
                x, 
                y, 
                state.cachedDrawColor, 
                state.cachedDrawLineWidth
            );
            
            state.lastX = x;
            state.lastY = y;
        }
    } else if (touches.length === 2 && state.isScaling) {
        const currentDistanceSq = main_calc_touch_distance_squared(touches[0], touches[1]);
        const scaleRatio = Math.sqrt(currentDistanceSq / state.startDistanceSq);
        let newScale = state.startScale * scaleRatio;
        const maxScale = state.isCameraOpen ? DRAW_CONFIG.maxScaleCamera : DRAW_CONFIG.maxScaleImage;
        newScale = newScale < DRAW_CONFIG.minScale ? DRAW_CONFIG.minScale : (newScale > maxScale ? maxScale : newScale);
        
        const centerX = (touches[0].clientX + touches[1].clientX) / 2;
        const centerY = (touches[0].clientY + touches[1].clientY) / 2;
        
        const finalRatio = newScale / state.startScale;
        state.canvasX = centerX - (state.startScaleX - state.startCanvasX) * finalRatio;
        state.canvasY = centerY - (state.startScaleY - state.startCanvasY) * finalRatio;
        state.scale = newScale;
        
        // 缩放/平移过程中实时进行边界钳制，防止画布越界
        main_update_move_bound();
        main_update_canvas_position();
        
        main_update_transform_schedule(state.canvasX, state.canvasY, state.scale);
        
        main_update_eraser_hint_size();
    }
}

async function main_handle_touch_end(e) {
    e.preventDefault();
    
    // 在支持 PointerEvent 的设备上，只处理多指缩放结束
    if (window.PointerEvent && !state.isScaling) {
        return;
    }
    
    if (e.touches.length === 0) {
        state.isDragging = false;
        dom.canvasWrapper.classList.remove('dragging');
        
        main_update_move_bound();
        main_update_canvas_position();
        dom.canvasWrapper.style.transform = `translate3d(${state.canvasX}px, ${state.canvasY}px, 0) scale(${state.scale})`;
        last_canvas_transform.x = state.canvasX;
        last_canvas_transform.y = state.canvasY;
        last_canvas_transform.scale = state.scale;
        
        if (state.isDrawing) {
            state.isDrawing = false;
            main_hide_drawing_mode();
            await main_submit_stroke();
        } else if (state.isScaling) {
            if (window.tileRenderer) {
                window.tileRenderer.update_visible_tile_dpr(state.scale, false, true);
                window.tileRenderer.mark_all();
            }
        }
        state.isScaling = false;
    } else if (e.touches.length === 1) {
        state.isScaling = false;
        main_update_move_bound();
        main_update_canvas_position();
        dom.canvasWrapper.style.transform = `translate3d(${state.canvasX}px, ${state.canvasY}px, 0) scale(${state.scale})`;
        
        const touch = e.touches[0];
        if (state.drawMode === 'move') {
            state.isDragging = true;
            state.startDragX = touch.clientX - state.canvasX;
            state.startDragY = touch.clientY - state.canvasY;
        }
    }
}

function main_calc_touch_distance_squared(touch1, touch2) {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return dx * dx + dy * dy;
}

function main_update_canvas_transform() {
    if (last_canvas_transform.x === state.canvasX && 
        last_canvas_transform.y === state.canvasY && 
        last_canvas_transform.scale === state.scale) {
        return;
    }
    
    last_canvas_transform.x = state.canvasX;
    last_canvas_transform.y = state.canvasY;
    last_canvas_transform.scale = state.scale;
    
    const transform = `translate3d(${state.canvasX}px, ${state.canvasY}px, 0) scale(${state.scale})`;
    dom.canvasWrapper.style.transform = transform;

    if (window.tileRenderer) {
        window.tileRenderer.update_visible_tile_dpr(state.scale, false, true);
    }
}

function main_update_canvas_transform_smooth(targetX, targetY, targetScale, duration = 250) {
    if (currentAnimationId !== null) {
        clearTimeout(currentAnimationId);
        currentAnimationId = null;
    }
    
    state.canvasX = targetX;
    state.canvasY = targetY;
    state.scale = targetScale;
    
    main_update_move_bound();
    main_update_canvas_position();
    
    last_canvas_transform.x = state.canvasX;
    last_canvas_transform.y = state.canvasY;
    last_canvas_transform.scale = state.scale;
    
    dom.canvasWrapper.classList.add('smooth-transform');
    dom.canvasWrapper.style.transform = `translate3d(${state.canvasX}px, ${state.canvasY}px, 0) scale(${state.scale})`;

    if (window.tileRenderer) {
        window.tileRenderer.update_visible_tile_dpr(state.scale);
    }
    
    currentAnimationId = setTimeout(() => {
        currentAnimationId = null;
        dom.canvasWrapper.classList.remove('smooth-transform');
    }, duration);
}

// 撤销功能 - 混合方案：路径记录 + ImageData 压缩
function main_start_stroke(type) {
    const invScale = 1 / main_fetch_safe_scale();
    state.currentStroke = {
        type: type,
        points: [],
        color: type === 'draw' ? DRAW_CONFIG.penColor : '#000000',
        lineWidth: (type === 'draw' ? DRAW_CONFIG.penWidth : DRAW_CONFIG.eraserSize) * invScale,
        eraserSize: DRAW_CONFIG.eraserSize * invScale,
        eraserSizeRaw: DRAW_CONFIG.eraserSize,
        scale: state.scale,
        bounds: {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        },
        variableWidths: null
    };
    
    state.currentPressure = 0.5;
    state.currentLineWidth = DRAW_CONFIG.penWidth * invScale;
    state.lastLineWidth = DRAW_CONFIG.penWidth * invScale;
    
    state.cachedDrawType = type;
    state.cachedDrawColor = type === 'draw' ? DRAW_CONFIG.penColor : '#000000';
    state.cachedDrawLineWidth = (type === 'draw' ? DRAW_CONFIG.penWidth : DRAW_CONFIG.eraserSize) * invScale;
    
    batchDrawManager.batch_draw_init_start();
}

function main_save_stroke_point(fromX, fromY, toX, toY, pressure = 0.5) {
    const stroke = state.currentStroke;
    if (!stroke) return;
    
    const bounds = stroke.bounds;
    if (fromX < bounds.minX) bounds.minX = fromX;
    if (toX < bounds.minX) bounds.minX = toX;
    if (fromY < bounds.minY) bounds.minY = fromY;
    if (toY < bounds.minY) bounds.minY = toY;
    if (fromX > bounds.maxX) bounds.maxX = fromX;
    if (toX > bounds.maxX) bounds.maxX = toX;
    if (fromY > bounds.maxY) bounds.maxY = fromY;
    if (toY > bounds.maxY) bounds.maxY = toY;
    
    if (stroke.type === 'draw') {
        state.currentPressure = pressure;
        state.lastLineWidth = state.currentLineWidth;
        state.currentLineWidth = stroke.lineWidth * (0.9 + pressure * 0.2);
    }
    
    const points = stroke.points;
    points.push({ fromX, fromY, toX, toY });
}

async function main_submit_stroke() {
    if (state.currentStroke && state.currentStroke.points.length > 0) {
        // 强制刷新待处理命令，确保 _storedWidths 包含所有段的线宽
        batchDrawManager.batch_draw_handle_flush();
        // 捕获实时绘制的逐段宽度，确保离线渲染与实时预览一致
        const storedWidths = batchDrawManager._storedWidths;
        if (storedWidths && storedWidths.length > 0 &&
            storedWidths.length === state.currentStroke.points.length) {
            state.currentStroke.storedWidths = [...storedWidths];
        }
        
        const halfWidth = Math.max(state.currentStroke.lineWidth || 5, state.currentStroke.eraserSize || 5) / 2;
        const strokeBounds = state.currentStroke && state.currentStroke.bounds
            ? {
                minX: state.currentStroke.bounds.minX - halfWidth,
                minY: state.currentStroke.bounds.minY - halfWidth,
                maxX: state.currentStroke.bounds.maxX + halfWidth,
                maxY: state.currentStroke.bounds.maxY + halfWidth
            } : null;
        
        const cmd = new DrawCommand({
            stroke: state.currentStroke,
            strokeHistoryRef: state.strokeHistory,
            redrawFn: () => main_render_all_strokes(strokeBounds)
        });
        await history_execute_command(cmd, false);

        if (state.currentStroke.type === 'erase') {
            if (window.tileRenderer) {
                await main_render_all_strokes(strokeBounds);
            }
        } else {
            if (window.tileRenderer) {
                await window.tileRenderer.add_stroke(state.currentStroke);
            }
        }

        if (history_validate_compact()) {
            main_init_compact();
        }
    }
    state.currentStroke = null;

    await batchDrawManager.batch_draw_handle_end();

    batchDrawManager.batch_draw_delete_all();
}

async function main_render_all_strokes(bounds) {
    main_reset_context_state();
    const tr = window.tileRenderer;
    if (!tr) return;

    if (state.strokeHistory.length === 0 && !state.baseImageObj) {
        tr.mark_strokes_changed();
        tr.for_each((info) => {
            const ctx = info.ctx;
            const dpr = info.dpr;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, -info.rect.x * dpr, -info.rect.y * dpr);
            ctx.clearRect(info.rect.x, info.rect.y, info.rect.width, info.rect.height);
            ctx.restore();
        });
        tr.dirty.clear();
        return;
    }

    tr.mark_strokes_changed();

    if (bounds && isFinite(bounds.minX) && isFinite(bounds.minY) &&
                  isFinite(bounds.maxX) && isFinite(bounds.maxY)) {
        const infos = tr.infos_for_segment(
            bounds.minX, bounds.minY,
            bounds.maxX, bounds.maxY
        );
        for (const info of infos) {
            tr.dirty.add(info.key);
        }
    } else {
        tr.mark_all();
    }

    tr.rebuild_all();
}

function get_pen_effect_mode() {
    return DRAW_CONFIG.penEffectMode || 'off';
}
window.get_pen_effect_mode = get_pen_effect_mode;

let compactIdleId = null;

// 重置上下文状态缓存（在 tile rendering 后调用，避免缓存失效）
function main_reset_context_state() {
    currentContextState.strokeStyle = null;
    currentContextState.lineWidth = null;
    currentContextState.lineCap = null;
    currentContextState.lineJoin = null;
    currentContextState.globalCompositeOperation = null;
}
window.main_reset_context_state = main_reset_context_state;

// === 批注绘制系统 ===
// Canvas上下文状态缓存、笔画绘制、批注压缩

let currentContextState = {
    strokeStyle: null,
    lineWidth: null,
    lineCap: null,
    lineJoin: null,
    globalCompositeOperation: null
};

// === 上下文状态管理 ===

/**
 * 设置上下文状态（只更新变化的属性，避免冗余调用）
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} state - 含 strokeStyle/lineWidth/lineCap/lineJoin/globalCompositeOperation
 */
function main_update_context_state(ctx, state) {
    if (currentContextState.strokeStyle !== state.strokeStyle) {
        ctx.strokeStyle = state.strokeStyle;
        currentContextState.strokeStyle = state.strokeStyle;
    }
    
    if (currentContextState.lineWidth !== state.lineWidth) {
        ctx.lineWidth = state.lineWidth;
        currentContextState.lineWidth = state.lineWidth;
    }
    
    if (currentContextState.lineCap !== state.lineCap) {
        ctx.lineCap = state.lineCap;
        currentContextState.lineCap = state.lineCap;
    }
    
    if (currentContextState.lineJoin !== state.lineJoin) {
        ctx.lineJoin = state.lineJoin;
        currentContextState.lineJoin = state.lineJoin;
    }
    
    if (currentContextState.globalCompositeOperation !== state.globalCompositeOperation) {
        ctx.globalCompositeOperation = state.globalCompositeOperation;
        currentContextState.globalCompositeOperation = state.globalCompositeOperation;
    }
}
window.main_update_context_state = main_update_context_state;

/**
 * 按原始顺序逐个绘制笔画：draw/comment 用 source-over，erase 用 destination-out
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} strokes - 笔画数组
 */
async function main_render_strokes_to_context(ctx, strokes) {
    if (strokes.length === 0) return;

    main_reset_context_state();

    main_update_context_state(ctx, {
        lineCap: 'round',
        lineJoin: 'round'
    });

    const pen_effect = get_pen_effect_mode();

    for (const stroke of strokes) {
        if (!stroke.points || stroke.points.length < 1) continue;

        if (stroke.type === 'erase') {
            main_update_context_state(ctx, {
                globalCompositeOperation: 'destination-out',
                strokeStyle: '#000000',
                lineWidth: stroke.lineWidth || DRAW_CONFIG.eraserSize
            });
        } else {
            main_update_context_state(ctx, {
                globalCompositeOperation: 'source-over'
            });

            if (pen_effect !== 'off' && stroke.type === 'draw') {
                const tessellated = realPenManager.build_tessellated_stroke(stroke, pen_effect);
                if (tessellated) {
                    realPenManager.render_tessellated_stroke(ctx, tessellated);
                    continue;
                }
            }

            main_update_context_state(ctx, {
                strokeStyle: stroke.color || DRAW_CONFIG.penColor,
                lineWidth: stroke.lineWidth || DRAW_CONFIG.penWidth
            });
        }

        const path = new Path2D();
        const firstPoint = stroke.points[0];
        path.moveTo(firstPoint.fromX, firstPoint.fromY);
        path.lineTo(firstPoint.toX, firstPoint.toY);
        for (let i = 1; i < stroke.points.length; i++) {
            path.lineTo(stroke.points[i].fromX, stroke.points[i].fromY);
            path.lineTo(stroke.points[i].toX, stroke.points[i].toY);
        }
        ctx.stroke(path);
    }

    main_update_context_state(ctx, {
        globalCompositeOperation: 'source-over'
    });
}

function main_init_compact() {
    if (window.__HISTORY_ISOLATED) return;
    if (!history_validate_compact()) return;
    if (compactIdleId !== null) return;
    
    const undoStack = history_fetch_undo_stack();
    const hasNonCompactible = undoStack.some(cmd => cmd.can_compact && !cmd.can_compact());
    if (hasNonCompactible) {
        console.log('检测到不可压缩的操作，跳过压缩');
        return;
    }
    
    compactIdleId = requestIdleCallback((deadline) => {
        compactIdleId = null;
        main_handle_compact_strokes();
    }, { timeout: 2000 });
}

async function main_handle_compact_strokes() {
    if (window.__HISTORY_ISOLATED) return;
    if (!history_validate_compact()) return;
    
    const undoStack = history_fetch_undo_stack();
    const hasNonCompactible = undoStack.some(cmd => cmd.can_compact && !cmd.can_compact());
    if (hasNonCompactible) {
        console.log('压缩执行前检测到不可压缩的操作，取消压缩');
        return;
    }
    
    const commandsToCompact = history_fetch_commands_to_compact();
    if (commandsToCompact.length === 0) return;
    const compactTargetCount = commandsToCompact.length;
    
    const loadId = ++state.baseImageLoadId;
    state.compactSnapshotId = (state.compactSnapshotId || 0) + 1;
    const compactSnapshotId = state.compactSnapshotId;
    
    const beforeStrokes = main_main_stroke_clone_deep(state.strokeHistory);
    const frozenImageURL = state.baseImageURL;
    
    const strokesToCompactSet = new Set();
    commandsToCompact.forEach(cmd => {
        if (cmd.stroke) {
            strokesToCompactSet.add(cmd.stroke);
        }
    });
    const strokesToCompact = Array.from(strokesToCompactSet);
    
    if (window.__TAURI__) {
        try {
            const { invoke } = window.__TAURI__.core;
            
            const request = {
                baseImage: frozenImageURL,
                strokes: strokesToCompact,
                canvasWidth: DRAW_CONFIG.canvasW,
                canvasHeight: DRAW_CONFIG.canvasH
            };
            
            const result = await invoke('stroke_format_compact', { request });
            
            if (loadId !== state.baseImageLoadId) return;
            
            if (compactSnapshotId !== state.compactSnapshotId) {
                console.log('压缩快照已过期,取消操作');
                return;
            }
            
            if (!history_validate_compact()) {
                console.log('压缩期间撤销栈已变化，取消压缩');
                return;
            }
            
            const afterImageURL = result;
            
            const remainingStrokes = state.strokeHistory.filter(s => {
                return !strokesToCompactSet.has(s);
            });
            
            state.strokeHistory.length = 0;
            remainingStrokes.forEach(s => state.strokeHistory.push(s));
            
            const afterStrokes = [...state.strokeHistory];
            
            const snapshotCmd = new SnapshotCommand({
                beforeImageURL: frozenImageURL,
                afterImageURL,
                beforeStrokes,
                afterStrokes,
                strokeHistoryRef: state.strokeHistory,
                baseImageURLRef: { get value() { return state.baseImageURL; }, set value(v) { state.baseImageURL = v; } },
                baseImageObjRef: { get value() { return state.baseImageObj; }, set value(v) { state.baseImageObj = v; } },
                redrawFn: () => main_render_all_strokes(),
                loadBaseImageFn: (url) => main_load_base_image(url)
            });
            
            history_format_compact(snapshotCmd, compactTargetCount);
            
            state.baseImageURL = afterImageURL;
            state.baseImageObj = null;
            const img = new Image();
            img.onload = () => {
                if (loadId === state.baseImageLoadId) {
                    state.baseImageObj = img;
                    if (window.tileRenderer) window.tileRenderer.mark_all();
                }
            };
            img.src = afterImageURL;
            
            console.log('Rust 笔画已压缩，保留最近', history_fetch_undo_stack().length, '步可撤销');
            return;
        } catch (error) {
            console.error('Rust 笔画压缩失败，使用前端降级方案:', error);
        }
    }
    
    if (!history_validate_compact()) {
        console.log('压缩期间撤销栈已变化，取消压缩');
        return;
    }
    
    const offscreen = main_fetch_offscreen_canvas();
    const tempCtx = offscreen.ctx;
    
    if (state.baseImageObj) {
        tempCtx.drawImage(state.baseImageObj, 0, 0, DRAW_CONFIG.canvasW, DRAW_CONFIG.canvasH);
    }
    
    await main_render_strokes_to_context(tempCtx, strokesToCompact);
    
    if (loadId !== state.baseImageLoadId) {
        main_release_offscreen_canvas(offscreen);
        return;
    }
    
    if (compactSnapshotId !== state.compactSnapshotId) {
        console.log('压缩快照已过期,取消操作');
        main_release_offscreen_canvas(offscreen);
        return;
    }
    
    const afterImageURL = offscreen.canvas.toDataURL('image/png');
    
    const remainingStrokes = state.strokeHistory.filter(s => {
        return !strokesToCompactSet.has(s);
    });
    
    state.strokeHistory.length = 0;
    remainingStrokes.forEach(s => state.strokeHistory.push(s));
    
    const afterStrokes = [...state.strokeHistory];
    
    const snapshotCmd = new SnapshotCommand({
        beforeImageURL: frozenImageURL,
        afterImageURL,
        beforeStrokes,
        afterStrokes,
        strokeHistoryRef: state.strokeHistory,
        baseImageURLRef: { get value() { return state.baseImageURL; }, set value(v) { state.baseImageURL = v; } },
        baseImageObjRef: { get value() { return state.baseImageObj; }, set value(v) { state.baseImageObj = v; } },
        redrawFn: () => main_render_all_strokes(),
        loadBaseImageFn: (url) => main_load_base_image(url)
    });
    
    history_format_compact(snapshotCmd, compactTargetCount);
    
    state.baseImageURL = afterImageURL;
    state.baseImageObj = null;
    const img = new Image();
    img.onload = () => {
        if (loadId === state.baseImageLoadId) {
            state.baseImageObj = img;
            if (window.tileRenderer) window.tileRenderer.mark_all();
        }
        main_release_offscreen_canvas(offscreen);
    };
    img.onerror = () => {
        main_release_offscreen_canvas(offscreen);
    };
    img.src = afterImageURL;
    
    console.log('笔画已异步压缩，保留最近', history_fetch_undo_stack().length, '步可撤销');
}

function main_format_compact_strokes() {
    main_init_compact();
}

async function main_save_snapshot() {
    await main_submit_stroke();
}

async function main_handle_undo() {
    if (compactIdleId !== null) {
        cancelIdleCallback(compactIdleId);
        compactIdleId = null;
        console.log('撤销操作：取消正在进行的压缩任务');
    }
    
    state.baseImageLoadId++;
    state.compactSnapshotId = (state.compactSnapshotId || 0) + 1;
    
    // 撤销前清除钢笔效果缓存，使所有笔画使用当前设置重新计算
    realPenManager.invalidate_cache();
    
    await history_handle_undo();
    
    console.log('撤销操作');
}

function main_update_history_button_status() {
    dom.btnUndo.disabled = !history_validate_undo();
}

// 清空画布
function main_delete_draw_canvas() {
    if (window.tileRenderer) {
        window.tileRenderer.destroy_all();
        window.tileRenderer.init_tiles(dom.canvasWrapper);
    }
    if (window.batchDrawManager) {
        window.batchDrawManager.clear_overlay();
    }
    main_reset_context_state();
}

async function main_delete_all_drawings() {
    if (state.strokeHistory.length === 0 && !state.baseImageObj) return;
    
    const cmd = new ClearCommand({
        savedStrokeHistory: [...state.strokeHistory],
        savedBaseImageURL: state.baseImageURL,
        strokeHistoryRef: state.strokeHistory,
        baseImageURLRef: { get value() { return state.baseImageURL; }, set value(v) { state.baseImageURL = v; } },
        baseImageObjRef: { get value() { return state.baseImageObj; }, set value(v) { state.baseImageObj = v; } },
        redrawFn: () => main_render_all_strokes(),
        loadBaseImageFn: (url) => main_load_base_image(url)
    });
    await history_execute_command(cmd);
    
    main_delete_draw_canvas();
    
    if (currentSourceId) {
        main_save_current_source_data();
    }
    
    if (state.drawMode === 'eraser') {
        main_update_mode('comment');
    }
    
    console.log('清空所有批注');
}

function main_load_base_image(url) {
    const loadId = ++state.baseImageLoadId;
    const img = new Image();
    img.onload = () => {
        if (loadId === state.baseImageLoadId) {
            state.baseImageObj = img;
            if (window.tileRenderer) window.tileRenderer.mark_all();
            main_render_all_strokes();
        }
    };
    img.onerror = () => {
        console.error('base image 加载失败:', url ? url.substring(0, 50) + '...' : 'null');
        if (loadId === state.baseImageLoadId) {
            state.baseImageObj = null;
            if (window.tileRenderer) window.tileRenderer.mark_all();
            main_render_all_strokes();
        }
    };
    img.src = url;
}

// 拍照/切换回摄像头/保存画布截图
function main_save_photo() {
    if (state.isCameraOpen) {
        main_save_camera_image();
    } else if (state.currentImageIndex >= 0 && state.imageList.length > 0) {
        (async () => {
            try {
                main_save_current_source_data();
                state.currentImageIndex = -1;
                state.currentImage = null;
                currentSourceId = null;
                main_delete_image_layer();
                main_delete_draw_canvas();
                await main_update_source('cam');
                if (!state.isCameraOpen) {
                    await main_update_camera_state(true);
                }
                main_update_sidebar_selection();
                main_update_photo_button_state();
            } catch (error) {
                console.error('返回摄像头失败:', error);
                if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                    main_show_no_camera_message(window.i18n?.format_translate('camera.notDetected') || '未检测到摄像头');
                } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                    main_show_no_camera_message(window.i18n?.format_translate('camera.noPermission') || '无摄像头权限');
                } else {
                    main_show_no_camera_message(window.i18n?.format_translate('camera.initFailed') || '摄像头初始化失败');
                }
            }
        })();
    } else if (state.currentFolderIndex >= 0 && state.currentFolderPageIndex >= 0) {
        (async () => {
            try {
                main_save_current_source_data();
                state.currentFolderIndex = -1;
                state.currentFolderPageIndex = -1;
                state.currentImage = null;
                currentSourceId = null;
                main_delete_image_layer();
                main_delete_draw_canvas();
                await main_update_source('cam');
                if (!state.isCameraOpen) {
                    await main_update_camera_state(true);
                }
                main_update_photo_button_state();
            } catch (error) {
                console.error('返回摄像头失败:', error);
            }
        })();
    } else {
        main_save_merged_canvas();
    }
}

function main_save_merged_canvas() {
    console.log('执行拍照功能');
    const offscreen = main_fetch_offscreen_canvas();
    const mergedCtx = offscreen.ctx;
    
    mergedCtx.fillStyle = '#3a3a3a';
    mergedCtx.fillRect(0, 0, DRAW_CONFIG.canvasW, DRAW_CONFIG.canvasH);
    
    if (dom.imageElement.src) {
        mergedCtx.drawImage(dom.imageElement, 
            parseFloat(dom.imageElement.style.left) || 0, 
            parseFloat(dom.imageElement.style.top) || 0, 
            parseFloat(dom.imageElement.style.width) || DRAW_CONFIG.canvasW, 
            parseFloat(dom.imageElement.style.height) || DRAW_CONFIG.canvasH
        );
    }
    const tr = window.tileRenderer;
    if (tr) {
        for (const info of tr.tileInfos) {
            if (info.canvas) {
                mergedCtx.drawImage(
                    info.canvas,
                    0, 0,
                    info.canvas.width, info.canvas.height,
                    info.rect.x, info.rect.y,
                    info.rect.width, info.rect.height
                );
            }
        }
    }
    
    const link = document.createElement('a');
    link.download = `photo_${Date.now()}.png`;
    link.href = offscreen.canvas.toDataURL('image/png');
    link.click();
    
    main_release_offscreen_canvas(offscreen);
}

let lastPhotoButtonState = null;

function main_update_photo_button_state() {
    const btnPhoto = dom.btnPhoto;
    
    if (!state.cameraAvailable) {
        if (btnPhoto) btnPhoto.style.display = 'none';
        return;
    }
    
    if (btnPhoto) btnPhoto.style.display = '';
    
    if (!btnPhoto) return;
    
    let newState;
    let html, title;
    
    const photoText = window.i18n?.format_translate('toolbar.photo') || '拍照';
    const switchToCameraText = window.i18n?.format_translate('camera.switchToCamera') || '切换到摄像头';
    const showText = ThemeManager.theme_fetch_toolbar_text();
    
    if (state.isCameraOpen) {
        newState = 'camera';
        html = `${ThemeManager.theme_fetch_icon('camera', { alt: photoText })}${showText ? photoText : ''}`;
        title = window.i18n?.format_translate('camera.captureFrame') || '捕获摄像头画面';
    } else if ((state.currentImageIndex >= 0 && state.imageList.length > 0) || 
               (state.currentFolderIndex >= 0 && state.currentFolderPageIndex >= 0)) {
        newState = 'switch';
        html = `${ThemeManager.theme_fetch_icon('camera-fill', { alt: switchToCameraText })}${showText ? switchToCameraText : ''}`;
        title = window.i18n?.format_translate('camera.switchToCamera') || '返回摄像头';
    } else {
        newState = 'save';
        html = `${ThemeManager.theme_fetch_icon('camera', { alt: photoText })}${showText ? photoText : ''}`;
        title = window.i18n?.format_translate('camera.saveScreenshot') || '保存画布截图';
    }
    
    if (lastPhotoButtonState === newState) return;
    lastPhotoButtonState = newState;
    
    btnPhoto.innerHTML = html;
    btnPhoto.title = title;
}

// 设置功能
function main_show_settings() {
    const existingPanel = dom.settingsPanel.classList.contains('visible');
    if (existingPanel) {
        main_hide_settings_panel();
    } else {
        main_show_settings_panel();
    }
}

function main_show_settings_panel() {
    main_hide_pen_control_panel();
    
    const panel = dom.settingsPanel;
    const btnRect = dom.btnSettings.getBoundingClientRect();
    const containerRect = document.querySelector('.main-function').getBoundingClientRect();
    
    const panelWidth = 130;
    const panelHeight = panel.offsetHeight || 50;
    
    let left = btnRect.left - containerRect.left + (btnRect.width / 2) - (panelWidth / 2);
    let top = btnRect.top - containerRect.top - panelHeight - 10;
    
    if (left < 10) left = 10;
    if (left + panelWidth > containerRect.width - 10) {
        left = containerRect.width - panelWidth - 10;
    }
    
    if (top < 10) {
        top = btnRect.bottom - containerRect.top + 10;
    }
    
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.classList.add('visible');

    main_update_settings_controls_state();
}

function main_hide_settings_panel() {
    dom.settingsPanel.classList.remove('visible');
}

function main_update_settings_controls_state() {
    const brightnessRow = dom.settingsPanel?.querySelector('.settings-slider-row:has(#cameraBrightness)');
    const contrastRow = dom.settingsPanel?.querySelector('.settings-slider-row:has(#cameraContrast)');
    const brightnessInput = document.getElementById('cameraBrightness');
    const contrastInput = document.getElementById('cameraContrast');

    const disabled = !state.isCameraOpen;

    if (brightnessRow) {
        brightnessRow.classList.toggle('settings-controls-disabled', disabled);
    }
    if (contrastRow) {
        contrastRow.classList.toggle('settings-controls-disabled', disabled);
    }
    if (brightnessInput) {
        brightnessInput.disabled = disabled;
    }
    if (contrastInput) {
        contrastInput.disabled = disabled;
    }
}

function main_show_settings_window() {
    if (window.__TAURI__) {
        const { invoke } = window.__TAURI__.core;
        invoke('window_show_settings').catch(error => {
            console.error('打开设置窗口失败:', error);
        });
    }
}

async function main_update_image_rotation(direction) {
    if (state.isCameraOpen) {
        if (direction === 'left') {
            state.cameraRotation = (state.cameraRotation - 90 + 360) % 360;
        } else {
            state.cameraRotation = (state.cameraRotation + 90) % 360;
        }
        main_update_camera_video_style();
        console.log(`摄像头画面已旋转到 ${state.cameraRotation}°`);
        return;
    }
    
    if (!state.currentImage) {
        console.log('没有图片可旋转');
        return;
    }
    
    let rotatedDataUrl;
    
    if (window.__TAURI__) {
        try {
            const { invoke } = window.__TAURI__.core;
            rotatedDataUrl = await invoke('image_update_rotation', { 
                imageData: state.currentImage.src, 
                direction: direction 
            });
            console.log('Rust 图片旋转完成');
        } catch (error) {
            console.error('Rust 图片旋转失败，使用前端降级方案:', error);
            rotatedDataUrl = main_update_image_rotation_fallback(state.currentImage, direction);
        }
    } else {
        rotatedDataUrl = main_update_image_rotation_fallback(state.currentImage, direction);
    }
    
    const rotatedImg = new Image();
    rotatedImg.onload = async () => {
        state.currentImage = rotatedImg;
        
        if (state.currentImageIndex >= 0 && state.currentImageIndex < state.imageList.length) {
            state.imageList[state.currentImageIndex].full = rotatedImg.src;
            state.imageList[state.currentImageIndex].thumbnail = rotatedImg.src;
            state.imageList[state.currentImageIndex].width = rotatedImg.width;
            state.imageList[state.currentImageIndex].height = rotatedImg.height;
            
            main_update_sidebar_content();
        }
        
        main_render_image_centered(rotatedImg);
        console.log(`图片已向${direction === 'left' ? '左' : '右'}旋转`);
    };
    rotatedImg.src = rotatedDataUrl;
}

function main_update_image_rotation_fallback(img, direction) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (direction === 'left') {
        canvas.width = img.height;
        canvas.height = img.width;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
    } else {
        canvas.width = img.height;
        canvas.height = img.width;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
    }
    
    return canvas.toDataURL('image/png');
}

const SIDEBAR_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="113"><rect fill="#2a2a2e" width="200" height="113"/></svg>');

let sidebarObserver = null;

function main_destroy_sidebar_lazy_loader() {
    if (sidebarObserver) {
        sidebarObserver.disconnect();
        sidebarObserver = null;
    }
}

function main_setup_sidebar_lazy_loader(sidebarContent) {
    main_destroy_sidebar_lazy_loader();

    sidebarObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const item = entry.target;
            const img = item.querySelector('.sidebar-thumbnail');
            if (!img) continue;

            if (entry.isIntersecting) {
                if (img.src === SIDEBAR_PLACEHOLDER) {
                    const index = parseInt(item.dataset.index);
                    const imgData = state.imageList[index];
                    if (imgData && imgData.thumbnail) {
                        img.src = imgData.thumbnail;
                    }
                }
            }
        }
    }, {
        root: sidebarContent,
        rootMargin: '300px 0px'
    });

    sidebarContent.querySelectorAll('.sidebar-image-item').forEach(item => {
        sidebarObserver.observe(item);
    });
}

function main_handle_sidebar_toggle() {
    const existingSidebar = document.querySelector('.sidebar:not(.file-sidebar)');
    const existingFileSidebar = document.querySelector('.file-sidebar');
    
    if (existingFileSidebar) {
        main_hide_file_sidebar();
    }
    
    if (existingSidebar) {
        main_hide_sidebar();
    } else {
        main_show_sidebar();
    }
}

function main_show_sidebar() {
    const sidebarElement = document.createElement('div');
    sidebarElement.classList.add('sidebar');
    
    const noImagesText = window.i18n?.format_translate('common.noImages') || '暂无图片';
    const imageListText = window.i18n?.format_translate('sidebar.imageList') || '图片列表';
    const importImageText = window.i18n?.format_translate('sidebar.importImage') || '导入图片';
    const deleteText = window.i18n?.format_translate('common.delete') || '删除';
    const collapseText = window.i18n?.format_translate('common.collapse') || '收起';
    
    let imageListHTML = '';
    if (state.imageList.length === 0) {
        imageListHTML = `<div class="sidebar-empty">${noImagesText}</div>`;
    } else {
        state.imageList.forEach((imgData, index) => {
            const isActive = (state.currentImageIndex >= 0 && index === state.currentImageIndex) ? 'active' : '';
            const imageAlt = window.i18n?.format_translate('sidebar.imageAlt', { n: index + 1 }) || `图片${index + 1}`;
            imageListHTML += `
                <div class="sidebar-image-item ${isActive}" data-index="${index}">
                    <img src="${imgData.thumbnail}" class="sidebar-thumbnail" alt="${imageAlt}" loading="lazy">
                    <div class="sidebar-image-actions">
                        <button class="sidebar-btn-delete" title="${deleteText}">✕</button>
                    </div>
                </div>
            `;
        });
    }
    
    sidebarElement.innerHTML = `
        <div class="sidebar-header"><span class="sidebar-header-text">${imageListText}</span></div>
        <div class="sidebar-content">
            ${imageListHTML}
        </div>
        <button class="sidebar-import-btn" id="btnImportImageSidebar">
            ${ThemeManager.theme_fetch_icon('image', { alt: importImageText })}
            ${importImageText}
        </button>
    `;
    dom.canvasContainer.appendChild(sidebarElement);
    
    document.getElementById('btnImportImageSidebar')?.addEventListener('click', main_load_image);
    
    document.querySelectorAll('.sidebar-image-item').forEach(item => {
        const index = parseInt(item.dataset.index);
        
        item.querySelector('.sidebar-btn-delete')?.addEventListener('click', (e) => {
            e.stopPropagation();
            main_delete_image(index);
        });
        
        item.addEventListener('click', () => main_update_image_selection(index));
    });
    
    const sidebarContent = sidebarElement.querySelector('.sidebar-content');
    if (sidebarContent && state.imageList.length > 0) {
        main_setup_sidebar_lazy_loader(sidebarContent);
    }
    
    const showText = ThemeManager.theme_fetch_toolbar_text();
    dom.btnExpand.innerHTML = `
        ${ThemeManager.theme_fetch_icon('collapse', { alt: collapseText })}
        ${showText ? collapseText : ''}
    `;
    console.log('展开侧边栏');
}

async function main_update_image_selection(index) {
    if (index < 0 || index >= state.imageList.length) return;
    
    if (index === state.currentImageIndex && state.currentImage) {
        (async () => {
            try {
                main_save_current_source_data();
                
                state.currentImageIndex = -1;
                state.currentImage = null;
                currentSourceId = null;
                main_delete_image_layer();
                main_delete_draw_canvas();
                
                if (state.isCameraOpen) {
                    await main_update_camera_state(false);
                }
                
                await main_update_source('cam');
                
                if (!state.isCameraOpen) {
                    await main_update_camera_state(true);
                }
                
                main_update_sidebar_selection();
                main_update_photo_button_state();
                console.log('返回摄像头');
            } catch (error) {
                console.error('返回摄像头失败:', error);
            }
        })();
        return;
    }
    
    state.currentImageIndex = index;
    state.currentFolderIndex = -1;
    state.currentFolderPageIndex = -1;
    
    // 使用源ID切换源（自动保存当前并加载目标源的数据）
    const imgData = state.imageList[index];
    
    if (!imgData.sourceId) {
        imgData.sourceId = main_create_source_id('pic');
    }
    
    await main_update_source(imgData.sourceId);
    
    const img = new Image();
    img.onload = async () => {
        state.currentImage = img;
        
        if (state.isCameraOpen) {
            await main_update_camera_state(false);
        }
        main_render_image_centered(img);
        
        await main_render_all_strokes();
        main_update_sidebar_selection();
        main_update_photo_button_state();
    };
    img.onerror = () => {
        console.error(`加载图片 ${index + 1} 失败`);
    };
    img.src = imgData.full;
    
    console.log(`切换到图片 ${index + 1}`);
}

function main_save_draw_data() {
    if (state.currentImageIndex >= 0 && state.currentImageIndex < state.imageList.length) {
        const imgData = state.imageList[state.currentImageIndex];
        
        if (imgData.sourceId) {
            main_save_current_source_data();
        }
    }
}

async function main_load_draw_data(index) {
    if (index >= 0 && index < state.imageList.length) {
        const imgData = state.imageList[index];
        
        if (imgData.sourceId) {
            await main_update_source(imgData.sourceId);
        }
    }
}

function main_delete_image(index) {
    if (index < 0 || index >= state.imageList.length) return;
    
    const imgData = state.imageList[index];
    if (imgData.full && imgData.full.startsWith('blob:')) {
        URL.revokeObjectURL(imgData.full);
    }
    if (imgData.thumbnail && imgData.thumbnail.startsWith('blob:')) {
        URL.revokeObjectURL(imgData.thumbnail);
    }
    
    state.imageList.splice(index, 1);
    
    if (state.currentImageIndex === index) {
        if (state.imageList.length > 0) {
            const newIndex = Math.min(index, state.imageList.length - 1);
            state.currentImageIndex = -1;
            main_update_image_selection(newIndex);
        } else {
            state.currentImageIndex = -1;
            state.currentImage = null;
            main_delete_image_layer();
            main_delete_draw_canvas();
            main_update_photo_button_state();
            main_init_camera();
        }
    } else if (state.currentImageIndex > index) {
        state.currentImageIndex--;
    }
    
    main_update_sidebar_content();
    console.log(`删除图片 ${index + 1}`);
}

let lastSidebarSelection = -2;

function main_update_sidebar_selection() {
    if (lastSidebarSelection === state.currentImageIndex) return;
    
    const sidebarContent = document.querySelector('.sidebar:not(.file-sidebar) .sidebar-content');
    if (!sidebarContent) return;
    
    const items = sidebarContent.querySelectorAll('.sidebar-image-item');
    
    if (lastSidebarSelection >= 0 && lastSidebarSelection < items.length) {
        const prevItem = items[lastSidebarSelection];
        prevItem.classList.remove('active');
    }
    
    if (state.currentImageIndex >= 0 && state.currentImageIndex < items.length) {
        const curItem = items[state.currentImageIndex];
        curItem.classList.add('active');
        const curImg = curItem.querySelector('.sidebar-thumbnail');
        if (curImg && curImg.src === SIDEBAR_PLACEHOLDER) {
            const imgData = state.imageList[state.currentImageIndex];
            if (imgData && imgData.thumbnail) {
                curImg.src = imgData.thumbnail;
            }
        }
    }
    
    lastSidebarSelection = state.currentImageIndex;
    
    document.querySelectorAll('.file-sidebar .sidebar-image-item').forEach(item => {
        item.classList.remove('active');
    });
}

function main_update_sidebar_content() {
    const sidebarContent = document.querySelector('.sidebar:not(.file-sidebar) .sidebar-content');
    if (!sidebarContent) return;
    
    const noImagesText = window.i18n?.format_translate('common.noImages') || '暂无图片';
    const deleteText = window.i18n?.format_translate('common.delete') || '删除';
    
    let imageListHTML = '';
    if (state.imageList.length === 0) {
        imageListHTML = `<div class="sidebar-empty">${noImagesText}</div>`;
    } else {
        state.imageList.forEach((imgData, index) => {
            const isActive = (state.currentImageIndex >= 0 && index === state.currentImageIndex) ? 'active' : '';
            const imageAlt = window.i18n?.format_translate('sidebar.imageAlt', { n: index + 1 }) || `图片${index + 1}`;
            imageListHTML += `
                <div class="sidebar-image-item ${isActive}" data-index="${index}">
                    <img src="${imgData.thumbnail}" class="sidebar-thumbnail" alt="${imageAlt}" loading="lazy">
                    <div class="sidebar-image-actions">
                        <button class="sidebar-btn-delete" title="${deleteText}">✕</button>
                    </div>
                </div>
            `;
        });
    }
    
    sidebarContent.innerHTML = imageListHTML;
    
    document.querySelectorAll('.sidebar-image-item').forEach(item => {
        const index = parseInt(item.dataset.index);
        
        item.querySelector('.sidebar-btn-delete')?.addEventListener('click', (e) => {
            e.stopPropagation();
            main_delete_image(index);
        });
        
        item.addEventListener('click', () => main_update_image_selection(index));
    });
    
    if (state.imageList.length > 0) {
        main_setup_sidebar_lazy_loader(sidebarContent);
        const activeItem = sidebarContent.querySelector('.sidebar-image-item.active');
        if (activeItem) {
            activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}

function main_hide_sidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.classList.add('collapse');
        sidebar.addEventListener('animationend', function() {
            sidebar.remove();
        }, { once: true });
    }
    
    main_destroy_sidebar_lazy_loader();
    
    const imageText = window.i18n?.format_translate('toolbar.image') || '图片';
    const showText = ThemeManager.theme_fetch_toolbar_text();
    dom.btnExpand.innerHTML = `
        ${ThemeManager.theme_fetch_icon('image', { alt: imageText })}
        ${showText ? imageText : ''}
    `;
    console.log('收起侧边栏');
}

// 文件侧边栏
function main_handle_file_sidebar_toggle() {
    const existingFileSidebar = document.querySelector('.file-sidebar');
    const existingSidebar = document.querySelector('.sidebar:not(.file-sidebar)');
    
    if (existingSidebar) {
        main_hide_sidebar();
    }
    
    if (existingFileSidebar) {
        main_hide_file_sidebar();
    } else {
        main_show_file_sidebar();
    }
}

function main_show_file_sidebar() {
    const existingSidebar = document.querySelector('.file-sidebar');
    if (existingSidebar) {
        main_update_file_sidebar_content();
        return;
    }
    
    const noFilesText = window.i18n?.format_translate('common.noFiles') || '暂无文件';
    const fileListText = window.i18n?.format_translate('sidebar.fileList') || '文件列表';
    const addFileText = window.i18n?.format_translate('sidebar.addFile') || '添加文件';
    const collapseText = window.i18n?.format_translate('common.collapse') || '收起';
    
    const fileSidebarElement = document.createElement('div');
    fileSidebarElement.classList.add('sidebar', 'file-sidebar');
    
    let contentHTML = '';
    if (state.fileList.length === 0) {
        contentHTML = `<div class="sidebar-empty">${noFilesText}</div>`;
    } else {
        state.fileList.forEach((folder, index) => {
            const isWord = folder.isWord === true;
            const iconName = isWord ? 'word' : 'pdf';
            const fileAlt = window.i18n?.format_translate('toolbar.file') || '文件';
            const pagesText = window.i18n?.format_translate('sidebar.pages', { n: folder.pages.length }) || `${folder.pages.length}页`;
            contentHTML += `
                <div class="sidebar-folder-item" data-index="${index}">
                    ${ThemeManager.theme_fetch_icon(iconName, { alt: fileAlt })}
                    <span class="folder-name">${folder.name}</span>
                    <span class="folder-count">${pagesText}</span>
                </div>
            `;
        });
    }
    
    fileSidebarElement.innerHTML = `
        <div class="sidebar-header"><span class="sidebar-header-text">${fileListText}</span></div>
        <div class="sidebar-content">
            ${contentHTML}
        </div>
        <button class="sidebar-import-btn" id="btnAddFile">
            ${ThemeManager.theme_fetch_icon('addFile', { alt: addFileText })}
            ${addFileText}
        </button>
    `;
    
    dom.canvasContainer.appendChild(fileSidebarElement);
    
    document.getElementById('btnAddFile')?.addEventListener('click', () => {
        main_load_pdf();
    });
    
    document.querySelectorAll('.sidebar-folder-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            if (window.documentReaderManager) {
                main_hide_file_sidebar();
                window.documentReaderManager.open(index);
            }
        });
    });
    
    const showText = ThemeManager.theme_fetch_toolbar_text();
    dom.btnSave.innerHTML = `
        ${ThemeManager.theme_fetch_icon('collapse', { alt: collapseText })}
        ${showText ? collapseText : ''}
    `;
    console.log('展开文件侧边栏');
}



function main_update_file_sidebar_content() {
    const sidebarContent = document.querySelector('.file-sidebar .sidebar-content');
    if (!sidebarContent) return;
    
    const noFilesText = window.i18n?.format_translate('common.noFiles') || '暂无文件';
    
    let contentHTML = '';
    if (state.fileList.length === 0) {
        contentHTML = `<div class="sidebar-empty">${noFilesText}</div>`;
    } else {
        state.fileList.forEach((folder, index) => {
            const isWord = folder.isWord === true;
            const iconName = isWord ? 'word' : 'pdf';
            console.log(`文件夹 ${folder.name}: isWord=${isWord}, iconName=${iconName}`);
            const fileAlt = window.i18n?.format_translate('toolbar.file') || '文件';
            const pagesText = window.i18n?.format_translate('sidebar.pages', { n: folder.pages.length }) || `${folder.pages.length}页`;
            contentHTML += `
                <div class="sidebar-folder-item" data-index="${index}">
                    ${ThemeManager.theme_fetch_icon(iconName, { alt: fileAlt })}
                    <span class="folder-name">${folder.name}</span>
                    <span class="folder-count">${pagesText}</span>
                </div>
            `;
        });
    }
    
    sidebarContent.innerHTML = contentHTML;
    
    document.querySelectorAll('.sidebar-folder-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            if (window.documentReaderManager) {
                main_hide_file_sidebar();
                window.documentReaderManager.open(index);
            }
        });
    });
}

function main_load_pdf() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.doc';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        if (currentSourceId) {
            main_save_current_source_data();
        }
        
        const wasCameraOpen = state.isCameraOpen;
        
        if (state.isCameraOpen) {
            await main_update_camera_state(false);
        }
        
        const fileName = file.name.toLowerCase();
        const isWord = fileName.endsWith('.docx') || fileName.endsWith('.doc');
        
        if (isWord) {
            main_show_loading_overlay(window.i18n?.format_translate('loading.detectingOffice') || '正在检测 Office 软件...');
            
            const { invoke } = window.__TAURI__.core;
            
            let detection;
            try {
                detection = await invoke('office_detect_all');
                console.log('Office 检测结果:', detection);
                if (detection.recommended === 'None') {
                    main_hide_loading_overlay();
                    main_show_error_dialog(
                        window.i18n?.format_translate('errors.officeNotInstalled') || 'Office 未安装',
                        window.i18n?.format_translate('errors.officeNotInstalledDesc') || '未检测到可用的 Office 软件\n\n请安装以下软件之一：\n• Microsoft Word\n• WPS Office\n• LibreOffice\n\n或将 Word 文档另存为 PDF 后导入'
                    );
                    if (wasCameraOpen) await main_update_camera_state(true);
                    return;
                }
            } catch (e) {
                main_hide_loading_overlay();
                console.log('检测 Office 失败:', e);
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.officeDetectFailed') || '检测失败',
                    window.i18n?.format_translate('errors.officeDetectFailedDesc') || '检测 Office 软件失败，请重试'
                );
                if (wasCameraOpen) await main_update_camera_state(true);
                return;
            }
            
            main_update_loading_progress(window.i18n?.format_translate('loading.readingFile') || '正在读取文件...');
            
            let arrayBuffer = await file.arrayBuffer();
            let uint8Array = new Uint8Array(arrayBuffer);
            const fileMd5 = main_calculate_md5(uint8Array);
            
            console.log('文件大小:', uint8Array.length, '字节');
            
            main_update_loading_progress(window.i18n?.format_translate('loading.processingWord') || '正在处理 Word 文档...');
            
            let pdfPath = null;
            try {
                const nativeFilePath = file.path || file._path || null;
                if (nativeFilePath) {
                    arrayBuffer = null;
                    uint8Array = null;
                    pdfPath = await invoke('office_convert_docx_to_pdf', {
                        docxPath: nativeFilePath
                    });
                } else {
                    const fileDataForConvert = Array.from(uint8Array);
                    arrayBuffer = null;
                    uint8Array = null;
                    pdfPath = await invoke('office_convert_docx_to_pdf_bytes', {
                        fileData: fileDataForConvert,
                        fileName: file.name
                    });
                }
                console.log('Word 文档已转换为 PDF:', pdfPath);
            } catch (convertError) {
                main_hide_loading_overlay();
                console.error('Word 转换失败:', convertError);
                const errorMsg = String(convertError);
                let friendlyMsg = window.i18n?.format_translate('errors.wordConvertFailed') || 'Word 文档转换失败';
                
                if (errorMsg.includes('Office') || errorMsg.includes('Word') || errorMsg.includes('WPS')) {
                    friendlyMsg = window.i18n?.format_translate('errors.officeCallFailed') || 'Office 软件调用失败\n\n可能的原因：\n• Office 软件未正确安装\n• 文件被其他程序占用\n• 文件格式不支持';
                }
                
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.convertFailed') || '转换失败',
                    friendlyMsg,
                    () => {
                        main_load_pdf();
                    }
                );
                if (wasCameraOpen) await main_update_camera_state(true);
                return;
            }
            
            main_update_loading_progress(window.i18n?.format_translate('loading.renderingPage') || '正在渲染页面...');
            
            try {
                const pdfReady = await main_wait_pdfjs();
                if (!pdfReady) {
                    main_hide_loading_overlay();
                    main_show_error_dialog(
                        window.i18n?.format_translate('errors.loadFailed') || '加载失败',
                        window.i18n?.format_translate('errors.pdfLoadTimeout') || 'PDF 库加载超时\n\n请重启应用后重试'
                    );
                    if (wasCameraOpen) await main_update_camera_state(true);
                    return;
                }
                
                const { readFile, remove } = window.__TAURI__.fs;
                let pdfBytes = await readFile(pdfPath);
                let pdfArrayBuffer = pdfBytes.buffer;
                const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
                pdfBytes = null;
                pdfArrayBuffer = null;
                
                const totalPages = pdf.numPages;
                const docNumber = sourceIdCounters.doc++;
                const folder = {
                    name: file.name.replace(/\.(pdf|docx|doc)$/i, ''),
                    pages: [],
                    isWord: true,
                    pdfDoc: pdf,
                    totalPages: totalPages,
                    docNumber: docNumber,
                    fileMd5: fileMd5
                };
                
                folder.pages = await main_render_pdf_pages_lazy(pdf, totalPages, PDF_INITIAL_RENDER_PAGES, docNumber);
                
                state.fileList.push(folder);
                main_update_file_sidebar_content();
                
                const existingFileSidebar = document.querySelector('.file-sidebar');
                if (!existingFileSidebar) {
                    main_show_file_sidebar();
                }
                
                main_hide_loading_overlay();
                console.log(`文件已导入: ${folder.name}，共${folder.pages.length}页`);
                
                if (wasCameraOpen) await main_update_camera_state(true);
                
                try {
                    await remove(pdfPath);
                } catch (e) {
                    console.log('清理转换的 PDF 失败:', e);
                }
            } catch (error) {
                main_hide_loading_overlay();
                console.error('文件导入失败:', error);
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.importFailed') || '导入失败',
                    window.i18n?.format_translate('errors.importFailedDesc') || '文件导入失败，请确保文件格式正确'
                );
                if (wasCameraOpen) await main_update_camera_state(true);
            }
        } else {
            main_show_loading_overlay(window.i18n?.format_translate('loading.importingFile') || '正在导入文件...');
            
            try {
                const pdfReady = await main_wait_pdfjs();
                if (!pdfReady) {
                    main_hide_loading_overlay();
                    main_show_error_dialog(
                        window.i18n?.format_translate('errors.loadFailed') || '加载失败',
                        window.i18n?.format_translate('errors.pdfLoadTimeout') || 'PDF 库加载超时\n\n请重启应用后重试'
                    );
                    if (wasCameraOpen) await main_update_camera_state(true);
                    return;
                }
                
                let pdfArrayBuffer = await file.arrayBuffer();
                const fileMd5 = main_calculate_md5(new Uint8Array(pdfArrayBuffer));
                const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
                pdfArrayBuffer = null;
                
                const totalPages = pdf.numPages;
                const docNumber = sourceIdCounters.doc++;
                const folder = {
                    name: file.name.replace('.pdf', ''),
                    pages: [],
                    pdfDoc: pdf,
                    totalPages: totalPages,
                    docNumber: docNumber,
                    fileMd5: fileMd5
                };
                
                folder.pages = await main_render_pdf_pages_lazy(pdf, totalPages, PDF_INITIAL_RENDER_PAGES, docNumber);
                
                state.fileList.push(folder);
                main_update_file_sidebar_content();
                
                const existingFileSidebar = document.querySelector('.file-sidebar');
                if (!existingFileSidebar) {
                    main_show_file_sidebar();
                }
                
                main_hide_loading_overlay();
                console.log(`文件已导入: ${folder.name}，共${folder.pages.length}页`);
                
                if (wasCameraOpen) await main_update_camera_state(true);
            } catch (error) {
                main_hide_loading_overlay();
                console.error('文件导入失败:', error);
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.importFailed') || '导入失败',
                    window.i18n?.format_translate('errors.importFailedDesc') || '文件导入失败，请确保文件格式正确'
                );
                if (wasCameraOpen) await main_update_camera_state(true);
            }
        }
    };
    
    input.click();
}

function main_show_loading_overlay(message) {
    DocLoader.show_loading_overlay(message);
}

function main_update_loading_progress(message) {
    DocLoader.update_loading_progress(message);
}

function main_hide_loading_overlay() {
    DocLoader.hide_loading_overlay();
}

function main_show_error_dialog(title, message, retryCallback = null) {
    DocLoader.show_error_dialog(title, message, retryCallback);
}

function main_hide_file_sidebar() {
    const fileSidebar = document.querySelector('.file-sidebar');
    if (fileSidebar) {
        fileSidebar.classList.add('collapse');
        fileSidebar.addEventListener('animationend', function() {
            fileSidebar.remove();
        }, { once: true });
    }
    
    const fileText = window.i18n?.format_translate('toolbar.file') || '文件';
    const showText = ThemeManager.theme_fetch_toolbar_text();
    dom.btnSave.innerHTML = `
        ${ThemeManager.theme_fetch_icon('file', { alt: fileText })}
        ${showText ? fileText : ''}
    `;
    console.log('收起文件侧边栏');
}

// === 摄像头功能 ===
// 摄像头开启/关闭、帧渲染、拍照、旋转、镜像

/**
 * 统一的摄像头状态管理
 * @param {boolean} open - true:开启 false:关闭
 * @param {Object} [options] - {forceClose: true} 强制关闭
 */
async function main_update_camera_state(open, options = {}) {
    const { forceClose = false } = options;
    
    if (open) {
        if (state.isCameraOpen) {
            return;
        }
        
        try {
            // 保存当前源数据
            main_save_current_source_data();
            
            let constraints;
            
            if (state.defaultCameraId) {
                constraints = {
                    video: {
                        deviceId: { exact: state.defaultCameraId },
                        width: { ideal: state.cameraWidth || 1280 },
                        height: { ideal: state.cameraHeight || 720 }
                    },
                    audio: false
                };
            } else {
                const desiredFacingMode = state.useFrontCamera ? 'user' : 'environment';
                let useFacingMode = true;
                try {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const videoDevices = devices.filter(d => d.kind === 'videoinput');
                    if (videoDevices.length <= 1) {
                        useFacingMode = false;
                    }
                } catch (_) {
                    useFacingMode = false;
                }
                constraints = {
                    video: {
                        width: { ideal: state.cameraWidth || 1280 },
                        height: { ideal: state.cameraHeight || 720 },
                        ...(useFacingMode ? { facingMode: desiredFacingMode } : {})
                    },
                    audio: false
                };
            }
            
            try {
                state.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (constraintError) {
                if (constraintError.name === 'OverconstrainedError') {
                    console.warn('指定摄像头不可用，使用默认摄像头');
                    const fallbackConstraints = {
                        video: {
                            width: { ideal: state.cameraWidth || 1280 },
                            height: { ideal: state.cameraHeight || 720 }
                        },
                        audio: false
                    };
                    state.cameraStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
                } else {
                    throw constraintError;
                }
            }
            
            state.isCameraOpen = true;
            state.cameraAvailable = true;

            main_update_settings_controls_state();
            
            await main_update_source('cam');
            
            // 重置索引，避免摄像头批注被错误保存至旧图片源
            state.currentImageIndex = -1;
            state.currentFolderIndex = -1;
            state.currentFolderPageIndex = -1;
            
            main_hide_no_camera_message();
            
            const videoTrack = state.cameraStream.getVideoTracks()[0];
            const settings = videoTrack.getSettings();
            const label = videoTrack.label.toLowerCase();
            state.isMirrored = label.includes('front') || label.includes('user') || label.includes('前置') || settings.facingMode === 'user';
            
            main_create_camera_video();
            main_create_camera_controls();
            main_delete_sidebar_selection();
            
            console.log('摄像头已打开:', videoTrack.label || '未知设备', '分辨率:', settings.width, 'x', settings.height);
        } catch (error) {
            if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                console.log('未检测到摄像头');
            } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                console.log('摄像头权限被拒绝');
            } else {
                console.error('无法访问摄像头:', error);
            }
            throw error;
        }
    } else {
        // 关闭摄像头
        if (state.cameraAnimationId) {
            cancelAnimationFrame(state.cameraAnimationId);
            state.cameraAnimationId = null;
        }
        
        if (state.cameraStream) {
            state.cameraStream.getTracks().forEach(track => track.stop());
            state.cameraStream = null;
        }
        
        state.isCameraOpen = false;
        state.isCameraReady = false;

        main_update_settings_controls_state();
        if (dom.cameraVideo) {
            dom.cameraVideo.style.display = 'none';
            dom.cameraVideo.srcObject = null;
        }
        
        main_update_photo_button_state();
        
        // 保存摄像头数据
        main_save_current_source_data();
        
        // 恢复之前的数据
        if (state.currentImage && state.currentImageIndex >= 0) {
            const imgData = state.imageList[state.currentImageIndex];
            if (imgData && imgData.sourceId) {
                await main_update_source(imgData.sourceId);
            }
            main_render_image_centered(state.currentImage);
        } else if (state.currentImage && state.currentFolderIndex >= 0 && state.currentFolderPageIndex >= 0) {
            const folder = state.fileList[state.currentFolderIndex];
            const page = folder.pages[state.currentFolderPageIndex];
            if (page && page.sourceId) {
                await main_update_source(page.sourceId);
            }
            main_render_image_centered(state.currentImage);
        } else {
            main_delete_image_layer();
            main_delete_draw_canvas();
            state.strokeHistory = [];
            history_delete_all();
            currentSourceId = null;
        }
        
        console.log('摄像头已关闭');
    }
}

/**
 * 打开/关闭摄像头（用户交互入口）
 */
async function main_init_camera() {
    if (state.isCameraOpen) {
        await main_update_camera_state(false);
    } else {
        await main_update_camera_state(true);
    }
}

/**
 * 摄像头不可用时初始化，确保界面正常
 * @param {string} message - 无摄像头提示文字
 */
async function main_init_without_camera(message) {
    try {
        state.isCameraOpen = false;
        state.isCameraReady = false;
        state.cameraAvailable = false;
        state.cameraStream = null;

        main_update_settings_controls_state();
        
        if (dom.cameraVideo) {
            dom.cameraVideo.style.display = 'none';
            dom.cameraVideo.srcObject = null;
        }
        
        let bgColor = '#2a2a2a';
        try {
            const themeColor = ThemeManager.theme_fetch_canvas_bg_color();
            if (themeColor && typeof themeColor === 'string' && themeColor.match(/^#[0-9a-fA-F]{6}$/)) {
                bgColor = themeColor;
            }
        } catch (e) {
            console.warn('获取主题背景色失败，使用默认值:', e);
        }
        main_update_canvas_bg_color(bgColor);
        
        await main_update_source('cam');
        
        main_update_canvas_transform();
        main_update_move_bound();
        main_update_canvas_position();
        main_update_photo_button_state();
        
        main_show_no_camera_message(message);
        
        console.log('无摄像头模式初始化完成');
    } catch (error) {
        console.error('无摄像头模式初始化失败:', error);
        
        let fallbackBgColor = '#2a2a2a';
        try {
            const themeColor = ThemeManager.theme_fetch_canvas_bg_color();
            if (themeColor && typeof themeColor === 'string') {
                fallbackBgColor = themeColor;
            }
        } catch (e) {}
        main_update_canvas_bg_color(fallbackBgColor);
        
        main_show_no_camera_message(message || '摄像头不可用');
    }
}

function main_show_no_camera_message(message) {
    if (!dom.canvasWrapper) {
        console.error('main_show_no_camera_message: canvasWrapper 不存在');
        return;
    }
    
    let msgElement = document.getElementById('noCameraMessage');
    if (!msgElement) {
        msgElement = document.createElement('div');
        msgElement.id = 'noCameraMessage';
        dom.canvasWrapper.appendChild(msgElement);
    }
    
    let style = {
        textColor: '#ffffff',
        secondaryTextColor: 'rgba(255,255,255,0.8)',
        tertiaryTextColor: 'rgba(255,255,255,0.5)',
        textShadow: '0 1px 3px rgba(0,0,0,0.5)'
    };
    
    try {
        const themeStyle = ThemeManager.theme_fetch_no_camera_style();
        if (themeStyle) {
            style = themeStyle;
        }
    } catch (e) {
        console.warn('获取主题样式失败，使用默认值:', e);
    }
    
    msgElement.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: ${DRAW_CONFIG.canvasW}px;
        height: ${DRAW_CONFIG.canvasH}px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 1;
        pointer-events: none;
    `;
    
    msgElement.dataset.message = message || '';
    
    msgElement.innerHTML = `
        <div style="font-size: 4vw; color: ${style.textColor}; margin-bottom: 3vh; text-shadow: ${style.textShadow};">( $ _ $ )</div>
        <div style="font-size: 1.8vw; color: ${style.secondaryTextColor}; margin-bottom: 1.5vh; text-shadow: ${style.textShadow};">${window.i18n?.format_translate('camera.deviceNotFound') || '找不到展台设备'}</div>
        <div style="font-size: 1.2vw; color: ${style.tertiaryTextColor}; text-shadow: ${style.textShadow};">${message}</div>
    `;
}

function main_hide_no_camera_message() {
    const msgElement = document.getElementById('noCameraMessage');
    if (msgElement) {
        msgElement.style.display = 'none';
    }
}

function main_delete_sidebar_selection() {
    document.querySelectorAll('.sidebar:not(.file-sidebar) .sidebar-image-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelectorAll('.file-sidebar .sidebar-image-item').forEach(item => {
        item.classList.remove('active');
    });
    state.currentImageIndex = -1;
    state.currentFolderPageIndex = -1;
}

async function main_update_camera() {
    state.useFrontCamera = !state.useFrontCamera;
    
    if (state.isCameraOpen) {
        await main_update_camera_state(false);
        await main_update_camera_state(true);
    }
    
    console.log(state.useFrontCamera ? '已切换到前置摄像头' : '已切换到后置摄像头');
}

function main_create_camera_video() {
    const video = dom.cameraVideo;
    if (!video) {
        console.error('找不到 video 元素');
        return;
    }
    
    video.srcObject = state.cameraStream;
    video.play();
    
    video.onloadedmetadata = () => {
        state.isCameraReady = true;
        console.log('摄像头视频就绪:', video.videoWidth, 'x', video.videoHeight);
        main_update_camera_video_style();
        video.style.display = 'block';
    };
}

// 缓存上次 video 样式的值，避免不必要的 DOM 更新
let lastVideoStyleCache = {
    drawW: 0, drawH: 0, offsetX: 0, offsetY: 0,
    rotation: -1, isMirrored: null
};

function main_update_camera_video_style() {
    const video = dom.cameraVideo;
    if (!video) return;
    
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    
    if (!videoW || !videoH) return;
    
    const rotation = state.cameraRotation;
    
    const videoRatio = videoW / videoH;
    
    const screenW = DRAW_CONFIG.screenW;
    const screenH = DRAW_CONFIG.screenH;
    const screenRatio = screenW / screenH;
    
    let drawW, drawH;
    if (videoRatio > screenRatio) {
        drawW = screenW;
        drawH = screenW / videoRatio;
    } else {
        drawH = screenH;
        drawW = screenH * videoRatio;
    }
    
    const canvasW = DRAW_CONFIG.canvasW;
    const canvasH = DRAW_CONFIG.canvasH;
    const offsetX = (canvasW - drawW) / 2;
    const offsetY = (canvasH - drawH) / 2;
    
    const styleChanged = 
        lastVideoStyleCache.drawW !== drawW ||
        lastVideoStyleCache.drawH !== drawH ||
        lastVideoStyleCache.offsetX !== offsetX ||
        lastVideoStyleCache.offsetY !== offsetY ||
        lastVideoStyleCache.rotation !== rotation ||
        lastVideoStyleCache.isMirrored !== state.isMirrored;
    
    if (!styleChanged) return;
    
    lastVideoStyleCache = { drawW, drawH, offsetX, offsetY, rotation, isMirrored: state.isMirrored };
    
    let transforms = [];
    
    if (rotation !== 0) {
        transforms.push(`rotate(${rotation}deg)`);
    }
    
    if (state.isMirrored) {
        transforms.push('scaleX(-1)');
    }
    
    const transformStr = transforms.join(' ');
    
    // Apply transform and display
    video.style.width = `${drawW}px`;
    video.style.height = `${drawH}px`;
    video.style.left = `${offsetX}px`;
    video.style.top = `${offsetY}px`;
    video.style.transform = transformStr;
    video.style.transformOrigin = 'center center';
    video.style.display = 'block';

    // Apply brightness / contrast via CSS filter for preview
    main_apply_camera_filters();
}

function main_apply_camera_filters() {
    const video = dom.cameraVideo;
    const img = dom.imageElement;
    if (!video && !img) return;

    const b = state.camera_brightness ?? 10;
    const c = state.camera_contrast ?? 1.4;
    const g = state.camera_grayscale ?? 0;

    // CSS filter: brightness() expects a multiplier where 1 is normal.
    const brightnessMultiplier = Math.max(0, 1 + b / 100);
    const contrastMultiplier = Math.max(0, c);
    const grayscaleFraction = Math.max(0, Math.min(1, g));

    const filterStr = `brightness(${brightnessMultiplier}) contrast(${contrastMultiplier}) grayscale(${grayscaleFraction})`;
    if (video) video.style.filter = filterStr;
    if (img) img.style.filter = filterStr;
}

function main_start_camera_preview() {
    const video = dom.cameraVideo;
    if (!video) return;
    
    main_update_camera_video_style();
}

function main_create_camera_controls() {
    main_update_photo_button_state();
}

async function main_save_camera_image() {
    const video = document.getElementById('cameraVideo');
    if (!video) {
        console.error('找不到视频元素');
        return;
    }
    
    if (!state.isCameraReady) {
        console.error('摄像头尚未就绪');
        main_show_error_dialog(
            window.i18n?.format_translate('camera.notReady') || '摄像头未就绪',
            window.i18n?.format_translate('camera.notReadyDesc') || '摄像头尚未就绪，请稍后再试'
        );
        return;
    }
    
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    
    if (!videoW || !videoH) {
        console.error('视频尺寸无效:', videoW, videoH);
        main_show_error_dialog(
            window.i18n?.format_translate('camera.notReady') || '摄像头未就绪',
            window.i18n?.format_translate('camera.notReadyDesc') || '摄像头尚未就绪，请稍后再试'
        );
        return;
    }
    
    console.log('捕获摄像头画面:', videoW, 'x', videoH);
    
    // 保存摄像头批注数据
    main_save_current_source_data();
    
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    
    const rotation = state.cameraRotation || 0;
    
    if (rotation % 180 === 0) {
        tempCanvas.width = videoW;
        tempCanvas.height = videoH;
    } else {
        tempCanvas.width = videoH;
        tempCanvas.height = videoW;
    }
    
    tempCtx.save();
    
    tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    
    if (rotation !== 0) {
        tempCtx.rotate(rotation * Math.PI / 180);
    }
    
    if (state.isMirrored) {
        tempCtx.scale(-1, 1);
    }
    
    tempCtx.drawImage(video, -videoW / 2, -videoH / 2);
    
    tempCtx.restore();
    
    let blob = await new Promise((resolve, reject) => {
        tempCanvas.toBlob(b => {
            if (b) resolve(b);
            else reject(new Error('Failed to create blob'));
        }, 'image/png');
    });
    
    if (window.__TAURI__) {
        try {
            const { invoke } = window.__TAURI__.core;
            const dataUrl = await main_format_blob_to_data_url(blob);

            // Try to apply server-side adjustments (brightness/contrast) if available
            let adjustedDataUrl = dataUrl;
            try {
                adjustedDataUrl = await invoke('image_update_adjustments', {
                    imageData: dataUrl,
                    brightness: state.camera_brightness,
                    contrast: state.camera_contrast
                });
            } catch (e) {
                // If the backend command doesn't exist or fails, continue with original dataUrl
                console.warn('image_update_adjustments failed, falling back to original image data', e);
            }

            const result = await invoke('image_save_file', { 
                imageData: adjustedDataUrl,
                prefix: 'photo'
            });
            console.log('图片已保存:', result.path);
        } catch (error) {
            console.error('保存图片失败:', error);
        }
    }
    
    const blobUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.src = blobUrl;
    img.onload = () => {
        const photoName = window.i18n?.format_translate('camera.photoName', { n: state.imageList.length + 1 }) || `拍摄${state.imageList.length + 1}`;
        main_save_image_to_list_no_highlight(img, photoName);
        main_show_sidebar_if_hidden();
        URL.revokeObjectURL(blobUrl);
        console.log('已捕获摄像头画面并保存到图片列表');
    };
    img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        console.error('加载拍摄的图片失败');
    };
}

async function main_format_blob_to_data_url(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function main_show_sidebar_if_hidden() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) {
        main_show_sidebar();
    } else if (sidebar.classList.contains('file-sidebar')) {
        sidebar.remove();
        main_show_sidebar();
    }
}

// === 图像导入功能 ===
// 图片导入、拍照保存、PDF处理

/**
 * 导入图片文件（支持多选，批量导入时用 Rust 并行生成缩略图）
 */
async function main_load_image() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        // 保存当前源数据，确保切换前批注不丢失
        if (currentSourceId) {
            main_save_current_source_data();
        }
        
        if (state.isCameraOpen) {
            await main_update_camera_state(false);
        }
        
        const hasLargeImage = files.some(file => file.size > 2.5 * 1024 * 1024);
        
        // 如果有大图片或者多个文件，显示加载动画
        if (files.length > 1 || hasLargeImage) {
            main_show_loading_overlay(window.i18n?.format_translate('loading.readingImages') || '正在读取图片...');
        }
        
        const imageDataList = [];
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            if (files.length > 1 || file.size > 2.5 * 1024 * 1024) {
                main_update_loading_progress(window.i18n?.format_translate('loading.readingImage', { current: i + 1, total: files.length }) || `正在读取图片 ${i + 1}/${files.length}...`);
            }
            
            const blobUrl = URL.createObjectURL(file);
            
            const imageName = file.name || window.i18n?.format_translate('sidebar.imageAlt', { n: state.imageList.length + imageDataList.length + 1 }) || `图片${state.imageList.length + imageDataList.length + 1}`;
            imageDataList.push({
                data: blobUrl,
                blob: file,
                name: imageName
            });
        }
        
        for (let i = 0; i < imageDataList.length; i++) {
            const imgData = imageDataList[i];
            const isLast = (i === imageDataList.length - 1);
            
            const img = new Image();
            await new Promise((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => {
                    console.error(`加载图片失败: ${imgData.name}`);
                    resolve();
                };
                img.src = imgData.data;
            });
            
            const newImgData = {
                full: imgData.data,
                thumbnail: imgData.data,
                name: imgData.name,
                width: img.width,
                height: img.height,
                strokeHistory: [],
                baseImageURL: null,
                viewState: {
                    scale: 1,
                    canvasX: -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2,
                    canvasY: -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2
                },
                sourceId: main_create_source_id('pic')
            };
            
            state.imageList.push(newImgData);
            state.currentImageIndex = state.imageList.length - 1;
            state.currentImage = img;
            state.currentFolderIndex = -1;
            state.currentFolderPageIndex = -1;
            
            main_delete_draw_canvas();
            state.strokeHistory = [];
            state.baseImageURL = null;
            state.baseImageObj = null;
            history_delete_all();
            state.scale = 1;
            state.canvasX = -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
            state.canvasY = -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;
            main_update_move_bound();
            main_update_canvas_transform();
            main_update_history_button_status();
            
            if (isLast) {
                main_render_image_centered(img);
                main_update_sidebar_content();
                main_update_photo_button_state();
            }
        }
        
        // 如果显示了加载动画，无论文件数量多少，都需要隐藏
        if (files.length > 1 || hasLargeImage) {
            main_hide_loading_overlay();
        }
        
        console.log(`已导入 ${imageDataList.length} 张图片`);
    };
    
    input.click();
}

async function main_save_image_to_list(img, name, isLast = true) {
    const blob = await fetch(img.src).then(r => r.blob());
    const blobUrl = URL.createObjectURL(blob);
    
    const imgData = {
        full: blobUrl,
        thumbnail: blobUrl,
        name: name,
        width: img.width,
        height: img.height,
        sourceId: main_create_source_id('pic')
    };
    
    state.imageList.push(imgData);
    state.currentImageIndex = state.imageList.length - 1;
    state.currentImage = img;
    state.currentFolderIndex = -1;
    state.currentFolderPageIndex = -1;
    
    await main_update_source(imgData.sourceId);
    
    if (isLast) {
        if (state.isCameraOpen) {
            await main_update_camera_state(false);
        }
        img.src = blobUrl;
        main_render_image_centered(img);
        
        main_update_sidebar_content();
        main_update_photo_button_state();
    }
}

async function main_save_image_to_list_no_highlight(img, name) {
    const blob = await fetch(img.src).then(r => r.blob());
    const blobUrl = URL.createObjectURL(blob);
    
    const imgData = {
        full: blobUrl,
        thumbnail: blobUrl,
        name: name,
        width: img.width,
        height: img.height,
        sourceId: main_create_source_id('pic')
    };
    
    state.imageList.push(imgData);
    
    main_update_sidebar_content();
}

window.main_save_image_to_list_no_highlight = main_save_image_to_list_no_highlight;
window.main_update_sidebar_content = main_update_sidebar_content;
window.main_delete_all_drawings = main_delete_all_drawings;

function main_render_image_centered(img) {
    main_delete_image_layer();
    main_hide_no_camera_message();
    
    const screenW = DRAW_CONFIG.screenW;
    const screenH = DRAW_CONFIG.screenH;
    
    const imgRatio = img.width / img.height;
    const screenRatio = screenW / screenH;
    
    let drawW, drawH, drawX, drawY;
    
    if (imgRatio > screenRatio) {
        drawW = screenW;
        drawH = screenW / imgRatio;
    } else {
        drawH = screenH;
        drawW = screenH * imgRatio;
    }
    
    const canvasW = DRAW_CONFIG.canvasW;
    const canvasH = DRAW_CONFIG.canvasH;
    
    drawX = (canvasW - drawW) / 2;
    drawY = (canvasH - drawH) / 2;
    
    dom.imageElement.src = img.src;
    dom.imageElement.style.left = drawX + 'px';
    dom.imageElement.style.top = drawY + 'px';
    dom.imageElement.style.width = drawW + 'px';
    dom.imageElement.style.height = drawH + 'px';
}

function main_delete_image_layer() {
    dom.imageElement.src = '';
    dom.imageElement.style.left = '0';
    dom.imageElement.style.top = '0';
    dom.imageElement.style.width = DRAW_CONFIG.canvasW + 'px';
    dom.imageElement.style.height = DRAW_CONFIG.canvasH + 'px';
}

function main_delete_image_blob_urls() {
    state.imageList.forEach(imgData => {
        if (imgData.full && imgData.full.startsWith('blob:')) {
            URL.revokeObjectURL(imgData.full);
        }
        if (imgData.thumbnail && imgData.thumbnail.startsWith('blob:') && imgData.thumbnail !== imgData.full) {
            URL.revokeObjectURL(imgData.thumbnail);
        }
    });
}

function main_delete_pdf_blob_urls(docNumber) {
    const folder = state.fileList.find(f => f.docNumber === docNumber);
    if (folder) {
        folder.pages.forEach(page => {
            if (page.full && page.full.startsWith('blob:')) {
                URL.revokeObjectURL(page.full);
            }
            if (page.thumbnail && page.thumbnail.startsWith('blob:') && page.thumbnail !== page.full) {
                URL.revokeObjectURL(page.thumbnail);
            }
        });
    }
}

function main_delete_all_pdf_blob_urls() {
    DocLoader.revoke_all_document_blob_urls();
}

window.main_setup_all_events = main_setup_all_events;
window.main_setup_pdf_file_open = main_setup_pdf_file_open;
window.main_init_camera = main_init_camera;
window.main_update_camera_state = main_update_camera_state;
window.main_init_without_camera = main_init_without_camera;
window.main_show_error_dialog = main_show_error_dialog;
window.main_handle_resize = main_handle_resize;
window.main_submit_stroke = main_submit_stroke;
window.main_update_mode = main_update_mode;
window.main_update_canvas_bg_color = main_update_canvas_bg_color;
window.main_calc_rgb_to_hex = main_calc_rgb_to_hex;
window.main_update_color_buttons = main_update_color_buttons;
window.main_delete_image_blob_urls = main_delete_image_blob_urls;
window.main_delete_all_pdf_blob_urls = main_delete_all_pdf_blob_urls;
window.main_setup_minimize_listeners = main_setup_minimize_listeners;
window.main_update_move_bound = main_update_move_bound;
window.main_update_pen_style = main_update_pen_style;
window.main_update_eraser_hint_size = main_update_eraser_hint_size;
window.main_update_canvas_transform = main_update_canvas_transform;
window.main_init_pdfjs = main_init_pdfjs;
window.main_wait_pdfjs = main_wait_pdfjs;
window.main_show_pen_control_panel = main_show_pen_control_panel;
window.main_hide_pen_control_panel = main_hide_pen_control_panel;
window.main_hide_settings_panel = main_hide_settings_panel;
window.main_render_image_centered = main_render_image_centered;
window.main_render_all_strokes = main_render_all_strokes;
window.main_reset_context_state = main_reset_context_state;
window.main_fetch_visible_rect = main_fetch_visible_rect;
window.main_render_strokes_to_context = main_render_strokes_to_context;
window.StrokeQuadTree = StrokeQuadTree;
