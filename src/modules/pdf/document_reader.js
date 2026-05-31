/**
 * 文档阅读器管理器 —— 连续滚动、逐页批注、懒加载 + Canvas 分块渲染
 * 从顶部弹出的独立阅读面板，复用 main.js 的绘制管道与撤销系统
 * 工具栏全部在右侧，支持 IntersectionObserver 懒加载
 */

import { DocumentReaderPageManager } from './document_reader_page.js';
import {
    history_execute_command,
    history_init_manager,
    history_validate_undo,
    history_handle_undo,
    history_handle_state_change,
    DrawCommand,
    ClearCommand,
    history_state
} from '../../history.js';

class DocumentReaderManager {
    constructor() {
        this.is_open = false;
        this.page_manager = new DocumentReaderPageManager();

        this.draw_mode = 'comment';
        this.is_drawing = false;
        this.current_stroke = null;

        this.active_page_index = -1;
        this.saved_history_state = null;
        this.folder_index = -1;

        this.last_x = 0;
        this.last_y = 0;
        this.cached_draw_type = null;
        this.cached_draw_color = null;
        this.cached_draw_line_width = null;
        this.current_pressure = 0.5;
        this.current_line_width = 5;
        this.last_line_width = 5;

        this._scroll_container = null;
        this._dr_tool_group = null;
        this._eraser_hint = null;
        this._eraser_hint_raf_id = null;
        this._eraser_hint_pending_pos = null;
        this._was_camera_open_before = false;
        this._last_loaded_index = -1;
        this._page_visible_timeout_id = null;
        this._resize_raf_id = null;
        this._gpu_cleanup_delay_ms = 1500;
        this._tile_keep_distance = 1;
        this._image_keep_distance = 2;
        this._blob_keep_distance = 5;
        this._sidebar_virtual_threshold = 160;
        this._sidebar_item_height = 128;
        this._sidebar_overscan = 8;

        // 分块渲染相关
        this.batch_draw = null;
        this.draw_canvas_rect = null;
        this._window_resize_handler = null;

        // 缩放状态（Blackboard 风格：CSS transform translate3d + scale）
        this.dr_scale = 1;
        this.dr_canvas_x = 0;
        this.dr_canvas_y = 0;
        this.dr_move_bound = { min_x: 0, max_x: 0, min_y: 0, max_y: 0 };
        this.dr_is_dragging = false;
        this.dr_is_scaling = false;
        this.dr_start_drag_x = 0;
        this.dr_start_drag_y = 0;
        this.dr_start_scale = 1;
        this.dr_start_scale_x = 0;
        this.dr_start_scale_y = 0;
        this.dr_start_canvas_x = 0;
        this.dr_start_canvas_y = 0;
        this.dr_start_distance_sq = 0;
        this.dr_min_scale = 0.25;
        this.dr_max_scale = 4;
        this.dr_cached_inv_scale = 1;
        this._zoom_wrapper = null;
    }

    // ====== 初始化 ======

    init(container) {
        this._scroll_container = document.getElementById('docReaderScrollContainer');
        this._dr_tool_group = document.getElementById('drToolGroup');
        this._eraser_hint = document.getElementById('eraserHint');

        this._setup_toolbar_events();
        this._setup_events();
        this._setup_keyboard_events();
    }

    // ====== 面板管理 ======

    async open(folder_index, page_index = 0) {
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

        // 历史隔离
        window.__HISTORY_ISOLATED = true;
        this.saved_history_state = {
            undo_list: [...history_state.undo_list],
            redo_list: [...history_state.redo_list],
            on_state_change: history_state.on_state_change
        };
        history_init_manager({
            on_state_change: () => this._update_button_status()
        });

        this.folder_index = folder_index;
        const folder = window.state.fileList[folder_index];
        if (!folder || !folder.pages || folder.pages.length === 0) return;

        this.page_manager.init_from_folder_pages(folder.pages);
        this.active_page_index = page_index;
        this.page_manager.current_index = page_index;

        this._build_page_dom();

        // 默认启用移动模式，允许立即拖拽平移（不设为批注模式）
        this._set_draw_mode('move');

        // 从缓存恢复批注（必须在 tiles 初始化前，_scroll_to_page 触发 _check_page_visibility 会懒 init tiles）
        await this._load_annotations_from_cache();

        // 窗口 resize 时同步页面布局、批注坐标与 overlay canvas 尺寸
        this._window_resize_handler = () => {
            this._schedule_reader_resize();
            if (!this.batch_draw?._overlayCanvas) return;
            const overlay = this.batch_draw._overlayCanvas;
            if (overlay.width !== window.innerWidth || overlay.height !== window.innerHeight) {
                overlay.width = window.innerWidth;
                overlay.height = window.innerHeight;
                overlay.style.width = window.innerWidth + 'px';
                overlay.style.height = window.innerHeight + 'px';
            }
        };
        window.addEventListener('resize', this._window_resize_handler);

        // 滚动到初始页面（会触发 _dr_apply_scale → _check_page_visibility）
        await this._scroll_to_page(page_index);

        this.is_open = true;

        const panel = document.getElementById('documentReaderPanel');
        if (panel) panel.classList.add('active');

        this._switch_toolbar(true);
        this._update_page_indicator();
        this._sync_page_buttons();
        this._update_button_status();
    }

    async close() {
        if (!this.is_open) return;

        // 清理 resize handler
        if (this._window_resize_handler) {
            window.removeEventListener('resize', this._window_resize_handler);
            this._window_resize_handler = null;
        }
        if (this._resize_raf_id !== null) {
            cancelAnimationFrame(this._resize_raf_id);
            this._resize_raf_id = null;
        }

        this.is_open = false;
        window.__HISTORY_ISOLATED = false;

        await this._submit_stroke();
        this._hide_eraser_hint();

        // 保存当前页的 undo/redo
        const cur_page = this.page_manager.get_current_page();
        if (cur_page) {
            cur_page.undo_list = history_state.undo_list;
            cur_page.redo_list = history_state.redo_list;
        }

        // 保存所有页的批注到缓存
        await this._save_annotations_to_cache();

        // 恢复主画面历史
        if (this.saved_history_state) {
            history_state.undo_list = this.saved_history_state.undo_list;
            history_state.redo_list = this.saved_history_state.redo_list;
            history_state.on_state_change = this.saved_history_state.on_state_change;
            this.saved_history_state = null;
            history_handle_state_change();
        }

        this._destroy_lazy_loading();
        this._destroy_all_tiles();
        this.page_manager.destroy();

        // 清理 batch_draw 和 overlay_canvas
        if (this.batch_draw) {
            // 显式清空 overlay canvas 释放 GPU 纹理
            if (this.batch_draw._overlayCanvas) {
                const ctx = this.batch_draw._overlayCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, this.batch_draw._overlayCanvas.width, this.batch_draw._overlayCanvas.height);
                }
                this.batch_draw._overlayCanvas.width = 0;
                this.batch_draw._overlayCanvas.height = 0;
                if (this.batch_draw._overlayCanvas.parentNode) {
                    this.batch_draw._overlayCanvas.parentNode.removeChild(this.batch_draw._overlayCanvas);
                }
            }
            this.batch_draw.batch_draw_delete_all();
            this.batch_draw = null;
        }

        // 重置缩放状态
        this.dr_scale = 1;
        this.dr_canvas_x = 0;
        this.dr_canvas_y = 0;
        this.dr_is_scaling = false;
        this.dr_is_dragging = false;
        this.dr_move_bound = { min_x: 0, max_x: 0, min_y: 0, max_y: 0 };
        this.dr_cached_inv_scale = 1;
        this._zoom_wrapper = null;

        const panel = document.getElementById('documentReaderPanel');
        if (panel) panel.classList.remove('active');

        // 清理页面侧边栏
        const page_sidebar = document.getElementById('drPageSidebar');
        if (page_sidebar) page_sidebar.remove();

        if (this._scroll_container) {
            this._scroll_container.innerHTML = '';
        }

        this._switch_toolbar(false);

        if (this._was_camera_open_before && window.main_update_camera_state) {
            this._was_camera_open_before = false;
            await window.main_update_camera_state(true);
        }
    }

    /** 将所有页的批注序列化写入缓存文件 */
    async _save_annotations_to_cache() {
        if (this.folder_index < 0) return;
        const cache_dir = window.cacheDir;
        if (!cache_dir) return;
        const cache_id = this._get_annotations_cache_id();
        if (!cache_id) return;

        const pages = this.page_manager.pages_list;
        const folder = window.state.fileList[this.folder_index];
        const cache_data = {
            version: 2,
            folder_index: this.folder_index,
            file_md5: folder?.fileMd5 || null,
            pages: pages.map(p => ({
                stroke_history: p.stroke_history,
                undo_list: p.undo_list,
                redo_list: p.redo_list
            }))
        };

        try {
            const { writeTextFile } = window.__TAURI__.fs;
            const file_path = `${cache_dir}/doc_annotations_${cache_id}.json`;
            await writeTextFile(file_path, JSON.stringify(cache_data));
        } catch (err) {
            console.error('[document_reader] 保存批注缓存失败:', err);
        }
    }

    /** 从缓存文件恢复所有页的批注 */
    async _load_annotations_from_cache() {
        if (this.folder_index < 0) return;
        const cache_dir = window.cacheDir;
        if (!cache_dir) return;
        const cache_id = this._get_annotations_cache_id();
        if (!cache_id) return;

        try {
            const { readTextFile } = window.__TAURI__.fs;
            const file_path = `${cache_dir}/doc_annotations_${cache_id}.json`;
            const json_str = await readTextFile(file_path);
            const cache_data = JSON.parse(json_str);
            if (!cache_data || !cache_data.pages) return;

            const pages = this.page_manager.pages_list;
            const len = Math.min(cache_data.pages.length, pages.length);
            for (let i = 0; i < len; i++) {
                const src = cache_data.pages[i];
                const dst = pages[i];
                if (src.stroke_history) dst.stroke_history = src.stroke_history;
                if (src.undo_list) dst.undo_list = src.undo_list;
                if (src.redo_list) dst.redo_list = src.redo_list;
            }
        } catch (err) {
            // 文件不存在或解析失败 → 无缓存，忽略
            if (err && err.code !== 'ENOENT' && !err.message?.includes('No such file')) {
                console.error('[document_reader] 恢复批注缓存失败:', err);
            }
        }
    }

    _get_annotations_cache_id() {
        const folder = window.state?.fileList?.[this.folder_index];
        if (folder?.fileMd5) {
            return `md5_${folder.fileMd5}`;
        }
        return this.folder_index >= 0 ? `index_${this.folder_index}` : null;
    }

    async delete_annotation_cache_files() {
        if (!window.__TAURI__?.core?.invoke) return;
        try {
            await window.__TAURI__.core.invoke('cache_delete_doc_annotations');
        } catch (error) {
            console.error('[document_reader] 删除批注缓存失败:', error);
        }
    }

    // ====== DOM 构建 ======

    _build_page_dom() {
        if (!this._scroll_container) return;
        this._scroll_container.innerHTML = '';

        // 缩放包装器（transform translate3d + scale 统一缩放）
        const wrapper = document.createElement('div');
        wrapper.className = 'dr-zoom-wrapper';
        this._zoom_wrapper = wrapper;
        this._scroll_container.appendChild(wrapper);

        // 基准页面宽度（容器可见宽度减 padding），后续 resize 会动态重算
        const base_w = this._get_page_base_width();

        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            const page_data = this.page_manager.pages_list[i];
            const page_div = document.createElement('div');
            page_div.className = 'doc-reader-page';
            page_div.dataset.page = i;
            page_data.page_element = page_div;

            // 页面基准尺寸（wrapper transform 负责缩放）
            this._set_page_box_size(page_data, base_w);
            page_div.style.touchAction = 'none';

            if (page_data.loaded || page_data.image_url) {
                // 图片层（懒加载：data-src 替代 src）
                const img = document.createElement('img');
                img.alt = `第 ${page_data.page_num} 页`;
                img.loading = 'lazy';
                img.decoding = 'async';
                if (page_data.image_url) {
                    img.dataset.src = page_data.image_url;
                }
                page_div.appendChild(img);

                // Tile 容器（wrapper transform 统一缩放，tiles 不再单独 scale）
                const tiles_container = document.createElement('div');
                tiles_container.className = 'doc-reader-page-tiles';
                page_div.appendChild(tiles_container);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'doc-reader-page-placeholder doc-reader-page-virtual-placeholder';
                placeholder.textContent = `第 ${page_data.page_num} 页`;
                page_div.appendChild(placeholder);
                page_div.classList.add('virtualized');
                page_data.is_virtualized = true;
            }

            // overlay canvas 延迟到 _on_page_visible 创建（节省大量 getContext 开销）
            wrapper.appendChild(page_div);
            page_data._visible_init_timeout = null;
        }

        // 重置缩放状态，直接设置初始 transform（不触发 layout-heavy _dr_apply_scale）
        this.dr_scale = 1;
        this.dr_canvas_x = 0;
        this.dr_canvas_y = 0;
        this.dr_cached_inv_scale = 1;
        this._dr_sync_transform();
    }

    // ====== 懒加载（手动可见性检查，transform 替代 IntersectionObserver） ======

    _destroy_lazy_loading() {
        // 清理延迟销毁定时器
        if (this._page_visible_timeout_id !== null) {
            clearTimeout(this._page_visible_timeout_id);
            this._page_visible_timeout_id = null;
        }
    }

    /** 手动检查每页是否在视口中（用 offsetTop 数学推算，避免 getBoundingClientRect 布局抖动） */
    _check_page_visibility() {
        if (!this._scroll_container || !this.page_manager || !this._zoom_wrapper) return;
        const container_rect = this._scroll_container.getBoundingClientRect();
        const container_top = container_rect.top;
        const container_bottom = container_rect.bottom;

        // wrapper.getBoundingClientRect 已包含 transform（含 cy 平移），所以 page 的视觉位置 = wrapper_top + offsetTop * scale
        const wrapper_top = this._zoom_wrapper.getBoundingClientRect().top;
        const s = this.dr_scale;

        let nearest_page = -1;
        let nearest_dist = Infinity;
        const viewport_center = (container_top + container_bottom) / 2;

        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            const page_data = this.page_manager.pages_list[i];
            if (!page_data.page_element) continue;

            const page_el = page_data.page_element;
            const page_top = page_el.offsetTop;
            const page_bottom = page_top + page_el.offsetHeight;

            // visual_y = wrapper_top + offsetTop * scale（canvas_y 已包含在 wrapper_top 中）
            const visual_top = wrapper_top + page_top * s;
            const visual_bottom = wrapper_top + page_bottom * s;

            const is_intersecting = visual_bottom > container_top && visual_top < container_bottom;

            if (is_intersecting) {
                this._on_page_visible(i);
            } else {
                this._on_page_hidden(i);
            }

            // 找距离视口中心最近的页（无论是否可见，用于翻页同步）
            const visual_center = (visual_top + visual_bottom) / 2;
            const dist = Math.abs(visual_center - viewport_center);
            if (dist < nearest_dist) {
                nearest_dist = dist;
                nearest_page = i;
            }
        }

        // 同步翻页器到距离视口中心最近的页
        if (nearest_page >= 0 && nearest_page !== this.active_page_index) {
            this.active_page_index = nearest_page;
            this.page_manager.current_index = nearest_page;
            this._update_page_indicator();
            this._sync_page_buttons();

            // 切换 batch_draw 的 tileRenderer 引用到新页
            if (this.batch_draw && nearest_page < this.page_manager.pages_list.length) {
                const pd = this.page_manager.pages_list[nearest_page];
                if (pd.tile_renderer) {
                    this.batch_draw._tileRenderer = pd.tile_renderer;
                }
            }
        }
    }

    _on_page_visible(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;
        page_data.is_visible = true;
        this._ensure_page_runtime_dom(page_index);

        // 取消待销毁的 tiles（页面快速滚回可见区域时避免闪烁）
        if (this._page_visible_timeout_id !== null) {
            clearTimeout(this._page_visible_timeout_id);
            this._page_visible_timeout_id = null;
        }

        // 懒加载图片
        const img = page_data.page_element?.querySelector('img');
        const has_img_src = img?.hasAttribute('src') && img.getAttribute('src');
        if (img && !has_img_src && img.dataset.src) {
            img.src = img.dataset.src;
            img.onload = () => {
                // 图片加载后设置页面尺寸并初始化 tiles
                page_data.page_width = img.naturalWidth || img.clientWidth;
                page_data.page_height = img.naturalHeight || img.clientHeight;
                this._refresh_page_aspect(page_data);
                this._resize_page_layout(page_index, this._get_page_base_width());
                this._init_page_tiles(page_index);
                this._update_overlay_size(page_index);
            };
        } else if (img && has_img_src && !page_data.is_tiles_initialized) {
            // 已有图片但 tiles 未初始化 → 延迟初始化（防快速滚动）
            if (page_data._visible_init_timeout !== null) {
                clearTimeout(page_data._visible_init_timeout);
            }
            page_data._visible_init_timeout = setTimeout(() => {
                page_data._visible_init_timeout = null;
                if (!page_data.is_visible) return; // 已隐藏，跳过
                page_data.page_width = img.naturalWidth || img.clientWidth;
                page_data.page_height = img.naturalHeight || img.clientHeight;
                this._refresh_page_aspect(page_data);
                this._resize_page_layout(page_index, this._get_page_base_width());
                this._init_page_tiles(page_index);
                this._update_overlay_size(page_index);
            }, 100);
        }

        // PDF 懒加载：如果页面未加载，则加载
        if (!page_data.loaded && this.folder_index >= 0) {
            this._load_pdf_page(page_index);
        }
    }

    _on_page_hidden(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;
        page_data.is_visible = false;

        // 取消待处理的初始化定时器（快速滚动跳过该页）
        if (page_data._visible_init_timeout !== null) {
            clearTimeout(page_data._visible_init_timeout);
            page_data._visible_init_timeout = null;
        }

        // 离开视口后延迟释放页面 GPU 资源（防抖动 + requestIdleCallback 降 GPU 峰值）
        if (this._page_visible_timeout_id !== null) {
            clearTimeout(this._page_visible_timeout_id);
        }
        this._page_visible_timeout_id = setTimeout(() => {
            this._page_visible_timeout_id = null;
            const destroy_fn = () => this._cleanup_hidden_page_gpu();
            if (window.requestIdleCallback) {
                window.requestIdleCallback(destroy_fn, { timeout: 2000 });
            } else {
                destroy_fn();
            }
        }, this._gpu_cleanup_delay_ms);
    }

    // ====== PDF 懒加载 ======

    async _load_pdf_page(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.loaded) return;
        if (page_data.loading_promise) return page_data.loading_promise;

        const folder = window.state.fileList[this.folder_index];
        if (!folder || !folder.pdfDoc) return;

        page_data.loading_promise = (async () => {
            const page_num = page_data.page_num;
            const doc_number = folder.docNumber ?? null;

            // 调用 document_loader 渲染页面
            const { render_pdf_page } = await import('./document_loader.js');
            const result = await render_pdf_page(folder.pdfDoc, page_num, doc_number);

            // 更新页面数据
            page_data.image_url = result.full;
            page_data.thumbnail_url = result.full;
            page_data.loaded = true;

            // 移除占位符
            const placeholder = page_data.page_element?.querySelector('.doc-reader-page-placeholder:not(.doc-reader-page-virtual-placeholder)');
            if (placeholder) {
                placeholder.remove();
            }

            // 更新图片
            const img = page_data.page_element?.querySelector('img');
            if (img) {
                img.dataset.src = result.full;
                if (page_data.is_visible) {
                    img.src = result.full;
                    img.onload = () => {
                        page_data.page_width = img.naturalWidth || img.clientWidth;
                        page_data.page_height = img.naturalHeight || img.clientHeight;
                        this._refresh_page_aspect(page_data);
                        this._resize_page_layout(page_index, this._get_page_base_width());
                        this._init_page_tiles(page_index);
                        this._update_overlay_size(page_index);
                    };
                }
            }

            // 更新侧边栏中的页面数据
            if (folder.pages[page_index]) {
                if (folder.pages[page_index].thumbnail &&
                    folder.pages[page_index].thumbnail !== folder.pages[page_index].full &&
                    folder.pages[page_index].thumbnail.startsWith('blob:')) {
                    URL.revokeObjectURL(folder.pages[page_index].thumbnail);
                }
                folder.pages[page_index].full = result.full;
                folder.pages[page_index].thumbnail = result.full;
                folder.pages[page_index].loaded = true;
                folder.pages[page_index].width = result.width;
                folder.pages[page_index].height = result.height;
            }

            this._update_page_sidebar_thumbnail(page_index, result.full);
        })();

        try {
            return await page_data.loading_promise;
        } catch (error) {
            console.error(`加载 PDF 页面 ${page_index + 1} 失败:`, error);
        } finally {
            page_data.loading_promise = null;
        }
    }

    // ====== TileRenderer 集成 ======

    _is_page_near_active(page_index, distance) {
        if (this.active_page_index < 0) return false;
        return Math.abs(page_index - this.active_page_index) <= distance;
    }

    _cleanup_hidden_page_gpu() {
        if (!this.page_manager?.pages_list) return;

        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            const pd = this.page_manager.pages_list[i];
            if (!pd || pd.is_visible || i === this.active_page_index) continue;

            if (!this._is_page_near_active(i, this._tile_keep_distance) && pd.is_tiles_initialized) {
                this._destroy_page_tiles(i);
            }

            if (!this._is_page_near_active(i, this._image_keep_distance)) {
                this._virtualize_page(i);
            }

            if (!this._is_page_near_active(i, this._blob_keep_distance)) {
                this._release_page_blob_url(i);
            }
        }
    }

    _ensure_page_runtime_dom(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        const page_el = page_data?.page_element;
        if (!page_el) return;

        page_el.classList.remove('virtualized');
        page_data.is_virtualized = false;

        page_el.querySelectorAll('.doc-reader-page-virtual-placeholder').forEach(el => el.remove());

        let img = page_el.querySelector('img');
        if (!img) {
            img = document.createElement('img');
            img.alt = `第 ${page_data.page_num} 页`;
            img.loading = 'lazy';
            img.decoding = 'async';
            page_el.prepend(img);
        }
        if (page_data.image_url) {
            img.dataset.src = page_data.image_url;
        }

        const existing_placeholder = page_el.querySelector('.doc-reader-page-placeholder:not(.doc-reader-page-virtual-placeholder)');
        if (!page_data.loaded && !existing_placeholder) {
            const placeholder = document.createElement('div');
            placeholder.className = 'doc-reader-page-placeholder';
            placeholder.textContent = `第 ${page_data.page_num} 页`;
            page_el.appendChild(placeholder);
        } else if (page_data.loaded && existing_placeholder) {
            existing_placeholder.remove();
        }

        if (!page_el.querySelector('.doc-reader-page-tiles')) {
            const tiles_container = document.createElement('div');
            tiles_container.className = 'doc-reader-page-tiles';
            page_el.appendChild(tiles_container);
        }

        this._set_page_box_size(page_data, page_data.coord_width || this._get_page_base_width());
    }

    _virtualize_page(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        const page_el = page_data?.page_element;
        if (!page_el || page_data.is_virtualized || page_data.is_visible) return;

        this._destroy_page_tiles(page_index);
        this._release_page_image(page_index);

        const placeholder = document.createElement('div');
        placeholder.className = 'doc-reader-page-placeholder doc-reader-page-virtual-placeholder';
        placeholder.textContent = `第 ${page_data.page_num} 页`;

        page_el.replaceChildren(placeholder);
        page_el.classList.add('virtualized');
        page_data.is_virtualized = true;
    }

    _release_page_image(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        const img = page_data?.page_element?.querySelector('img');
        if (!img || !img.hasAttribute('src')) return;

        img.onload = null;
        img.removeAttribute('src');
        // blob URL 保留在 dataset.src，页面再次可见时复用；移除 src 后浏览器可回收解码纹理。
    }

    _release_page_blob_url(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.is_visible || page_index === this.active_page_index) return;

        const image_url = page_data.image_url;
        const thumbnail_url = page_data.thumbnail_url;
        if (!image_url && !thumbnail_url) return;

        const revoke_urls = new Set();
        if (image_url?.startsWith('blob:')) revoke_urls.add(image_url);
        if (thumbnail_url?.startsWith('blob:')) revoke_urls.add(thumbnail_url);
        if (revoke_urls.size === 0) return;

        const img = page_data.page_element?.querySelector('img');
        if (img) {
            img.onload = null;
            img.removeAttribute('src');
            img.removeAttribute('data-src');
        }

        const sidebar_img = document.querySelector(`#drPageSidebar .dr-page-sidebar-thumb[data-page="${page_index}"]`);
        if (sidebar_img) {
            sidebar_img.removeAttribute('src');
            sidebar_img.classList.add('is-loading');
            sidebar_img.closest('.dr-page-sidebar-item')?.classList.add('loading');
        }

        revoke_urls.forEach(url => URL.revokeObjectURL(url));

        page_data.image_url = null;
        page_data.thumbnail_url = null;
        page_data.loaded = false;

        const folder_page = window.state?.fileList?.[this.folder_index]?.pages?.[page_index];
        if (folder_page) {
            folder_page.full = null;
            folder_page.thumbnail = null;
            folder_page.loaded = false;
        }

        const has_placeholder = page_data.page_element?.querySelector('.doc-reader-page-placeholder');
        if (page_data.page_element && !has_placeholder) {
            const placeholder = document.createElement('div');
            placeholder.className = 'doc-reader-page-placeholder';
            placeholder.textContent = `第 ${page_data.page_num} 页`;
            page_data.page_element.appendChild(placeholder);
        }
    }

    _get_page_base_width() {
        if (!this._scroll_container) return 800;
        return Math.max(200, this._scroll_container.clientWidth - 32);
    }

    _refresh_page_aspect(page_data) {
        if (!page_data?.page_width || !page_data.page_height) return;
        page_data.aspect_ratio = page_data.page_width / page_data.page_height;
    }

    _get_page_aspect(page_data) {
        return page_data?.aspect_ratio || 0.70710678;
    }

    _set_page_box_size(page_data, width) {
        if (!page_data?.page_element) return;
        const safe_w = Math.max(200, Math.round(width));
        const aspect = this._get_page_aspect(page_data);
        const safe_h = Math.max(200, Math.round(safe_w / aspect));

        page_data.page_element.style.width = safe_w + 'px';
        page_data.page_element.style.height = safe_h + 'px';

        const img = page_data.page_element.querySelector('img');
        if (img) {
            img.style.width = '100%';
            img.style.height = '100%';
        }

        const tiles_container = page_data.page_element.querySelector('.doc-reader-page-tiles');
        if (tiles_container) {
            tiles_container.style.width = safe_w + 'px';
            tiles_container.style.height = safe_h + 'px';
        }
    }

    _schedule_reader_resize() {
        if (!this.is_open || this._resize_raf_id !== null) return;
        this._resize_raf_id = requestAnimationFrame(() => {
            this._resize_raf_id = null;
            this._handle_reader_resize();
        });
    }

    _handle_reader_resize() {
        if (!this.is_open || !this._zoom_wrapper || !this._scroll_container) return;

        const new_w = this._get_page_base_width();
        const active = this.page_manager.pages_list[this.active_page_index]
            || this.page_manager.get_current_page();
        const active_offset = active?.page_element
            ? active.page_element.offsetTop * this.dr_scale + this.dr_canvas_y
            : null;

        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            this._resize_page_layout(i, new_w);
        }

        if (active?.page_element && active_offset !== null) {
            this.dr_canvas_y = active_offset - active.page_element.offsetTop * this.dr_scale;
        }

        this._dr_apply_scale();
    }

    _resize_page_layout(page_index, new_w) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.page_element) return;

        const old_w = page_data.coord_width || Math.round(parseFloat(page_data.page_element.style.width)) || 0;
        const old_h = page_data.coord_height || Math.round(parseFloat(page_data.page_element.style.height)) || 0;
        this._set_page_box_size(page_data, new_w);
        const new_h = Math.round(parseFloat(page_data.page_element.style.height)) || 0;

        if (old_w > 0 && old_h > 0 && (Math.abs(old_w - new_w) >= 1 || Math.abs(old_h - new_h) >= 1)) {
            this._scale_page_annotations(page_data, new_w / old_w, old_h > 0 ? new_h / old_h : new_w / old_w);
        }

        page_data.coord_width = new_w;
        page_data.coord_height = new_h;

        if (page_data.is_tiles_initialized) {
            this._destroy_page_tiles(page_index);
            this._init_page_tiles(page_index);
        }
        this._update_overlay_size(page_index);
    }

    _scale_page_annotations(page_data, sx, sy) {
        if (!page_data || sx === 1 && sy === 1) return;
        const seen = new WeakSet();
        const scale_stroke = (stroke) => {
            if (!stroke || seen.has(stroke)) return;
            seen.add(stroke);
            const sw = (sx + sy) / 2;
            if (Array.isArray(stroke.points)) {
                for (const p of stroke.points) {
                    if (typeof p.fromX === 'number') p.fromX *= sx;
                    if (typeof p.toX === 'number') p.toX *= sx;
                    if (typeof p.fromY === 'number') p.fromY *= sy;
                    if (typeof p.toY === 'number') p.toY *= sy;
                }
            }
            if (stroke.bounds) {
                if (typeof stroke.bounds.minX === 'number') stroke.bounds.minX *= sx;
                if (typeof stroke.bounds.maxX === 'number') stroke.bounds.maxX *= sx;
                if (typeof stroke.bounds.minY === 'number') stroke.bounds.minY *= sy;
                if (typeof stroke.bounds.maxY === 'number') stroke.bounds.maxY *= sy;
            }
            if (typeof stroke.lineWidth === 'number') stroke.lineWidth *= sw;
            if (typeof stroke.eraserSize === 'number') stroke.eraserSize *= sw;
            if (typeof stroke.eraserSizeRaw === 'number') stroke.eraserSizeRaw *= sw;
            if (Array.isArray(stroke.storedWidths)) {
                stroke.storedWidths = stroke.storedWidths.map(w => typeof w === 'number' ? w * sw : w);
            }
        };
        const scale_command = (cmd) => {
            if (!cmd) return;
            scale_stroke(cmd.stroke);
            if (Array.isArray(cmd.savedStrokeHistory)) cmd.savedStrokeHistory.forEach(scale_stroke);
            if (Array.isArray(cmd.beforeStrokes)) cmd.beforeStrokes.forEach(scale_stroke);
            if (Array.isArray(cmd.afterStrokes)) cmd.afterStrokes.forEach(scale_stroke);
        };

        page_data.stroke_history.forEach(scale_stroke);
        page_data.undo_list.forEach(scale_command);
        page_data.redo_list.forEach(scale_command);

        if (page_data.index === this.page_manager.current_index) {
            history_state.undo_list.forEach(scale_command);
            history_state.redo_list.forEach(scale_command);
        }
    }

    _init_page_tiles(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.is_tiles_initialized) return;

        const tiles_container = page_data.page_element?.querySelector('.doc-reader-page-tiles');
        if (!tiles_container) return;

        // tile 坐标系使用页面的 CSS 宽度（固定基准，wrapper transform 负责缩放）
        const page_el = page_data.page_element;
        const tile_w = Math.round(parseFloat(page_el.style.width) || page_el.clientWidth || 800);
        const tile_h = Math.round(parseFloat(page_el.style.height) || page_el.clientHeight || (tile_w / this._get_page_aspect(page_data)));

        tiles_container.style.width = tile_w + 'px';
        tiles_container.style.height = tile_h + 'px';
        page_data.coord_width = tile_w;
        page_data.coord_height = tile_h;

        const tile_renderer = new TileRenderer({
            canvasW: tile_w,
            canvasH: tile_h,
            strokeHistoryRef: page_data.stroke_history,
            getVisibleRect: () => this._get_page_visible_rect(page_index),
            skipBaseCache: true
        });

        tile_renderer.init_tiles(tiles_container, 1);
        page_data.tile_renderer = tile_renderer;
        page_data.is_tiles_initialized = true;

        // 初始化 batch_draw（如果还没有初始化）
        if (!this.batch_draw) {
            this._init_batch_draw();
        }

        this._render_page_strokes(page_index);
    }

    _init_batch_draw() {
        // 创建覆盖层用于实时预览（固定在视口中央，不跟随滚动）
        const overlay_canvas = document.createElement('canvas');
        overlay_canvas.className = 'doc-reader-overlay-global';
        overlay_canvas.style.position = 'fixed';
        overlay_canvas.style.top = '0';
        overlay_canvas.style.left = '0';
        overlay_canvas.style.pointerEvents = 'none';
        overlay_canvas.style.zIndex = '100';

        // 设置初始尺寸为视口大小
        overlay_canvas.width = window.innerWidth;
        overlay_canvas.height = window.innerHeight;
        overlay_canvas.style.width = window.innerWidth + 'px';
        overlay_canvas.style.height = window.innerHeight + 'px';

        document.body.appendChild(overlay_canvas);

        const overlay_ctx = overlay_canvas.getContext('2d');
        overlay_ctx.imageSmoothingEnabled = false;

        // 初始化 batch_draw
        this.batch_draw = new window.RealtimeBatchDrawManager();
        this.batch_draw._overlayCanvas = overlay_canvas;
        this.batch_draw._overlayCtx = overlay_ctx;
        this.batch_draw._overlayTransformScale = 0;
        this.batch_draw._overlayTransformX = 0;
        this.batch_draw._overlayTransformY = 0;
        this.batch_draw._overlay_cached_rect_left = null;
        this.batch_draw._overlay_cached_rect_top = null;
        this.batch_draw._sync_overlay_transform = () => {
            // 文档阅读器需要根据页面位置设置变换（含缩放因子）
            if (!this.batch_draw._overlayCtx) return;
            if (this.active_page_index < 0) return;

            const page_data = this.page_manager.pages_list[this.active_page_index];
            if (!page_data?.page_element) return;

            // 缓存 rect 避免每次绘制都调用 getBoundingClientRect
            const now = performance.now();
            if (this.batch_draw._overlay_cached_rect_left !== null &&
                now - (this.batch_draw._overlay_last_rect_time || 0) < 16) {
                // 16ms 内复用缓存（约 60fps）
                const dpr = Math.min(window.DRAW_CONFIG.dpr, 1);
                const s = this.dr_scale;
                this.batch_draw._overlayCtx.setTransform(
                    dpr * s, 0, 0, dpr * s,
                    this.batch_draw._overlay_cached_rect_left * dpr,
                    this.batch_draw._overlay_cached_rect_top * dpr
                );
                return;
            }

            const rect = page_data.page_element.getBoundingClientRect();
            const dpr = Math.min(window.DRAW_CONFIG.dpr, 1);

            this.batch_draw._overlay_cached_rect_left = rect.left;
            this.batch_draw._overlay_cached_rect_top = rect.top;
            this.batch_draw._overlay_last_rect_time = now;

            // 设置变换，将页面坐标转换为视口坐标（含缩放因子）
            const s = this.dr_scale;
            this.batch_draw._overlayCtx.setTransform(
                dpr * s, 0, 0, dpr * s,
                rect.left * dpr, rect.top * dpr
            );
        };

        if (window.DRAW_CONFIG.frameRateMode) {
            this.batch_draw.batch_draw_update_frame_rate(window.DRAW_CONFIG.frameRateMode);
        }
    }

    _destroy_page_tiles(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;

        if (page_data.tile_renderer) {
            // 显式清空每个 tile canvas 的 context，释放 GPU 纹理
            for (const info of page_data.tile_renderer.tileInfos || []) {
                if (info.ctx) {
                    info.ctx.clearRect(0, 0, info.canvas?.width || 0, info.canvas?.height || 0);
                }
                if (info.canvas) {
                    info.canvas.width = 0;
                    info.canvas.height = 0;
                }
            }
            page_data.tile_renderer.destroy();
            page_data.tile_renderer = null;
        }

        // 清理历史版本可能已创建的 per-page overlay canvas，避免滚动大量页面后驻留纹理
        if (page_data.overlay_canvas) {
            const ctx = page_data.overlay_canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, page_data.overlay_canvas.width, page_data.overlay_canvas.height);
            }
            page_data.overlay_canvas.width = 0;
            page_data.overlay_canvas.height = 0;
            if (page_data.overlay_canvas.parentNode) {
                page_data.overlay_canvas.parentNode.removeChild(page_data.overlay_canvas);
            }
        }
        page_data.overlay_canvas = null;
        page_data.overlay_ctx = null;
        page_data._overlay_cached_w = 0;
        page_data._overlay_cached_h = 0;

        const tiles_container = page_data.page_element?.querySelector('.doc-reader-page-tiles');
        if (tiles_container) tiles_container.innerHTML = '';
        page_data.is_tiles_initialized = false;
    }

    _destroy_all_tiles() {
        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            this._destroy_page_tiles(i);
        }
    }

    _get_page_visible_rect(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.page_element) {
            return { x: 0, y: 0, width: page_data?.page_width || 800, height: page_data?.page_height || 600 };
        }
        const rect = page_data.page_element.getBoundingClientRect();
        const container_rect = this._scroll_container?.getBoundingClientRect();
        if (!container_rect) {
            return { x: 0, y: 0, width: rect.width, height: rect.height };
        }

        const visible_left = Math.max(0, container_rect.left - rect.left);
        const visible_top = Math.max(0, container_rect.top - rect.top);
        const visible_right = Math.min(rect.width, container_rect.right - rect.left);
        const visible_bottom = Math.min(rect.height, container_rect.bottom - rect.top);
        const inv = this.dr_cached_inv_scale || 1;

        return {
            x: visible_left * inv,
            y: visible_top * inv,
            width: Math.max(0, visible_right - visible_left) * inv,
            height: Math.max(0, visible_bottom - visible_top) * inv
        };
    }

    _update_overlay_size(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.overlay_canvas || !page_data.page_element) return;

        const rect = page_data.page_element.getBoundingClientRect();
        const w = Math.ceil(rect.width);
        const h = Math.ceil(rect.height);

        // 缓存尺寸，避免重复 resize 触发 GPU 纹理重建
        if (page_data._overlay_cached_w === w && page_data._overlay_cached_h === h) return;
        page_data._overlay_cached_w = w;
        page_data._overlay_cached_h = h;

        // overlay 仅用于实时预览，DPR=1 足够，节省 GPU 显存
        page_data.overlay_canvas.width = w;
        page_data.overlay_canvas.height = h;
        page_data.overlay_canvas.style.width = w + 'px';
        page_data.overlay_canvas.style.height = h + 'px';
        page_data.overlay_ctx.imageSmoothingEnabled = false;
    }

    // ====== 批注渲染 ======

    _render_page_strokes(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.tile_renderer) return;

        page_data.tile_renderer._strokeHistoryRef = page_data.stroke_history;

        // 无笔画时跳过全量重建，减少 GPU 开销（skipBaseCache=true 时 tiles 只有笔画内容）
        if (page_data.stroke_history.length === 0) {
            return;
        }

        page_data.tile_renderer.mark_strokes_changed();
        page_data.tile_renderer.mark_all();
        page_data.tile_renderer.rebuild_all();
    }

    async _render_all_strokes(bounds) {
        const page = this.page_manager.get_current_page();
        if (!page || !page.tile_renderer) return;

        window.main_reset_context_state?.();
        page.tile_renderer._strokeHistoryRef = page.stroke_history;
        page.tile_renderer.mark_strokes_changed();

        // 优先只重建脏区域涉及的 tiles
        if (bounds && isFinite(bounds.minX) && isFinite(bounds.minY) &&
            isFinite(bounds.maxX) && isFinite(bounds.maxY)) {
            const infos = page.tile_renderer.infos_for_segment(
                bounds.minX, bounds.minY, bounds.maxX, bounds.maxY
            );
            for (const info of infos) {
                page.tile_renderer.dirty.add(info.key);
            }
        } else {
            page.tile_renderer.mark_all();
        }

        page.tile_renderer.rebuild_all();
    }

    // ====== 绘制事件 ======

    _setup_events() {
        if (!this._scroll_container) return;

        if (window.PointerEvent) {
            this._scroll_container.addEventListener('pointerdown', (e) => this._handle_pointer_down(e));
            this._scroll_container.addEventListener('pointermove', (e) => this._handle_pointer_move(e));
            this._scroll_container.addEventListener('pointerup', (e) => this._handle_pointer_up(e));
            this._scroll_container.addEventListener('pointerleave', (e) => this._handle_pointer_up(e));
            this._scroll_container.addEventListener('pointercancel', (e) => this._handle_pointer_up(e));
        } else {
            this._scroll_container.addEventListener('mousedown', (e) => this._handle_mouse_down(e));
            this._scroll_container.addEventListener('mousemove', (e) => this._handle_mouse_move(e));
            this._scroll_container.addEventListener('mouseup', (e) => this._handle_mouse_up(e));
            this._scroll_container.addEventListener('mouseleave', (e) => this._handle_mouse_up(e));
        }

        // 缩放事件：滚轮 + 双指触摸（始终注册，PointerEvent 不转发双指事件）
        this._scroll_container.addEventListener('wheel', (e) => this._dr_handle_wheel(e), { passive: false });
        this._scroll_container.addEventListener('touchstart', (e) => this._dr_handle_touch_start(e), { passive: false });
        this._scroll_container.addEventListener('touchmove', (e) => this._dr_handle_touch_move(e), { passive: false });
        this._scroll_container.addEventListener('touchend', (e) => this._dr_handle_touch_end(e), { passive: false });
        this._scroll_container.addEventListener('touchcancel', (e) => this._dr_handle_touch_end(e), { passive: false });
    }

    _setup_keyboard_events() {
        document.addEventListener('keydown', (e) => {
            if (!this.is_open) return;

            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }

            // Ctrl+0 / Cmd+0 重置缩放
            if ((e.ctrlKey || e.metaKey) && e.key === '0') {
                e.preventDefault();
                if (this.dr_scale !== 1 || this.dr_canvas_x !== 0 || this.dr_canvas_y !== 0) {
                    this.dr_scale = 1;
                    this.dr_canvas_x = 0;
                    this.dr_canvas_y = 0;
                    this._dr_apply_scale();
                }
            }
        });
    }

    _handle_pointer_down(e) {
        if (!this.is_open) return;

        const target = e.target.closest('.doc-reader-page');
        if (!target) return;

        const page_index = parseInt(target.dataset.page);
        if (isNaN(page_index)) return;

        // 确保该页的 TileRenderer 已初始化
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data.is_tiles_initialized) {
            this._on_page_visible(page_index);
        }

        this.active_page_index = page_index;
        this.page_manager.switch_page(page_index);

        // 切换 batch_draw 的 tileRenderer 引用
        if (this.batch_draw) {
            this.batch_draw._tileRenderer = page_data.tile_renderer;
        }

        // 同步翻页器显示（move 模式下拖拽结束后 _check_page_visibility 会再次修正）
        this._update_page_indicator();
        this._sync_page_buttons();

        if (this.draw_mode === 'move') {
            // 拖拽平移
            e.preventDefault();
            this.dr_is_dragging = true;
            this.dr_start_drag_x = e.clientX - this.dr_canvas_x;
            this.dr_start_drag_y = e.clientY - this.dr_canvas_y;
        } else if (this.draw_mode === 'comment' || this.draw_mode === 'eraser') {
            e.preventDefault();
            this.is_drawing = true;
            // 批注时屏蔽浏览器原生滚动
            if (this._scroll_container) {
                this._scroll_container.style.touchAction = 'none';
            }

            const rect = target.getBoundingClientRect();
            this.draw_canvas_rect = rect;
            const inv = this.dr_cached_inv_scale;
            this.last_x = (e.clientX - rect.left) * inv;
            this.last_y = (e.clientY - rect.top) * inv;
            this._start_stroke(this.draw_mode === 'comment' ? 'draw' : 'erase');
        }
    }

    _handle_pointer_move(e) {
        // 拖拽平移
        if (this.dr_is_dragging) {
            e.preventDefault();
            this.dr_canvas_x = e.clientX - this.dr_start_drag_x;
            this.dr_canvas_y = e.clientY - this.dr_start_drag_y;
            this._dr_update_canvas_position();
            this._dr_sync_transform();
            return;
        }

        if (!this.is_drawing || this.active_page_index < 0) return;

        e.preventDefault();

        this.current_pressure = e.pressure || 0.5;

        if (this.draw_mode === 'eraser') {
            this._update_eraser_hint_position(e.clientX, e.clientY);
        }

        const page_data = this.page_manager.pages_list[this.active_page_index];
        if (!page_data?.page_element) return;

        const rect = this.draw_canvas_rect || page_data.page_element.getBoundingClientRect();
        const inv = this.dr_cached_inv_scale;
        const x = (e.clientX - rect.left) * inv;
        const y = (e.clientY - rect.top) * inv;

        const dx = x - this.last_x;
        const dy = y - this.last_y;
        const dist_sq = dx * dx + dy * dy;

        if (dist_sq > 1) {
            this._save_stroke_point(this.last_x, this.last_y, x, y, this.current_pressure);

            if (this.batch_draw && page_data.tile_renderer) {
                this.batch_draw.batch_draw_create_command(
                    this.cached_draw_type,
                    this.last_x,
                    this.last_y,
                    x,
                    y,
                    this.cached_draw_color,
                    this.cached_draw_line_width
                );
            }

            this.last_x = x;
            this.last_y = y;
        }
    }

    async _handle_pointer_up(e) {
        // 停止拖拽
        if (this.dr_is_dragging) {
            this.dr_is_dragging = false;
            // 拖拽后检查可见性（新页面进入视口需加载）
            this._check_page_visibility();
            return;
        }

        if (!this.is_drawing) return;
        this.is_drawing = false;
        this.draw_canvas_rect = null;
        await this._submit_stroke();
    }

    _handle_mouse_down(e) { this._handle_pointer_down(e); }
    _handle_mouse_move(e) { this._handle_pointer_move(e); }
    async _handle_mouse_up(e) { await this._handle_pointer_up(e); }

    // ====== 笔画生命周期 — 复制自 main.js ======

    _start_stroke(type) {
        const DRAW_CONFIG = window.DRAW_CONFIG;
        this.current_stroke = {
            type: type,
            points: [],
            color: type === 'draw' ? DRAW_CONFIG.penColor : '#000000',
            lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth : DRAW_CONFIG.eraserSize,
            eraserSize: DRAW_CONFIG.eraserSize,
            eraserSizeRaw: DRAW_CONFIG.eraserSize,
            scale: 1,
            bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
            variableWidths: null
        };

        this.current_pressure = 0.5;
        this.current_line_width = DRAW_CONFIG.penWidth;
        this.last_line_width = DRAW_CONFIG.penWidth;

        this.cached_draw_type = type;
        this.cached_draw_color = type === 'draw' ? DRAW_CONFIG.penColor : '#000000';
        this.cached_draw_line_width = type === 'draw' ? DRAW_CONFIG.penWidth : DRAW_CONFIG.eraserSize;

        if (this.batch_draw) {
            this.batch_draw.batch_draw_init_start();
        }
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
            if (this.batch_draw) {
                this.batch_draw.batch_draw_handle_flush();
                const stored_widths = this.batch_draw._storedWidths;
                if (stored_widths && stored_widths.length > 0 &&
                    stored_widths.length === this.current_stroke.points.length) {
                    this.current_stroke.storedWidths = [...stored_widths];
                }
            }

            const page = this.page_manager.get_current_page();
            if (page) {
                const stroke_bounds = this.current_stroke.bounds ? { ...this.current_stroke.bounds } : null;
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
        if (this.batch_draw) {
            await this.batch_draw.batch_draw_handle_end();
            this.batch_draw.batch_draw_delete_all();
        }
        this._update_button_status();
    }

    // ====== 撤销与清空 ======

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

    // ====== 页面导航 ======

    async handle_page_nav_prev() {
        if (this.is_drawing) return;
        await this._submit_stroke();
        const moved = this.page_manager.nav_prev();
        if (moved) {
            await this._scroll_to_page(this.page_manager.current_index);
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
            await this._scroll_to_page(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async _scroll_to_page(page_index) {
        if (!this._scroll_container || !this._zoom_wrapper) return;
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.page_element) return;

        const page_el = page_data.page_element;
        const container = this._scroll_container;
        const s = this.dr_scale;

        // 计算页面中心在 wrapper 中的偏移（CSS 像素，transform 前）
        const page_center_y = page_el.offsetTop + page_el.offsetHeight / 2;
        const viewport_center_y = container.clientHeight / 2;

        // 设置 canvas_y 使页面中心居中视口（无需动画，_dr_apply_scale 会 clamp 边界）
        this.dr_canvas_x = 0;
        this.dr_canvas_y = viewport_center_y - page_center_y * s;
        this._dr_apply_scale();
    }

    _update_page_indicator() {
        const el = document.getElementById('drPageIndicator');
        if (el) {
            el.textContent = `${this.page_manager.current_index + 1} / ${this.page_manager.get_page_count()}`;
        }
    }

    _sync_page_buttons() {
        const prev_btn = document.getElementById('drPagePrev');
        const next_btn = document.getElementById('drPageNext');
        if (prev_btn) prev_btn.disabled = this.page_manager.current_index <= 0;
        if (next_btn) next_btn.disabled = this.page_manager.current_index >= this.page_manager.get_page_count() - 1;
    }

    // ====== 工具栏切换 ======

    _switch_toolbar(reader_active) {
        const toolbar = document.querySelector('.toolbar');
        const left_section = document.querySelector('.toolbar-left');
        const center_section = document.querySelector('.toolbar-center');
        const right_section = document.querySelector('.toolbar-right');
        const btn_expand = document.getElementById('btnExpand');
        const btn_save = document.getElementById('btnSave');

        if (reader_active) {
            // 文档阅读器激活时：隐藏左侧和中间，右侧独占
            if (left_section) left_section.style.display = 'none';
            if (center_section) center_section.style.display = 'none';
            if (right_section) {
                right_section.style.position = 'absolute';
                right_section.style.right = '0';
            }
        } else {
            // 恢复原始布局
            if (left_section) left_section.style.display = '';
            if (center_section) center_section.style.display = '';
            if (right_section) {
                right_section.style.position = '';
                right_section.style.right = '';
            }
        }

        // 隐藏右侧的图片/文件按钮
        if (btn_expand) btn_expand.style.display = reader_active ? 'none' : '';
        if (btn_save) btn_save.style.display = reader_active ? 'none' : '';

        // 显示/隐藏文档阅读器控件
        if (this._dr_tool_group) {
            this._dr_tool_group.style.display = reader_active ? 'inline-flex' : 'none';
        }
    }

    // ====== 工具栏事件 ======

    _setup_toolbar_events() {
        const close_btn = document.getElementById('drBtnClose');
        if (close_btn) close_btn.addEventListener('click', () => this.close());

        const prev_btn = document.getElementById('drPagePrev');
        const next_btn = document.getElementById('drPageNext');
        if (prev_btn) prev_btn.addEventListener('click', () => this.handle_page_nav_prev());
        if (next_btn) next_btn.addEventListener('click', () => this.handle_page_nav_next());

        const page_indicator = document.getElementById('drPageIndicator');
        if (page_indicator) {
            page_indicator.style.cursor = 'pointer';
            page_indicator.addEventListener('click', () => this._toggle_page_sidebar());
        }

        const move_btn = document.getElementById('drBtnMove');
        const comment_btn = document.getElementById('drBtnComment');
        const eraser_btn = document.getElementById('drBtnEraser');
        const undo_btn = document.getElementById('drBtnUndo');
        const clear_btn = document.getElementById('drBtnClear');

        if (move_btn) move_btn.addEventListener('click', () => this._set_draw_mode('move'));
        if (comment_btn) comment_btn.addEventListener('click', () => this._set_draw_mode('comment'));
        if (eraser_btn) eraser_btn.addEventListener('click', () => this._set_draw_mode('eraser'));
        if (undo_btn) undo_btn.addEventListener('click', () => this.handle_undo());
        if (clear_btn) clear_btn.addEventListener('click', () => this.handle_clear());
    }

    _set_draw_mode(mode) {
        this.draw_mode = mode;

        const move_btn = document.getElementById('drBtnMove');
        const comment_btn = document.getElementById('drBtnComment');
        const eraser_btn = document.getElementById('drBtnEraser');

        if (move_btn) move_btn.classList.toggle('active', mode === 'move');
        if (comment_btn) comment_btn.classList.toggle('active', mode === 'comment');
        if (eraser_btn) eraser_btn.classList.toggle('active', mode === 'eraser');

        // 无原生滚动条，touch-action 仅用于控制双指手势由 touch handler 接管
        if (this._scroll_container) {
            this._scroll_container.style.touchAction = 'none';
        }

        if (mode === 'eraser') {
            this._show_eraser_hint();
        } else {
            this._hide_eraser_hint();
        }
    }

    // ====== 橡皮擦提示 ======

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
            const pos = this._eraser_hint_pending_pos;
            this._eraser_hint_pending_pos = null;

            const eraser_size = window.DRAW_CONFIG?.eraserSize || 15;
            this._eraser_hint.style.width = eraser_size + 'px';
            this._eraser_hint.style.height = eraser_size + 'px';
            this._eraser_hint.style.left = (pos.clientX - eraser_size / 2) + 'px';
            this._eraser_hint.style.top = (pos.clientY - eraser_size / 2) + 'px';
        });
    }

    // ====== 页面侧边栏 ======

    _toggle_page_sidebar() {
        const existing_sidebar = document.getElementById('drPageSidebar');
        if (existing_sidebar) {
            existing_sidebar.remove();
            return;
        }

        const sidebar = document.createElement('div');
        sidebar.id = 'drPageSidebar';
        sidebar.className = 'dr-page-sidebar';

        const pages = this.page_manager.pages_list;
        const current_index = this.page_manager.current_index;

        // 创建头部
        const header = document.createElement('div');
        header.className = 'dr-page-sidebar-header';
        header.textContent = `页面 (${current_index + 1}/${pages.length})`;
        sidebar.appendChild(header);

        // 创建内容区域
        const content = document.createElement('div');
        content.className = 'dr-page-sidebar-content';

        const use_virtual_sidebar = pages.length > this._sidebar_virtual_threshold;
        if (use_virtual_sidebar) {
            content.classList.add('virtualized');
        } else {
            pages.forEach((page, index) => {
                content.appendChild(this._create_page_sidebar_item(page, index, current_index));
            });
        }

        sidebar.appendChild(content);
        document.body.appendChild(sidebar);
        if (use_virtual_sidebar) {
            this._setup_virtual_page_sidebar(content, pages, current_index);
        } else {
            this._setup_page_sidebar_thumbnail_loading(content);
        }

        // 绑定点击事件
        content.addEventListener('click', (event) => {
            const item = event.target.closest('.dr-page-sidebar-item');
            if (!item || !content.contains(item)) return;
            const page_index = parseInt(item.dataset.page);
            this._scroll_to_page(page_index);
            this.page_manager.current_index = page_index;
            this.active_page_index = page_index;
            this._update_page_indicator();
            this._sync_page_buttons();
            sidebar.remove();
        });

        // 点击外部关闭
        const close_handler = (e) => {
            if (!sidebar.contains(e.target) && e.target.id !== 'drPageIndicator') {
                sidebar.remove();
                document.removeEventListener('click', close_handler);
            }
        };
        setTimeout(() => document.addEventListener('click', close_handler), 100);
    }

    _create_page_sidebar_item(page, index, current_index) {
        const is_active = index === current_index;
        const page_label = `第 ${page.page_num || index + 1} 页`;
        const item = document.createElement('div');
        item.className = `dr-page-sidebar-item ${is_active ? 'active' : ''}`;
        item.dataset.page = index;

        const thumbnail_src = page.image_url || page.thumbnail_url;
        let thumb_el;
        if (thumbnail_src) {
            const img = document.createElement('img');
            img.className = 'dr-page-sidebar-thumb';
            img.dataset.page = index;
            img.src = thumbnail_src;
            img.alt = page_label;
            img.loading = 'lazy';
            thumb_el = img;
        } else {
            thumb_el = document.createElement('div');
            thumb_el.className = 'dr-page-sidebar-thumb is-loading';
            thumb_el.dataset.page = index;
            thumb_el.setAttribute('role', 'img');
            thumb_el.setAttribute('aria-label', page_label);
            item.classList.add('loading');
        }

        const label = document.createElement('span');
        label.textContent = page_label;

        item.appendChild(thumb_el);
        item.appendChild(label);
        return item;
    }

    _setup_virtual_page_sidebar(content, pages, current_index) {
        let render_raf = null;
        const render_window = () => {
            render_raf = null;
            const item_h = this._sidebar_item_height;
            const viewport_h = content.clientHeight || 480;
            const start = Math.max(0, Math.floor(content.scrollTop / item_h) - this._sidebar_overscan);
            const end = Math.min(
                pages.length,
                Math.ceil((content.scrollTop + viewport_h) / item_h) + this._sidebar_overscan
            );

            const spacer = document.createElement('div');
            spacer.className = 'dr-page-sidebar-virtual-spacer';
            spacer.style.height = `${pages.length * item_h}px`;

            for (let i = start; i < end; i++) {
                const item = this._create_page_sidebar_item(pages[i], i, current_index);
                item.style.top = `${i * item_h}px`;
                item.style.height = `${item_h - 6}px`;
                spacer.appendChild(item);
            }

            content.replaceChildren(spacer);
            this._setup_page_sidebar_thumbnail_loading(content);
        };

        const schedule_render = () => {
            if (render_raf !== null) return;
            render_raf = requestAnimationFrame(render_window);
        };

        content.addEventListener('scroll', schedule_render, { passive: true });
        content.scrollTop = Math.max(0, current_index * this._sidebar_item_height - this._sidebar_item_height);
        render_window();
    }

    _setup_page_sidebar_thumbnail_loading(content) {
        const unloaded_imgs = Array.from(content.querySelectorAll('.dr-page-sidebar-thumb.is-loading'));
        if (unloaded_imgs.length === 0) return;

        const priority_imgs = unloaded_imgs
            .filter(img => {
                const page_index = parseInt(img.dataset.page);
                const page = this.page_manager.pages_list[page_index];
                return page?.is_visible || page_index === this.active_page_index;
            })
            .sort((a, b) => {
                const ai = parseInt(a.dataset.page);
                const bi = parseInt(b.dataset.page);
                return Math.abs(ai - this.active_page_index) - Math.abs(bi - this.active_page_index);
            });

        priority_imgs.forEach(img => {
            this._load_page_sidebar_thumbnail(parseInt(img.dataset.page), img);
        });

        const deferred_imgs = unloaded_imgs.filter(img => !priority_imgs.includes(img));
        if (deferred_imgs.length === 0) return;

        if (!window.IntersectionObserver) {
            deferred_imgs.slice(0, 8).forEach(img => {
                this._load_page_sidebar_thumbnail(parseInt(img.dataset.page), img);
            });
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                observer.unobserve(img);
                this._load_page_sidebar_thumbnail(parseInt(img.dataset.page), img);
            }
        }, {
            root: content,
            rootMargin: '120px 0px',
            threshold: 0.01
        });

        deferred_imgs.forEach(img => observer.observe(img));
    }

    async _load_page_sidebar_thumbnail(page_index, img) {
        const page = this.page_manager.pages_list[page_index];
        if (!page || !img) return;

        const existing_src = page.image_url || page.thumbnail_url;
        if (existing_src) {
            this._set_sidebar_thumbnail_src(img, page_index, existing_src);
            return;
        }
        if (page.sidebar_thumbnail_loading) return;

        page.sidebar_thumbnail_loading = true;
        try {
            await this._load_pdf_page(page_index);
            const loaded_src = page.image_url || page.thumbnail_url;
            if (loaded_src) {
                this._update_page_sidebar_thumbnail(page_index, loaded_src);
            }
        } catch (error) {
            console.error(`加载侧边栏原图 ${page_index + 1} 失败:`, error);
        } finally {
            page.sidebar_thumbnail_loading = false;
        }
    }

    _update_page_sidebar_thumbnail(page_index, src) {
        const img = document.querySelector(`#drPageSidebar .dr-page-sidebar-thumb[data-page="${page_index}"]`);
        if (!img || !src) return;
        this._set_sidebar_thumbnail_src(img, page_index, src);
    }

    _set_sidebar_thumbnail_src(thumb_el, page_index, src) {
        if (!thumb_el || !src) return;
        let img = thumb_el;
        if (thumb_el.tagName !== 'IMG') {
            img = document.createElement('img');
            img.className = 'dr-page-sidebar-thumb';
            img.dataset.page = page_index;
            img.alt = `第 ${page_index + 1} 页`;
            img.loading = 'lazy';
            thumb_el.replaceWith(img);
        }
        img.src = src;
        img.classList.remove('is-loading');
        img.closest('.dr-page-sidebar-item')?.classList.remove('loading');
    }

    // ====== 缩放与 LOD ======

    /** 计算平移边界：缩放后内容是否超出视口，决定可拖动范围 */
    _dr_update_move_bound() {
        if (!this._zoom_wrapper || !this._scroll_container) return;
        const wrapper = this._zoom_wrapper;
        const container = this._scroll_container;
        const mb = this.dr_move_bound;

        // wrapper scrollHeight = 所有页面布局总高度（含 gap/padding）
        const content_w = wrapper.scrollWidth;
        const content_h = wrapper.scrollHeight;
        const viewport_w = container.clientWidth;
        const viewport_h = container.clientHeight;

        // X 方向：内容 + padding 始终居中
        const bounded_w = content_w * this.dr_scale;
        if (bounded_w >= viewport_w) {
            mb.min_x = -(bounded_w - viewport_w);
            mb.max_x = 0;
        } else {
            mb.min_x = (viewport_w - bounded_w) / 2;
            mb.max_x = (viewport_w - bounded_w) / 2;
        }

        // Y 方向
        const bounded_h = content_h * this.dr_scale;
        if (bounded_h >= viewport_h) {
            mb.min_y = -(bounded_h - viewport_h);
            mb.max_y = 0;
        } else {
            mb.min_y = (viewport_h - bounded_h) / 2;
            mb.max_y = (viewport_h - bounded_h) / 2;
        }
    }

    /** 将 canvas_x/y 钳制在 move_bound 内 */
    _dr_update_canvas_position() {
        const eps = 0.001;
        const mb = this.dr_move_bound;
        this.dr_canvas_x = Math.max(mb.min_x - eps, Math.min(mb.max_x + eps, this.dr_canvas_x));
        this.dr_canvas_y = Math.max(mb.min_y - eps, Math.min(mb.max_y + eps, this.dr_canvas_y));
    }

    /** 仅同步 transform（无 LOD 更新，用于高频拖拽） */
    _dr_sync_transform() {
        if (!this._zoom_wrapper) return;
        this._zoom_wrapper.style.transform = `translate3d(${this.dr_canvas_x}px, ${this.dr_canvas_y}px, 0) scale(${this.dr_scale})`;
    }

    /** 应用当前缩放比到 wrapper transform + TileRenderer LOD */
    _dr_apply_scale() {
        const s = this.dr_scale;
        this.dr_cached_inv_scale = 1 / s;

        // 使 overlay 缓存失效
        if (this.batch_draw) {
            this.batch_draw._overlay_cached_rect_left = null;
            this.batch_draw._overlay_cached_rect_top = null;
        }

        this._dr_update_move_bound();
        this._dr_update_canvas_position();
        this._dr_sync_transform();

        // 更新所有已初始化页面的 TileRenderer LOD
        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            const pd = this.page_manager.pages_list[i];
            if (pd.tile_renderer && (pd.is_visible || this._is_page_near_active(i, this._tile_keep_distance))) {
                pd.tile_renderer.update_visible_tile_dpr(s, false, true);
            }
        }

        // 更新 active 页面的 overlay 尺寸（getBoundingClientRect 已包含 transform 缩放）
        if (this.active_page_index >= 0) {
            this._update_overlay_size(this.active_page_index);
        }

        // 缩放/平移后检查页面可见性（已优化为纯数学计算，不触发每页布局）
        this._check_page_visibility();
    }

    /** 滚轮缩放（以鼠标位置为中心） */
    _dr_handle_wheel(e) {
        if (!this.is_open) return;
        if (this.is_drawing) return;

        // 阅读器内部无原生滚动条，滚轮直接用于缩放。
        e.preventDefault();

        const max_s = this.dr_max_scale;
        const min_s = this.dr_min_scale;
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const new_s = Math.max(min_s, Math.min(max_s, this.dr_scale + delta));

        if (new_s !== this.dr_scale) {
            const old_s = this.dr_scale;
            const ratio = new_s / old_s;

            // 以鼠标位置为中心缩放（Blackboard 风格）
            const container_rect = this._scroll_container.getBoundingClientRect();
            const mouse_x = e.clientX - container_rect.left;
            const mouse_y = e.clientY - container_rect.top;

            this.dr_canvas_x = mouse_x - (mouse_x - this.dr_canvas_x) * ratio;
            this.dr_canvas_y = mouse_y - (mouse_y - this.dr_canvas_y) * ratio;
            this.dr_scale = new_s;
            this._dr_apply_scale();
        }
    }

    /** 触摸双指缩放（批注中允许双指，取消当前笔画进入缩放） */
    async _dr_handle_touch_start(e) {
        if (!this.is_open) return;
        const touches = e.touches;

        if (touches.length === 2) {
            e.preventDefault();

            // 如果正在绘制，先提交当前笔画再进入缩放
            if (this.is_drawing) {
                this.is_drawing = false;
                this.draw_canvas_rect = null;
                await this._submit_stroke();
                if (this.batch_draw) {
                    this.batch_draw.batch_draw_delete_all();
                }
            }

            this.dr_is_scaling = true;
            this.dr_is_dragging = false;
            this.dr_start_distance_sq = this._dr_calc_touch_dist_sq(touches[0], touches[1]);
            this.dr_start_scale = this.dr_scale;
            this.dr_start_scale_x = (touches[0].clientX + touches[1].clientX) / 2;
            this.dr_start_scale_y = (touches[0].clientY + touches[1].clientY) / 2;
            this.dr_start_canvas_x = this.dr_canvas_x;
            this.dr_start_canvas_y = this.dr_canvas_y;
        }
    }

    _dr_handle_touch_move(e) {
        if (!this.is_open || !this.dr_is_scaling) return;
        const touches = e.touches;

        if (touches.length === 2) {
            e.preventDefault();
            const current_dist_sq = this._dr_calc_touch_dist_sq(touches[0], touches[1]);
            const scale_ratio = Math.sqrt(current_dist_sq / this.dr_start_distance_sq);
            let new_s = this.dr_start_scale * scale_ratio;
            new_s = Math.max(this.dr_min_scale, Math.min(this.dr_max_scale, new_s));

            if (new_s !== this.dr_scale) {
                const ratio = new_s / this.dr_start_scale;
                const center_x = (touches[0].clientX + touches[1].clientX) / 2;
                const center_y = (touches[0].clientY + touches[1].clientY) / 2;

                this.dr_canvas_x = center_x - (this.dr_start_scale_x - this.dr_start_canvas_x) * ratio;
                this.dr_canvas_y = center_y - (this.dr_start_scale_y - this.dr_start_canvas_y) * ratio;
                this.dr_scale = new_s;
                this._dr_apply_scale();
            }
        }
    }

    _dr_handle_touch_end(e) {
        if (e.touches.length < 2) {
            this.dr_is_scaling = false;
            this.dr_is_dragging = false;
        }
    }

    /** 计算两点触摸距离平方 */
    _dr_calc_touch_dist_sq(t1, t2) {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return dx * dx + dy * dy;
    }

    // ====== 按钮状态 ======

    _update_button_status() {
        const undo_btn = document.getElementById('drBtnUndo');
        if (undo_btn) undo_btn.disabled = !history_validate_undo();
    }
}

const documentReaderManager = new DocumentReaderManager();
window.documentReaderManager = documentReaderManager;
export default documentReaderManager;
