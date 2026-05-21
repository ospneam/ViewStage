import ThemeManager from './themes/theme.js';
import { history_init_manager, history_validate_undo } from './history.js';
import './batch-draw.js';
console.log('[init] module loaded, readyState:', document.readyState);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[init] DOMContentLoaded -> initPdfJs');
        window.main_init_pdfjs();
    });
} else {
    console.log('[init] already loaded, calling initPdfJs immediately');
    window.main_init_pdfjs();
}

async function dir_init_cache_path() {
    if (window.__TAURI__) {
        try {
            window.cacheDir = await window.__TAURI__.core.invoke('dir_fetch_cache');
            window.configDir = await window.__TAURI__.core.invoke('dir_fetch_config');
            window.cdsDir = await window.__TAURI__.core.invoke('dir_fetch_pictures_viewstage');
        } catch (error) {
            console.error('获取缓存目录失败:', error);
        }
    }
}

function app_emit_splash_progress(step, message) {
    if (window.__TAURI__) {
        const { emit } = window.__TAURI__.event;
        emit('splash-progress', { step, message }).catch(() => {});
    }
}

function dom_init_all() {
    const dom = window.dom;
    dom.canvasContainer = document.getElementById('canvasContainer');
    dom.canvasWrapper = document.getElementById('canvasWrapper');
    dom.imageElement = document.getElementById('imageElement');
    dom.drawCanvas = document.getElementById('drawCanvas');
    dom.cameraVideo = document.getElementById('cameraVideo');
    dom.eraserHint = document.getElementById('eraserHint');
    dom.penControlPanel = document.getElementById('penControlPanel');
    dom.settingsPanel = document.getElementById('settingsPanel');

    dom.penSizePresets = document.getElementById('penSizePresets');
    dom.penSizeValue = document.getElementById('penSizeValue');
    dom.penColorPicker = document.getElementById('penColorPicker');
    dom.eraserSizePresets = document.getElementById('eraserSizePresets');
    dom.eraserSizeValue = document.getElementById('eraserSizeValue');

    dom.btnMove = document.getElementById('btnMove');
    dom.btnComment = document.getElementById('btnComment');
    dom.btnEraser = document.getElementById('btnEraser');
    dom.btnUndo = document.getElementById('btnUndo');
    dom.btnClear = document.getElementById('btnClear');
    dom.btnPhoto = document.getElementById('btnPhoto');
    dom.btnSettings = document.getElementById('btnSettings');
    dom.btnExpand = document.getElementById('btnExpand');
    dom.btnSave = document.getElementById('btnSave');
    dom.btnMinimize = document.getElementById('btnMinimize');
    dom.btnMenu = document.getElementById('btnMenu');

    if (!dom.imageElement || !dom.drawCanvas || !dom.canvasContainer) {
        console.error('必需的元素未找到');
        return false;
    }

    dom.drawCtx = dom.drawCanvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!dom.drawCtx) {
        console.error('获取 Canvas 2D 上下文失败');
        return false;
    }

    return true;
}

function canvas_init_all() {
    const dom = window.dom;
    const state = window.state;
    const DRAW_CONFIG = window.DRAW_CONFIG;
    const container = dom.canvasContainer;
    const screenW = container.clientWidth;
    const screenH = container.clientHeight;

    DRAW_CONFIG.screenW = screenW;
    DRAW_CONFIG.screenH = screenH;
    DRAW_CONFIG.canvasW = Math.floor(screenW * 2);
    DRAW_CONFIG.canvasH = Math.floor(screenH * 2);

    DRAW_CONFIG.baseDpr = window.devicePixelRatio || 1;
    DRAW_CONFIG.dpr = window.main_calc_capped_dpr(DRAW_CONFIG.baseDpr, DRAW_CONFIG.dprLimit);

    window.main_update_move_bound();

    state.canvasX = -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
    state.canvasY = -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;

    state.cameraViewState = {
        scale: 1,
        canvasX: state.canvasX,
        canvasY: state.canvasY,
        strokeHistory: [],
        baseImageURL: null
    };

    dom.drawCanvas.width = DRAW_CONFIG.canvasW * DRAW_CONFIG.dpr;
    dom.drawCanvas.height = DRAW_CONFIG.canvasH * DRAW_CONFIG.dpr;

    dom.imageElement.style.width = DRAW_CONFIG.canvasW + 'px';
    dom.imageElement.style.height = DRAW_CONFIG.canvasH + 'px';
    dom.drawCanvas.style.width = DRAW_CONFIG.canvasW + 'px';
    dom.drawCanvas.style.height = DRAW_CONFIG.canvasH + 'px';

    dom.drawCtx.scale(DRAW_CONFIG.dpr, DRAW_CONFIG.dpr);

    const draw_ctx = dom.drawCtx;
    draw_ctx.imageSmoothingEnabled = false;
    draw_ctx.lineCap = 'round';
    draw_ctx.lineJoin = 'round';
    draw_ctx.miterLimit = 10;

    window.main_update_pen_style();
    window.main_update_eraser_hint_size();
    window.main_update_canvas_transform();
    window.main_update_canvas_bg_color(DRAW_CONFIG.canvasBgColor);

    dom.btnMove.classList.add('primary-btn');

    console.log(`画布初始化: 屏幕 ${screenW}x${screenH}, 画布 ${DRAW_CONFIG.canvasW}x${DRAW_CONFIG.canvasH}`);
}

async function settings_load_camera_config() {
    if (window.__TAURI__) {
        try {
            const { invoke } = window.__TAURI__.core;
            const state = window.state;
            const DRAW_CONFIG = window.DRAW_CONFIG;
            const settings = await invoke('settings_fetch_all');

            if (settings.defaultCamera) {
                state.defaultCameraId = settings.defaultCamera;
            }

            if (settings.cameraWidth && settings.cameraHeight) {
                state.cameraWidth = settings.cameraWidth;
                state.cameraHeight = settings.cameraHeight;
            }

            if (settings.defaultRotation !== undefined) {
                state.cameraRotation = settings.defaultRotation;
            }

            if (settings.width && settings.height) {
                DRAW_CONFIG.renderW = settings.width;
                DRAW_CONFIG.renderH = settings.height;
            }

            if (settings.dprLimit !== undefined) {
                DRAW_CONFIG.dprLimit = settings.dprLimit;
                DRAW_CONFIG.baseDpr = window.devicePixelRatio || 1;
                DRAW_CONFIG.dpr = window.main_calc_capped_dpr(DRAW_CONFIG.baseDpr, DRAW_CONFIG.dprLimit);
            }

            if (settings.pdfScale) {
                DRAW_CONFIG.pdfScale = settings.pdfScale;
            }

            if (settings.penColors && Array.isArray(settings.penColors)) {
                DRAW_CONFIG.penColors = settings.penColors.map(color => {
                    if (typeof color === 'object' && color.r !== undefined) {
                        return window.main_calc_rgb_to_hex(color.r, color.g, color.b);
                    }
                    return color;
                });
                window.main_update_color_buttons();
            }

            if (settings.frameRateMode !== undefined) {
                if (window.batchDrawManager) {
                    window.batchDrawManager.batch_draw_update_frame_rate(settings.frameRateMode);
                }
            }

            if (settings.penEffectMode !== undefined) {
                DRAW_CONFIG.penEffectMode = settings.penEffectMode;
            }

            const themeName = settings.theme || 'com.viewstage.theme.simplify';
            await ThemeManager.theme_update_active(themeName);

            const canvasBgColor = ThemeManager.theme_fetch_canvas_bg_color();
            DRAW_CONFIG.canvasBgColor = canvasBgColor;
            window.main_update_canvas_bg_color(canvasBgColor);
        } catch (error) {
            console.error('加载摄像头设置失败:', error);
        }
    }
}

async function draw_save_snapshot() {
    await window.main_submit_stroke();
}

function history_update_button_status() {
    window.dom.btnUndo.disabled = !history_validate_undo();
}

async function main_init_all() {
    console.log('[init] main_init_all start');
    try {
        app_emit_splash_progress(0, '正在初始化...');
        console.log('[init] progress 0 emitted');

        if (window.i18n) {
            console.log('[init] init_start begin');
            await window.i18n.init_start();
            console.log('[init] init_start done');
        }

        if (window.__TAURI__) {
            console.log('[init] checking oobe_active');
            const isOobeActive = await window.__TAURI__.core.invoke('oobe_check_active');
            console.log('[init] oobe_active:', isOobeActive);
            if (isOobeActive) {
                console.log('[init] OOBE active, returning');
                return;
            }
            console.log('[init] setup_pdf_file_open');
            window.main_setup_pdf_file_open();
        }

        if (!dom_init_all()) {
            console.error('[init] dom_init_all failed');
            throw new Error('DOM 初始化失败');
        }
        console.log('[init] dom_init_all ok');

        app_emit_splash_progress(1, '正在加载设置...');
        console.log('[init] progress 1 emitted');
        console.log('[init] dir_init_cache_path begin');
        await dir_init_cache_path();
        console.log('[init] dir_init_cache_path done');

        try {
            console.log('[init] cache_validate_auto_clear');
            const cleared = await window.__TAURI__.core.invoke('cache_validate_auto_clear');
            console.log('[init] cache_validate_auto_clear result:', cleared);
        } catch (e) {
            console.log('[init] cache_validate_auto_clear error:', e);
        }

        console.log('[init] settings_load_camera_config begin');
        await settings_load_camera_config();
        console.log('[init] settings_load_camera_config done');

        console.log('[init] calling canvas_init_all');
        canvas_init_all();
        console.log('[init] history_init_manager');
        history_init_manager({
            on_state_change: () => {
                history_update_button_status();
            }
        });
        console.log('[init] setup_all_events');
        window.main_setup_all_events();
        console.log('[init] draw_save_snapshot');
        await draw_save_snapshot();

        console.log('[init] resize listener');
        window.addEventListener('resize', window.main_handle_resize);

        app_emit_splash_progress(2, '正在加载主题...');
        console.log('[init] progress 2 emitted');

        app_emit_splash_progress(3, '正在初始化摄像头...');
        console.log('[init] progress 3 emitted');

        let is_camera_handled = false;

        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            try {
                console.log('[init] enumerateDevices');
                const devices = await navigator.mediaDevices.enumerateDevices();
                console.log('[init] devices found:', devices.length);
                if (!devices.some(d => d.kind === 'videoinput')) {
                    console.log('[init] no video devices, initWithoutCamera');
                    await window.main_init_without_camera(window.i18n?.format_translate('camera.notDetected') || '未检测到摄像头');
                    is_camera_handled = true;
                }
            } catch (e) {
                console.warn('[init] enumerateDevices error:', e);
            }
        }

        if (!is_camera_handled) {
            try {
                console.log('[init] init_camera');
                await window.main_init_camera();
                console.log('[init] init_camera done');
            } catch (error) {
                console.error('[init] init_camera error:', error?.name, error?.message);
                if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                    await window.main_init_without_camera(window.i18n?.format_translate('camera.notDetected') || '未检测到摄像头');
                } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                    await window.main_init_without_camera(window.i18n?.format_translate('camera.noPermission') || '无摄像头权限');
                } else {
                    console.error('[init] 摄像头初始化失败:', error);
                    await window.main_init_without_camera(window.i18n?.format_translate('camera.initFailed') || '摄像头初始化失败');
                }
            }
        }

        app_emit_splash_progress(4, '正在完成...');
        console.log('[init] progress 4 emitted');

        app_emit_splash_progress(5, '');
        console.log('[init] progress 5 emitted');

        if (window.__TAURI__) {
            try {
                console.log('[init] invoking window_hide_splashscreen');
                await window.__TAURI__.core.invoke('window_hide_splashscreen');
                console.log('[init] window_hide_splashscreen done');
            } catch (e) {
                console.log('[init] 关闭启动界面失败:', e);
            }
        }
    } catch (error) {
        console.error('初始化失败:', error);
        window.main_show_error_dialog(
            window.i18n?.format_translate('errors.initFailed') || '初始化失败',
            window.i18n?.format_translate('errors.initFailedDesc') || '应用初始化失败，请刷新页面重试'
        );
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main_init_all());
} else {
    main_init_all();
}

document.addEventListener('beforeunload', () => {
    window.main_delete_image_blob_urls?.();
    window.main_delete_all_pdf_blob_urls?.();
});

function main_setup_touch_events() {
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => {
        button.addEventListener('touchstart', function(e) {
            this.style.transform = 'scale(0.95)';
            this.style.transition = 'transform 0.1s ease';
        }, { passive: true });

        button.addEventListener('touchend', function(e) {
            this.style.transform = '';
        }, { passive: true });

        button.addEventListener('touchcancel', function(e) {
            this.style.transform = '';
        }, { passive: true });
    });

    window.main_setup_minimize_listeners();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main_setup_touch_events);
} else {
    main_setup_touch_events();
}