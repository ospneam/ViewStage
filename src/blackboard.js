/**
 * ViewStage 小黑板模块
 * 从顶部弹出的独立绘制面板，支持多页绘制
 * 直接复用 main.js 的绘制管道、事件处理与撤销系统
 */

import { BlackboardPageManager } from './blackboard-page.js';
import {
    history_execute_command,
    history_init_manager,
    history_validate_undo,
    history_handle_undo,
    history_handle_state_change,
    DrawCommand,
    ClearCommand,
    history_state
} from './history.js';

class BlackboardManager {
    constructor() {
        this.is_open = false;
        this.canvas = null;
        this.ctx = null;
        this.overlay_canvas = null;
        this.overlay_ctx = null;
        this.batch_draw = null;
        this.page_manager = new BlackboardPageManager();

        this.tile_renderer = null;
        this.bb_wrapper = null;

        this.bb_state = {
            canvas_x: 0,
            canvas_y: 0,
            scale: 1,
            move_bound: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
            is_dragging: false,
            last_transform: { x: null, y: null, scale: null },
            start_drag_x: 0,
            start_drag_y: 0,
            start_scale: 1,
            start_scale_x: 0,
            start_scale_y: 0,
            start_canvas_x: 0,
            start_canvas_y: 0,
            is_scaling: false,
            start_distance_sq: 0,
            cached_inv_scale: 1
        };
        this._cached_move_bound_scale = null;
        this._cached_visible_rect = null;
        this._cached_visible_rect_scale = null;
        this._cached_visible_rect_x = null;
        this._cached_visible_rect_y = null;
        this._animate_timer_id = null;

        this.draw_mode = 'comment';
        this.is_drawing = false;

        this.current_stroke = null;

        this.last_x = 0;
        this.last_y = 0;
        this.cached_draw_type = null;
        this.cached_draw_color = null;
        this.cached_draw_line_width = null;
        this.current_pressure = 0.5;
        this.current_line_width = 5;
        this.last_line_width = 5;

        this.screen_w = 0;
        this.screen_h = 0;
        this.saved_history_state = null;
        this._last_loaded_index = -1;

        this._eraser_hint = null;
        this._eraser_hint_raf_id = null;
        this._eraser_hint_pending_pos = null;
    }

    _fetch_safe_scale() {
        return Math.max(0.001, this.bb_state.scale || 1);
    }


    _update_move_bound() {
        if (this._cached_move_bound_scale === this.bb_state.scale) return;
        this._cached_move_bound_scale = this.bb_state.scale;

        const screen_w = this.screen_w;
        const screen_h = this.screen_h;
        const canvas_w = window.DRAW_CONFIG.canvasW;
        const canvas_h = window.DRAW_CONFIG.canvasH;
        const scaled_w = canvas_w * this.bb_state.scale;
        const scaled_h = canvas_h * this.bb_state.scale;
        const mb = this.bb_state.move_bound;

        if (scaled_w >= screen_w) {
            mb.min_x = -(scaled_w - screen_w);
            mb.max_x = 0;
        } else {
            mb.min_x = (screen_w - scaled_w) / 2;
            mb.max_x = (screen_w - scaled_w) / 2;
        }

        if (scaled_h >= screen_h) {
            mb.min_y = -(scaled_h - screen_h);
            mb.max_y = 0;
        } else {
            mb.min_y = (screen_h - scaled_h) / 2;
            mb.max_y = (screen_h - scaled_h) / 2;
        }
    }

    _update_canvas_position() {
        const eps = 0.001;
        const mb = this.bb_state.move_bound;
        this.bb_state.canvas_x = Math.max(mb.min_x - eps, Math.min(mb.max_x + eps, this.bb_state.canvas_x));
        this.bb_state.canvas_y = Math.max(mb.min_y - eps, Math.min(mb.max_y + eps, this.bb_state.canvas_y));
    }

    _sync_bb_transform() {
        const s = this.bb_state;
        const lt = s.last_transform;
        if (lt.x === s.canvas_x && lt.y === s.canvas_y && lt.scale === s.scale) return;

        lt.x = s.canvas_x;
        lt.y = s.canvas_y;
        lt.scale = s.scale;

        this.bb_wrapper.style.transform = `translate3d(${s.canvas_x}px, ${s.canvas_y}px, 0) scale(${s.scale})`;

        if (this.tile_renderer) {
            this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
        }
    }

    _sync_bb_transform_smooth(target_x, target_y, target_scale, duration = 250) {
        if (this._animate_timer_id !== null) {
            clearTimeout(this._animate_timer_id);
            this._animate_timer_id = null;
        }

        const s = this.bb_state;
        s.canvas_x = target_x;
        s.canvas_y = target_y;
        s.scale = target_scale;

        this._update_move_bound();
        this._update_canvas_position();

        const lt = s.last_transform;
        lt.x = s.canvas_x;
        lt.y = s.canvas_y;
        lt.scale = s.scale;

        this.bb_wrapper.classList.add('smooth-transform');
        this.bb_wrapper.style.transform = `translate3d(${s.canvas_x}px, ${s.canvas_y}px, 0) scale(${s.scale})`;

        if (this.tile_renderer) {
            this.tile_renderer.update_visible_tile_dpr(s.scale);
        }

        this._animate_timer_id = setTimeout(() => {
            this._animate_timer_id = null;
            this.bb_wrapper.classList.remove('smooth-transform');
        }, duration);
    }

    _fetch_visible_rect() {
        const s = this.bb_state;
        if (this._cached_visible_rect_scale === s.scale &&
            this._cached_visible_rect_x === s.canvas_x &&
            this._cached_visible_rect_y === s.canvas_y &&
            this._cached_visible_rect) {
            return this._cached_visible_rect;
        }

        this._cached_visible_rect_scale = s.scale;
        this._cached_visible_rect_x = s.canvas_x;
        this._cached_visible_rect_y = s.canvas_y;

        const scale = s.scale || 1;
        const canvas_w = window.DRAW_CONFIG.canvasW;
        const canvas_h = window.DRAW_CONFIG.canvasH;

        let visible_x = Math.max(0, -s.canvas_x / scale);
        let visible_y = Math.max(0, -s.canvas_y / scale);
        let visible_w = Math.min(canvas_w - visible_x, this.screen_w / scale);
        let visible_h = Math.min(canvas_h - visible_y, this.screen_h / scale);

        const padding = 10;
        visible_x = Math.max(0, visible_x - padding);
        visible_y = Math.max(0, visible_y - padding);
        visible_w = Math.min(canvas_w - visible_x, visible_w + padding * 2);
        visible_h = Math.min(canvas_h - visible_y, visible_h + padding * 2);

        this._cached_visible_rect = {
            x: visible_x,
            y: visible_y,
            width: visible_w,
            height: visible_h
        };
        return this._cached_visible_rect;
    }

    init(container) {
        const dom = window.dom;
        const panel = dom.blackboardPanel;
        if (!panel) return;

        this.screen_w = container.clientWidth;
        this.screen_h = container.clientHeight;

        const canvas_wrap = dom.blackboardCanvasWrap;

        // 创建分块包装器（CSS transform 目标）
        this.bb_wrapper = document.createElement('div');
        this.bb_wrapper.className = 'bb-canvas-wrapper';
        this.bb_wrapper.style.width = window.DRAW_CONFIG.canvasW + 'px';
        this.bb_wrapper.style.height = window.DRAW_CONFIG.canvasH + 'px';
        canvas_wrap.appendChild(this.bb_wrapper);

        // 初始化分块渲染器
        this.tile_renderer = new window.TileRenderer({
            strokeHistoryRef: null,
            getVisibleRect: () => this._fetch_visible_rect(),
            canvasW: window.DRAW_CONFIG.canvasW,
            canvasH: window.DRAW_CONFIG.canvasH,
            skipBaseCache: true
        });
        this.tile_renderer.init_tiles(this.bb_wrapper, 1);

        // 初始化状态位置：居中画布
        const init_x = -(window.DRAW_CONFIG.canvasW - this.screen_w) / 2;
        const init_y = -(window.DRAW_CONFIG.canvasH - this.screen_h) / 2;
        this.bb_state.canvas_x = init_x;
        this.bb_state.canvas_y = init_y;
        this.bb_state.scale = 1;
        this._update_move_bound();
        this._update_canvas_position();
        this._sync_bb_transform();

        // 覆盖层（实时预览，独立于分块包装器之外）
        this.overlay_canvas = document.createElement('canvas');
        this.overlay_canvas.className = 'blackboard-overlay';
        this.overlay_canvas.width = Math.ceil(this.screen_w);
        this.overlay_canvas.height = Math.ceil(this.screen_h);
        this.overlay_canvas.style.width = this.screen_w + 'px';
        this.overlay_canvas.style.height = this.screen_h + 'px';
        canvas_wrap.appendChild(this.overlay_canvas);
        this.overlay_ctx = this.overlay_canvas.getContext('2d');
        this.overlay_ctx.imageSmoothingEnabled = false;

        // 橡皮擦红色范围提示
        this._eraser_hint = document.createElement('div');
        this._eraser_hint.className = 'eraser-hint';
        this._eraser_hint.style.width = window.DRAW_CONFIG.eraserSize + 'px';
        this._eraser_hint.style.height = window.DRAW_CONFIG.eraserSize + 'px';
        canvas_wrap.appendChild(this._eraser_hint);

        // batch_draw 使用覆盖层
        this.batch_draw = new window.RealtimeBatchDrawManager();
        this.batch_draw._overlayCanvas = this.overlay_canvas;
        this.batch_draw._tileRenderer = this.tile_renderer;
        this.batch_draw._overlayCtx = this.overlay_ctx;
        this.batch_draw._overlayTransformScale = 0;
        this.batch_draw._overlayTransformX = 0;
        this.batch_draw._overlayTransformY = 0;
        this.batch_draw._sync_overlay_transform = () => {
            if (!this.batch_draw._overlayCtx) return;
            const s = this.bb_state;
            const dpr = Math.min(window.DRAW_CONFIG.dpr, 1);
            const scale = s.scale || 1;
            const canvas_x = s.canvas_x || 0;
            const canvas_y = s.canvas_y || 0;
            if (this.batch_draw._overlayTransformScale === scale &&
                this.batch_draw._overlayTransformX === canvas_x &&
                this.batch_draw._overlayTransformY === canvas_y) return;
            this.batch_draw._overlayTransformScale = scale;
            this.batch_draw._overlayTransformX = canvas_x;
            this.batch_draw._overlayTransformY = canvas_y;
            this.batch_draw._overlayCtx.setTransform(
                scale * dpr, 0, 0, scale * dpr,
                canvas_x * dpr, canvas_y * dpr
            );
        };

        if (window.DRAW_CONFIG.frameRateMode) {
            this.batch_draw.batch_draw_update_frame_rate(window.DRAW_CONFIG.frameRateMode);
        }

        history_init_manager({
            on_state_change: () => {
                this._update_button_status();
            }
        });

        this.page_manager.init();

        // 不再使用 #blackboardCanvas，隐藏之
        if (dom.blackboardCanvas) {
            dom.blackboardCanvas.style.display = 'none';
        }

        this._setup_events();
        this._setup_keyboard_events();
        this._sync_page_buttons();
        this._update_page_indicator();
    }

    _setup_keyboard_events() {
        document.addEventListener('keydown', (e) => {
            if (!this.is_open) return;

            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });
    }

    _update_button_status() {
        const dom = window.dom;
        if (dom.btnUndo) dom.btnUndo.disabled = !history_validate_undo();
    }

    async open() {
        if (this.is_open) return;

        if (window.main_update_camera_state && window.state.isCameraOpen) {
            this._was_camera_open_before = true;
            await window.main_update_camera_state(false);
        } else {
            this._was_camera_open_before = false;
        }

        if (window.main_submit_stroke) {
            await window.main_submit_stroke();
        }
        if (window.batchDrawManager) {
            window.batchDrawManager.batch_draw_delete_all();
        }
        if (window.main_update_mode) {
            window.main_update_mode('move');
        }

        window.__HISTORY_ISOLATED = true;

        this.saved_history_state = {
            undo_list: [...history_state.undo_list],
            redo_list: [...history_state.redo_list],
            on_state_change: history_state.on_state_change
        };

        history_init_manager({
            on_state_change: () => {
                this._update_button_status();
            }
        });

        this.is_open = true;

        const dom = window.dom;
        dom.blackboardPanel.classList.add('active');

        this._switch_toolbar(true);

        if (window.main_update_mode) {
            await window.main_update_mode('comment');
        }

        this._last_loaded_index = -1;
        await this._load_page_strokes(this.page_manager.current_index);
        this._update_page_indicator();
        this._update_button_status();
    }

    async close() {
        if (!this.is_open) return;
        this.is_open = false;
        window.__HISTORY_ISOLATED = false;

        if (this._animate_timer_id !== null) {
            clearTimeout(this._animate_timer_id);
            this._animate_timer_id = null;
        }
        if (this.bb_wrapper) {
            this.bb_wrapper.classList.remove('smooth-transform');
        }

        await this._submit_stroke();
        this._hide_eraser_hint();

        // 关闭前保存当前页的 undo/redo 和 tile 快照
        const cur_page = this.page_manager.get_current_page();
        if (cur_page) {
            cur_page.undo_list = history_state.undo_list;
            cur_page.redo_list = history_state.redo_list;
            if (this.tile_renderer) this._save_page_tile_snapshots(cur_page);
        }

        if (this.saved_history_state) {
            history_state.undo_list = this.saved_history_state.undo_list;
            history_state.redo_list = this.saved_history_state.redo_list;
            history_state.on_state_change = this.saved_history_state.on_state_change;
            this.saved_history_state = null;
            history_handle_state_change();
        }

        const dom = window.dom;
        dom.blackboardPanel.classList.remove('active');

        this._switch_toolbar(false);

        if (this._was_camera_open_before && window.main_update_camera_state) {
            this._was_camera_open_before = false;
            await window.main_update_camera_state(true);
        }
    }

    _switch_toolbar(bb_active) {
        const dom = window.dom;
        const left_section = document.querySelector('.toolbar-left');
        const right_section = document.querySelector('.toolbar-right');

        // 黑板打开时隐藏侧边栏和拍照/设置按钮，主工具栏笔/橡皮/撤销/清空直接复用
        const hide_center = [dom.btnPhoto, dom.btnSettings];

        if (left_section) {
            left_section.style.display = bb_active ? 'none' : '';
        }
        if (right_section) {
            right_section.style.display = bb_active ? 'none' : '';
        }

        hide_center.forEach(btn => {
            if (btn) btn.style.display = bb_active ? 'none' : '';
        });

        const bb_tool_group = document.getElementById('bbToolGroup');
        if (bb_tool_group) {
            bb_tool_group.style.display = bb_active ? 'inline-flex' : 'none';
        }

        dom.btnBlackboard.classList.toggle('primary-btn', bb_active);

        if (!bb_active) {
            if (window.main_update_mode) {
                window.main_update_mode('move');
            }
        }
    }

    _setup_events() {
        const wrap = window.dom.blackboardCanvasWrap;
        if (!wrap) return;

        if (window.PointerEvent) {
            wrap.addEventListener('pointerdown', (e) => this._handle_pointer_down(e));
            wrap.addEventListener('pointermove', (e) => this._handle_pointer_move(e));
            wrap.addEventListener('pointerup', (e) => this._handle_pointer_up(e));
            wrap.addEventListener('pointerleave', (e) => this._handle_pointer_up(e));
            wrap.addEventListener('pointercancel', (e) => this._handle_pointer_up(e));
        } else {
            wrap.addEventListener('mousedown', (e) => this._handle_mouse_down(e));
            wrap.addEventListener('mousemove', (e) => this._handle_mouse_move(e));
            wrap.addEventListener('mouseup', (e) => this._handle_mouse_up(e));
            wrap.addEventListener('mouseleave', (e) => this._handle_mouse_up(e));
        }

        wrap.addEventListener('wheel', (e) => this._handle_wheel(e), { passive: false });

        wrap.addEventListener('touchstart', (e) => this._handle_touch_start(e), { passive: false });
        wrap.addEventListener('touchmove', (e) => this._handle_touch_move(e), { passive: false });
        wrap.addEventListener('touchend', (e) => this._handle_touch_end(e), { passive: false });
        wrap.addEventListener('touchcancel', (e) => this._handle_touch_end(e), { passive: false });
    }

    _handle_wheel(e) {
        if (!this.is_open) return;
        if (this.is_drawing) return;
        if (this.tile_renderer) this.tile_renderer.cancel_idle_shrink();
        e.preventDefault();

        const s = this.bb_state;
        const max_scale = window.DRAW_CONFIG ? window.DRAW_CONFIG.maxScaleImage : 3;
        const min_scale = window.DRAW_CONFIG ? window.DRAW_CONFIG.minScale : 0.5;
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const new_scale = Math.max(min_scale, Math.min(max_scale, s.scale + delta));

        if (new_scale !== s.scale) {
            const container_rect = window.dom.canvasContainer.getBoundingClientRect();
            const mouse_x = e.clientX - container_rect.left;
            const mouse_y = e.clientY - container_rect.top;

            const old_scale = s.scale;
            const scale_ratio = new_scale / old_scale;
            const target_x = mouse_x - (mouse_x - s.canvas_x) * scale_ratio;
            const target_y = mouse_y - (mouse_y - s.canvas_y) * scale_ratio;

            s.scale = new_scale;
            s.canvas_x = target_x;
            s.canvas_y = target_y;

            this._update_move_bound();
            this._update_canvas_position();
            this._sync_bb_transform_smooth(s.canvas_x, s.canvas_y, s.scale, 100);

            if (this.tile_renderer) this.tile_renderer.mark_all();
        }
    }

    setup_toolbar_events() {
        const dom = window.dom;

        if (dom.bbClose) {
            dom.bbClose.addEventListener('click', () => this.close());
        }

        const prev_btn = document.getElementById('bbPagePrev');
        const next_btn = document.getElementById('bbPageNext');
        const add_btn = document.getElementById('bbPageAdd');

        if (prev_btn) {
            prev_btn.addEventListener('click', () => this.handle_page_nav_prev());
        }
        if (next_btn) {
            next_btn.addEventListener('click', () => this.handle_page_nav_next());
        }
        if (add_btn) {
            add_btn.addEventListener('click', () => this.handle_page_add());
        }
    }

    _get_canvas_rect() {
        return this.bb_wrapper ? this.bb_wrapper.getBoundingClientRect() : null;
    }

    // ====== 指针事件 (PointerEvent) ======

    _handle_pointer_down(e) {
        e.preventDefault();
        this.draw_canvas_rect = this._get_canvas_rect();
        if (!this.draw_canvas_rect) return;

        this.bb_state.cached_inv_scale = 1 / this._fetch_safe_scale();
        this.current_pressure = e.pressure || 0.5;

        if (this.draw_mode === 'move') {
            this.bb_state.is_dragging = true;
            this.bb_state.start_drag_x = e.clientX - this.bb_state.canvas_x;
            this.bb_state.start_drag_y = e.clientY - this.bb_state.canvas_y;
        } else if (this.draw_mode === 'comment') {
            this.is_drawing = true;
            const inv = this.bb_state.cached_inv_scale;
            this.last_x = (e.clientX - this.draw_canvas_rect.left) * inv;
            this.last_y = (e.clientY - this.draw_canvas_rect.top) * inv;
            this._start_stroke('draw');
        } else if (this.draw_mode === 'eraser') {
            this.is_drawing = true;
            const inv = this.bb_state.cached_inv_scale;
            this.last_x = (e.clientX - this.draw_canvas_rect.left) * inv;
            this.last_y = (e.clientY - this.draw_canvas_rect.top) * inv;
            this._start_stroke('erase');
        }
    }

    _handle_pointer_move(e) {
        e.preventDefault();

        this.current_pressure = e.pressure || 0.5;

        if (this.draw_mode === 'eraser') {
            this._update_eraser_hint_position(e.clientX, e.clientY);
        }

        const s = this.bb_state;
        if (s.is_dragging) {
            s.canvas_x = e.clientX - s.start_drag_x;
            s.canvas_y = e.clientY - s.start_drag_y;
            this._update_canvas_position();
            this._sync_bb_transform();
            return;
        }

        if (!this.is_drawing) return;

        const rect = this.draw_canvas_rect;
        if (!rect) return;
        const inv = s.cached_inv_scale;
        const x = (e.clientX - rect.left) * inv;
        const y = (e.clientY - rect.top) * inv;

        const dx = x - this.last_x;
        const dy = y - this.last_y;
        const dist_sq = dx * dx + dy * dy;

        if (dist_sq > 1) {
            this._save_stroke_point(this.last_x, this.last_y, x, y, this.current_pressure);

            this.batch_draw.batch_draw_create_command(
                this.cached_draw_type,
                this.last_x,
                this.last_y,
                x,
                y,
                this.cached_draw_color,
                this.cached_draw_line_width
            );

            this.last_x = x;
            this.last_y = y;
        }
    }

    async _handle_pointer_up(e) {
        if (this.bb_state.is_dragging) {
            this.bb_state.is_dragging = false;
            return;
        }
        if (!this.is_drawing) return;
        this.is_drawing = false;
        await this._submit_stroke();
    }

    // ====== 黑板橡皮擦范围提示 ======

    _show_eraser_hint() {
        if (!this._eraser_hint) return;
        this._eraser_hint.classList.add('active');
    }

    _hide_eraser_hint() {
        if (!this._eraser_hint) return;
        this._eraser_hint.classList.remove('active');
        if (this._eraser_hint_raf_id !== null) {
            cancelAnimationFrame(this._eraser_hint_raf_id);
            this._eraser_hint_raf_id = null;
        }
        this._eraser_hint_pending_pos = null;
    }

    _update_eraser_hint_position(clientX, clientY) {
        if (!this._eraser_hint) return;
        this._eraser_hint_pending_pos = { clientX, clientY };
        if (this._eraser_hint_raf_id !== null) return;

        this._eraser_hint_raf_id = requestAnimationFrame(() => {
            this._eraser_hint_raf_id = null;
            if (!this._eraser_hint_pending_pos) return;

            const { clientX, clientY } = this._eraser_hint_pending_pos;
            this._eraser_hint_pending_pos = null;

            const rect = this.bb_wrapper
                ? this.bb_wrapper.parentElement.getBoundingClientRect()
                : null;
            if (!rect) return;

            const x = clientX - rect.left;
            const y = clientY - rect.top;
            this._eraser_hint.style.left = `${x}px`;
            this._eraser_hint.style.top = `${y}px`;
            this._eraser_hint.style.transform = 'translate(-50%, -50%)';
        });
    }

    // ====== 鼠标事件 (MouseEvent) — 无 PointerEvent 时的回退 ======

    _handle_mouse_down(e) {
        e.preventDefault();
        this.draw_canvas_rect = this._get_canvas_rect();
        if (!this.draw_canvas_rect) return;

        this.bb_state.cached_inv_scale = 1 / this._fetch_safe_scale();

        if (this.draw_mode === 'move') {
            this.bb_state.is_dragging = true;
            this.bb_state.start_drag_x = e.clientX - this.bb_state.canvas_x;
            this.bb_state.start_drag_y = e.clientY - this.bb_state.canvas_y;
        } else if (this.draw_mode === 'comment') {
            this.is_drawing = true;
            const inv = this.bb_state.cached_inv_scale;
            this.last_x = (e.clientX - this.draw_canvas_rect.left) * inv;
            this.last_y = (e.clientY - this.draw_canvas_rect.top) * inv;
            this._start_stroke('draw');
        } else if (this.draw_mode === 'eraser') {
            this.is_drawing = true;
            const inv = this.bb_state.cached_inv_scale;
            this.last_x = (e.clientX - this.draw_canvas_rect.left) * inv;
            this.last_y = (e.clientY - this.draw_canvas_rect.top) * inv;
            this._start_stroke('erase');
        }
    }

    _handle_mouse_move(e) {
        e.preventDefault();

        if (this.draw_mode === 'eraser') {
            this._update_eraser_hint_position(e.clientX, e.clientY);
        }

        const s = this.bb_state;
        if (s.is_dragging) {
            s.canvas_x = e.clientX - s.start_drag_x;
            s.canvas_y = e.clientY - s.start_drag_y;
            this._update_canvas_position();
            const transform = `translate3d(${s.canvas_x}px, ${s.canvas_y}px, 0) scale(${s.scale})`;
            this.bb_wrapper.style.transform = transform;
            s.last_transform.x = s.canvas_x;
            s.last_transform.y = s.canvas_y;
            s.last_transform.scale = s.scale;
            if (this.tile_renderer) {
                this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
            }
            return;
        }

        if (!this.is_drawing) return;

        const rect = this.draw_canvas_rect;
        if (!rect) return;
        const inv = s.cached_inv_scale;
        const x = (e.clientX - rect.left) * inv;
        const y = (e.clientY - rect.top) * inv;

        const dx = x - this.last_x;
        const dy = y - this.last_y;
        const dist_sq = dx * dx + dy * dy;

        if (dist_sq > 1) {
            this._save_stroke_point(this.last_x, this.last_y, x, y, this.current_pressure);

            this.batch_draw.batch_draw_create_command(
                this.cached_draw_type,
                this.last_x,
                this.last_y,
                x,
                y,
                this.cached_draw_color,
                this.cached_draw_line_width
            );

            this.last_x = x;
            this.last_y = y;
        }
    }

    async _handle_mouse_up(e) {
        if (this.bb_state.is_dragging) {
            this.bb_state.is_dragging = false;
            return;
        }
        if (!this.is_drawing) return;
        this.is_drawing = false;
        await this._submit_stroke();
    }

    // ====== 触摸事件 (TouchEvent) ======

    _calc_touch_dist_sq(t1, t2) {
        const dx = t2.clientX - t1.clientX;
        const dy = t2.clientY - t1.clientY;
        return dx * dx + dy * dy;
    }

    async _handle_touch_start(e) {
        e.preventDefault();
        const touches = e.touches;
        this.draw_canvas_rect = this._get_canvas_rect();
        if (!this.draw_canvas_rect) return;

        const s = this.bb_state;

        if (window.PointerEvent) {
            if (touches.length === 1) { return; }
        } else {
            if (touches.length === 1 && this.is_drawing) { return; }
        }

        if (touches.length === 1) {
            const touch = touches[0];
            s.cached_inv_scale = 1 / this._fetch_safe_scale();
            if (this.draw_mode === 'move') {
                s.is_dragging = true;
                s.start_drag_x = touch.clientX - s.canvas_x;
                s.start_drag_y = touch.clientY - s.canvas_y;
            } else if (this.draw_mode === 'comment') {
                this.is_drawing = true;
                const inv = s.cached_inv_scale;
                this.last_x = (touch.clientX - this.draw_canvas_rect.left) * inv;
                this.last_y = (touch.clientY - this.draw_canvas_rect.top) * inv;
                this._start_stroke('draw');
            } else if (this.draw_mode === 'eraser') {
                this.is_drawing = true;
                const inv = s.cached_inv_scale;
                this.last_x = (touch.clientX - this.draw_canvas_rect.left) * inv;
                this.last_y = (touch.clientY - this.draw_canvas_rect.top) * inv;
                this._start_stroke('erase');
            }
        } else if (touches.length === 2) {
            if (this.is_drawing) {
                this.is_drawing = false;
                await this._submit_stroke();
                this.batch_draw.batch_draw_delete_all();
                s.cached_inv_scale = 1 / this._fetch_safe_scale();
            }
            s.is_scaling = true;
            s.is_dragging = false;
            s.start_distance_sq = this._calc_touch_dist_sq(touches[0], touches[1]);
            s.start_scale = s.scale;
            s.start_scale_x = (touches[0].clientX + touches[1].clientX) / 2;
            s.start_scale_y = (touches[0].clientY + touches[1].clientY) / 2;
            s.start_canvas_x = s.canvas_x;
            s.start_canvas_y = s.canvas_y;
        }
    }

    _handle_touch_move(e) {
        e.preventDefault();
        const touches = e.touches;

        if (this.draw_mode === 'eraser' && touches.length > 0) {
            const touch = touches[0];
            this._update_eraser_hint_position(touch.clientX, touch.clientY);
        }

        const s = this.bb_state;

        if (window.PointerEvent && touches.length === 1) { return; }

        if (touches.length === 1 && s.is_dragging) {
            const touch = touches[0];
            s.canvas_x = touch.clientX - s.start_drag_x;
            s.canvas_y = touch.clientY - s.start_drag_y;
            this._update_canvas_position();
            const transform = `translate3d(${s.canvas_x}px, ${s.canvas_y}px, 0) scale(${s.scale})`;
            this.bb_wrapper.style.transform = transform;
            s.last_transform.x = s.canvas_x;
            s.last_transform.y = s.canvas_y;
            s.last_transform.scale = s.scale;
            if (this.tile_renderer) {
                this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
            }
            return;
        }

        if (touches.length === 1 && this.is_drawing) {
            const touch = touches[0];
            const inv = s.cached_inv_scale;
            const x = (touch.clientX - this.draw_canvas_rect.left) * inv;
            const y = (touch.clientY - this.draw_canvas_rect.top) * inv;
            const pressure = (touch.force > 0) ? touch.force : 0.5;
            const dx = x - this.last_x;
            const dy = y - this.last_y;
            const dist_sq = dx * dx + dy * dy;
            if (dist_sq > 1) {
                this._save_stroke_point(this.last_x, this.last_y, x, y, pressure);
                this.batch_draw.batch_draw_create_command(
                    this.cached_draw_type, this.last_x, this.last_y, x, y,
                    this.cached_draw_color, this.cached_draw_line_width
                );
                this.last_x = x;
                this.last_y = y;
            }
            return;
        }

        if (touches.length === 2 && s.is_scaling) {
            const current_dist_sq = this._calc_touch_dist_sq(touches[0], touches[1]);
            const scale_ratio = Math.sqrt(current_dist_sq / s.start_distance_sq);
            let new_scale = s.start_scale * scale_ratio;
            const max_scale = window.DRAW_CONFIG ? window.DRAW_CONFIG.maxScaleImage : 3;
            new_scale = Math.max(window.DRAW_CONFIG ? window.DRAW_CONFIG.minScale : 0.5, Math.min(max_scale, new_scale));

            const center_x = (touches[0].clientX + touches[1].clientX) / 2;
            const center_y = (touches[0].clientY + touches[1].clientY) / 2;

            const final_ratio = new_scale / s.start_scale;
            s.canvas_x = center_x - (s.start_scale_x - s.start_canvas_x) * final_ratio;
            s.canvas_y = center_y - (s.start_scale_y - s.start_canvas_y) * final_ratio;
            s.scale = new_scale;

            this._update_move_bound();
            this._update_canvas_position();

            const transform = `translate3d(${s.canvas_x}px, ${s.canvas_y}px, 0) scale(${s.scale})`;
            this.bb_wrapper.style.transform = transform;
            s.last_transform.x = s.canvas_x;
            s.last_transform.y = s.canvas_y;
            s.last_transform.scale = s.scale;
            if (this.tile_renderer) {
                this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
            }
        }
    }

    async _handle_touch_end(e) {
        e.preventDefault();
        if (window.PointerEvent) { return; }
        const s = this.bb_state;
        if (s.is_scaling && e.touches.length < 2) {
            s.is_scaling = false;
        }
        if (s.is_dragging && e.touches.length === 0) {
            s.is_dragging = false;
        }
        if (e.touches.length === 0) {
            if (this.is_drawing) {
                this.is_drawing = false;
                await this._submit_stroke();
            }
        }
    }

    // ====== 笔画生命周期 — 复制自 main.js ======

    _save_tile_snapshots() {
        const tr = this.tile_renderer;
        if (!tr) return null;
        return tr.tileInfos.map(info => {
            const w = info.canvas.width;
            const h = info.canvas.height;
            return info.ctx.getImageData(0, 0, w, h);
        });
    }

    _restore_tile_snapshots(snapshots) {
        const tr = this.tile_renderer;
        if (!tr || !snapshots) return false;
        for (let i = 0; i < tr.tileInfos.length; i++) {
            const info = tr.tileInfos[i];
            const snap = snapshots[i];
            if (snap && info.canvas && snap.width === info.canvas.width && snap.height === info.canvas.height) {
                info.ctx.putImageData(snap, 0, 0);
            }
        }
        return true;
    }

    _start_stroke(type) {
        const DRAW_CONFIG = window.DRAW_CONFIG;
        const inv_scale = 1 / this._fetch_safe_scale();
        this.current_stroke = {
            type: type,
            points: [],
            color: type === 'draw' ? DRAW_CONFIG.penColor : '#000000',
            lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth * inv_scale : DRAW_CONFIG.eraserSize * inv_scale,
            eraserSize: DRAW_CONFIG.eraserSize * inv_scale,
            eraserSizeRaw: DRAW_CONFIG.eraserSize,
            scale: this.bb_state.scale || 1,
            bounds: {
                minX: Infinity, minY: Infinity,
                maxX: -Infinity, maxY: -Infinity
            },
            variableWidths: null
        };

        this.current_pressure = 0.5;
        this.current_line_width = DRAW_CONFIG.penWidth * inv_scale;
        this.last_line_width = DRAW_CONFIG.penWidth * inv_scale;

        this.cached_draw_type = type;
        this.cached_draw_color = type === 'draw' ? DRAW_CONFIG.penColor : '#000000';
        this.cached_draw_line_width = type === 'draw' ? DRAW_CONFIG.penWidth * inv_scale : DRAW_CONFIG.eraserSize * inv_scale;

        this.batch_draw.batch_draw_init_start();
    }

    _save_stroke_point(from_x, from_y, to_x, to_y, pressure) {
        const stroke = this.current_stroke;
        if (!stroke) return;

        const bounds = stroke.bounds;
        if (from_x < bounds.minX) bounds.minX = from_x;
        if (to_x < bounds.minX) bounds.minX = to_x;
        if (from_y < bounds.minY) bounds.minY = from_y;
        if (to_y < bounds.minY) bounds.minY = to_y;
        if (from_x > bounds.maxX) bounds.maxX = from_x;
        if (to_x > bounds.maxX) bounds.maxX = to_x;
        if (from_y > bounds.maxY) bounds.maxY = from_y;
        if (to_y > bounds.maxY) bounds.maxY = to_y;

        if (stroke.type === 'draw') {
            this.current_pressure = pressure;
            this.last_line_width = this.current_line_width;
            this.current_line_width = stroke.lineWidth * (0.9 + pressure * 0.2);
        }

        stroke.points.push({ fromX: from_x, fromY: from_y, toX: to_x, toY: to_y });
    }

    async _submit_stroke() {
        if (this.current_stroke && this.current_stroke.points.length > 0) {
            this.batch_draw.batch_draw_handle_flush();
            const stored_widths = this.batch_draw._storedWidths;
            if (stored_widths && stored_widths.length > 0 &&
                stored_widths.length === this.current_stroke.points.length) {
                this.current_stroke.storedWidths = [...stored_widths];
            }

            const page = this.page_manager.get_current_page();
            if (page) {
                const stroke_bounds = this.current_stroke && this.current_stroke.bounds
                    ? { ...this.current_stroke.bounds } : null;
                const cmd = new DrawCommand({
                    stroke: this.current_stroke,
                    strokeHistoryRef: page.stroke_history,
                    redrawFn: () => this._render_all_strokes(stroke_bounds)
                });
                await history_execute_command(cmd, false);
                await this._render_all_strokes(stroke_bounds);
            }
        }

        this.current_stroke = null;
        await this.batch_draw.batch_draw_handle_end();
        this.batch_draw.batch_draw_delete_all();
        this._update_button_status();
    }

    // ====== 渲染 — 使用主渲染管线 ======

    async _render_all_strokes(bounds) {
        const page = this.page_manager.get_current_page();
        if (!page) return;

        if (this.tile_renderer) {
            const orig_scale = window.state.scale;
            window.state.scale = this.bb_state.scale;

            window.main_reset_context_state();
            this.tile_renderer._strokeHistoryRef = page.stroke_history;
            this.tile_renderer.mark_strokes_changed();

            if (bounds && isFinite(bounds.minX) && isFinite(bounds.minY) &&
                          isFinite(bounds.maxX) && isFinite(bounds.maxY)) {
                const infos = this.tile_renderer.infos_for_segment(
                    bounds.minX, bounds.minY,
                    bounds.maxX, bounds.maxY
                );
                for (const info of infos) {
                    this.tile_renderer.dirty.add(info.key);
                }
            } else {
                this.tile_renderer.mark_all();
            }

            try {
                this.tile_renderer.rebuild_all();
            } finally {
                window.state.scale = orig_scale;
            }
        }
        page.snapshot_dirty = true;
    }

    _save_page_tile_snapshots(page) {
        const snapshots = this._save_tile_snapshots();
        if (snapshots) {
            page.tile_snapshots = snapshots;
            page.snapshot_dirty = false;
        }
    }

    _restore_page_tile_snapshots(page) {
        return this._restore_tile_snapshots(page.tile_snapshots);
    }

    async _rebuild_from_history(page) {
        if (!this.tile_renderer) return;

        const orig_scale = window.state.scale;
        window.state.scale = this.bb_state.scale;

        window.main_reset_context_state();
        this.tile_renderer._strokeHistoryRef = page.stroke_history;
        this.tile_renderer.mark_strokes_changed();
        this.tile_renderer.mark_all();

        try {
            this.tile_renderer.rebuild_all();
        } finally {
            window.state.scale = orig_scale;
        }
    }

    async _load_page_strokes(index) {
        // 保存当前页的 undo/redo 和历史和 tile 快照
        if (this._last_loaded_index >= 0 && this._last_loaded_index < this.page_manager.pages_list.length) {
            const prev_page = this.page_manager.pages_list[this._last_loaded_index];
            prev_page.undo_list = history_state.undo_list;
            prev_page.redo_list = history_state.redo_list;
            this._save_page_tile_snapshots(prev_page);
        }
        this._last_loaded_index = index;

        const page = this.page_manager.pages_list[index];
        if (!page) return;

        // 恢复目标页的 undo/redo 历史
        history_state.undo_list = page.undo_list || [];
        history_state.redo_list = page.redo_list || [];
        history_state.is_executing = false;

        // 优先从 tile 快照恢复（像素级精确，保留 batch draw 的擦除效果）
        // 没有快照或标记脏时从 stroke_history 重建
        if (page.snapshot_dirty || !page.tile_snapshots) {
            await this._rebuild_from_history(page);
            this._save_page_tile_snapshots(page);
        } else {
            this._restore_page_tile_snapshots(page);
        }
        this._update_button_status();
    }

    // ====== 撤销与清空 — 复用 history.js 管线 ======

    async handle_undo() {
        if (!history_validate_undo()) return;
        if (this.is_drawing) return;

        await history_handle_undo();
        await this._render_all_strokes();
        this._update_button_status();
    }

    async handle_clear() {
        if (this.is_drawing) return;

        const page = this.page_manager.get_current_page();
        if (!page || page.stroke_history.length === 0) return;

        const cmd = new ClearCommand({
            savedStrokeHistory: [...page.stroke_history],
            savedBaseImageURL: null,
            strokeHistoryRef: page.stroke_history,
            baseImageURLRef: {
                get value() { return null; },
                set value(v) {}
            },
            baseImageObjRef: {
                get value() { return null; },
                set value(v) {}
            },
            redrawFn: () => this._render_all_strokes(),
            loadBaseImageFn: () => Promise.resolve()
        });
        await history_execute_command(cmd, false);

        await this._render_all_strokes();
        this._update_button_status();
    }

    // ====== 多页导航 ======

    async handle_page_nav_prev() {
        if (this.is_drawing) return;
        await this._submit_stroke();
        const moved = this.page_manager.nav_prev();
        if (moved) {
            await this._load_page_strokes(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async handle_page_nav_next() {
        if (this.is_drawing) return;
        await this._submit_stroke();
        const moved = this.page_manager.nav_next();
        if (moved) {
            await this._load_page_strokes(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async handle_page_add() {
        if (this.is_drawing) return;
        await this._submit_stroke();
        this.page_manager.add_page();
        const new_idx = this.page_manager.current_index;
        await this._load_page_strokes(new_idx);
        this._update_page_indicator();
        this._sync_page_buttons();
        this._update_button_status();
    }

    _update_page_indicator() {
        const el = document.getElementById('bbPageIndicator');
        if (el) {
            el.textContent = `${this.page_manager.current_index + 1} / ${this.page_manager.get_page_count()}`;
        }
    }

    _sync_page_buttons() {
        const prev_btn = document.getElementById('bbPagePrev');
        const next_btn = document.getElementById('bbPageNext');
        if (prev_btn) prev_btn.disabled = this.page_manager.current_index <= 0;
        if (next_btn) next_btn.disabled = this.page_manager.current_index >= this.page_manager.get_page_count() - 1;

        const add_btn = document.getElementById('bbPageAdd');
        if (add_btn) add_btn.disabled = false;
    }

    resize(screen_w, screen_h) {
        this.screen_w = screen_w;
        this.screen_h = screen_h;

        this.overlay_canvas.width = Math.ceil(screen_w);
        this.overlay_canvas.height = Math.ceil(screen_h);
        this.overlay_canvas.style.width = screen_w + 'px';
        this.overlay_canvas.style.height = screen_h + 'px';
        this.overlay_ctx.imageSmoothingEnabled = false;

        // 重新居中画布
        const init_x = -(window.DRAW_CONFIG.canvasW - screen_w) / 2;
        const init_y = -(window.DRAW_CONFIG.canvasH - screen_h) / 2;
        this.bb_state.canvas_x = init_x;
        this.bb_state.canvas_y = init_y;
        this._cached_move_bound_scale = null;
        this._cached_visible_rect = null;
        this._cached_visible_rect_scale = null;
        this._cached_visible_rect_x = null;
        this._cached_visible_rect_y = null;
        this._update_move_bound();
        this._update_canvas_position();
        this._sync_bb_transform();

        if (this.tile_renderer) {
            const page = this.page_manager.get_current_page();
            const orig_scale = window.state.scale;
            window.state.scale = this.bb_state.scale;

            window.main_reset_context_state();
            if (page) this.tile_renderer._strokeHistoryRef = page.stroke_history;
            this.tile_renderer.mark_all();

            try {
                this.tile_renderer.rebuild_all();
            } finally {
                window.state.scale = orig_scale;
            }
        }
    }

    async destroy() {
        await this._submit_stroke();
        window.__HISTORY_ISOLATED = false;
        this._last_loaded_index = -1;
        this.page_manager.destroy();

        if (this.batch_draw) {
            this.batch_draw.batch_draw_delete_all();
        }

        if (this.tile_renderer) {
            this.tile_renderer.destroy();
            this.tile_renderer = null;
        }

        if (this.bb_wrapper && this.bb_wrapper.parentNode) {
            this.bb_wrapper.parentNode.removeChild(this.bb_wrapper);
            this.bb_wrapper = null;
        }

        if (this.overlay_canvas && this.overlay_canvas.parentNode) {
            this.overlay_canvas.parentNode.removeChild(this.overlay_canvas);
        }

        this.overlay_canvas = null;
        this.overlay_ctx = null;
        this.batch_draw = null;
        this.is_open = false;
    }
}

const blackboardManager = new BlackboardManager();
window.blackboardManager = blackboardManager;
export default blackboardManager;
