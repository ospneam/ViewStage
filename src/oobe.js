const invoke = window.__TAURI__?.core?.invoke;

(async function oobe_init_i18n() {
    if (window.i18n) {
        await window.i18n.init_start();
        oobe_update_page_texts();
    }
    
    if (window.ThemeManager) {
        await window.ThemeManager.init();
    }
})();

function oobe_update_page_texts() {
    if (!window.i18n) return;
    
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = window.i18n.format_translate(key);
        if (translation) {
            if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
                el.placeholder = translation;
            } else {
                el.textContent = translation;
            }
        }
    });
    
    document.title = window.i18n.format_translate('oobe.welcome') || '欢迎使用 ViewStage';
}

let oobe_carousel_interval = null;
let oobe_current_slide = 0;
let oobe_cached_settings = {};
let oobe_imported_settings = null;
let oobe_camera_preview_stream = null;
let oobe_blobs = [];
let oobe_animation_id = null;
let oobe_last_frame_time = 0;
const oobe_frame_interval = 33;

const oobe_default_config = {
    width: 1920,
    height: 1080,
    language: "zh-CN",
    theme: "simplify",
    defaultCamera: "",
    cameraWidth: 1280,
    cameraHeight: 720,
    pdfScale: 2,
    penColors: [
        {"r": 239, "g": 68, "b": 68},
        {"r": 249, "g": 115, "b": 22},
        {"r": 234, "g": 179, "b": 8},
        {"r": 34, "g": 197, "b": 94},
        {"r": 6, "g": 182, "b": 212},
        {"r": 59, "g": 130, "b": 246},
        {"r": 99, "g": 102, "b": 241},
        {"r": 168, "g": 85, "b": 247},
        {"r": 236, "g": 72, "b": 153},
        {"r": 244, "g": 63, "b": 94},
        {"r": 20, "g": 184, "b": 166},
        {"r": 100, "g": 116, "b": 139},
        {"r": 30, "g": 41, "b": 59},
        {"r": 0, "g": 0, "b": 0},
        {"r": 255, "g": 255, "b": 255}
    ]
};

function oobe_create_random_color() {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 55 + Math.floor(Math.random() * 25);
    const lightness = 45 + Math.floor(Math.random() * 20);
    return `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`;
}

function oobe_create_blobs() {
    const auroraBg = document.getElementById('auroraBg');
    if (!auroraBg) return;
    
    auroraBg.innerHTML = '';
    oobe_blobs = [];
    
    const blobCount = 5;
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    for (let i = 0; i < blobCount; i++) {
        const blob = document.createElement('div');
        blob.className = 'aurora-blob';
        
        const size = 400 + Math.random() * 300;
        blob.style.width = size + 'px';
        blob.style.height = size + 'px';
        blob.style.background = oobe_create_random_color();
        
        auroraBg.appendChild(blob);
        
        const x = Math.random() * width;
        const y = Math.random() * height;
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.5 + Math.random() * 1.5;
        
        oobe_blobs.push({
            element: blob,
            x: x,
            y: y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            speed: speed
        });
    }
}

function oobe_update_blobs(currentTime) {
    if (currentTime - oobe_last_frame_time < oobe_frame_interval) {
        oobe_animation_id = requestAnimationFrame(oobe_update_blobs);
        return;
    }
    oobe_last_frame_time = currentTime;
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    oobe_blobs.forEach(blob => {
        blob.x += blob.vx;
        blob.y += blob.vy;
        
        if (blob.x < -200 || blob.x > width + 200) {
            blob.vx = -blob.vx;
            blob.x = Math.max(-200, Math.min(width + 200, blob.x));
        }
        if (blob.y < -200 || blob.y > height + 200) {
            blob.vy = -blob.vy;
            blob.y = Math.max(-200, Math.min(height + 200, blob.y));
        }
        
        blob.element.style.transform = `translate(${blob.x}px, ${blob.y}px)`;
    });
    
    oobe_animation_id = requestAnimationFrame(oobe_update_blobs);
}

function oobe_start_aurora() {
    const auroraBg = document.getElementById('auroraBg');
    if (!auroraBg) return;
    
    if (oobe_blobs.length === 0) {
        oobe_create_blobs();
    }
    if (!oobe_animation_id) {
        oobe_last_frame_time = 0;
        oobe_update_blobs(performance.now());
    }
    auroraBg.classList.add('active');
}

function oobe_setup_carousel() {
    const images = document.querySelectorAll('.carousel-image');
    const carouselPage = document.getElementById('carouselPage');
    
    function oobe_show_slide(index) {
        images.forEach((img, i) => {
            img.classList.toggle('active', i === index);
        });
        oobe_current_slide = index;
    }
    
    function oobe_show_next_slide() {
        const next = (oobe_current_slide + 1) % images.length;
        oobe_show_slide(next);
    }
    
    oobe_carousel_interval = setInterval(oobe_show_next_slide, 6000);
    
    carouselPage.addEventListener('click', () => {
        oobe_show_page1();
    });
}

function oobe_show_page1() {
    clearInterval(oobe_carousel_interval);
    
    const carouselPage = document.getElementById('carouselPage');
    const page1 = document.getElementById('page1');
    const closeBtn = document.getElementById('closeBtn');
    
    carouselPage.style.opacity = '0';
    
    setTimeout(() => {
        carouselPage.style.display = 'none';
        page1.style.display = 'flex';
        closeBtn.style.display = 'flex';
        
        setTimeout(() => {
            page1.classList.add('visible');
        }, 10);
        
        oobe_setup_custom_selects();
        oobe_setup_page1_buttons();
        oobe_setup_close_button();
    }, 250);
}

function oobe_show_page2() {
    const page1 = document.getElementById('page1');
    const page2 = document.getElementById('page2');
    
    page1.classList.remove('visible');
    
    setTimeout(() => {
        page1.style.display = 'none';
        page2.style.display = 'flex';
        
        setTimeout(() => {
            page2.classList.add('visible');
        }, 10);
        
        oobe_setup_page2_buttons();
    }, 250);
}

function oobe_show_page1_from_page2() {
    const page1 = document.getElementById('page1');
    const page2 = document.getElementById('page2');
    
    page2.classList.remove('visible');
    
    setTimeout(() => {
        page2.style.display = 'none';
        page1.style.display = 'flex';
        
        setTimeout(() => {
            page1.classList.add('visible');
        }, 10);
    }, 250);
}

async function oobe_show_page3() {
    const page2 = document.getElementById('page2');
    const page3 = document.getElementById('page3');
    
    page2.classList.remove('visible');
    
    setTimeout(() => {
        page2.style.display = 'none';
        page3.style.display = 'flex';
        
        setTimeout(() => {
            page3.classList.add('visible');
        }, 10);
        
        oobe_init_resolution_select();
        oobe_setup_page3_buttons();
    }, 250);
}

function oobe_show_page2_from_page3() {
    const page2 = document.getElementById('page2');
    const page3 = document.getElementById('page3');
    
    page3.classList.remove('visible');
    
    setTimeout(() => {
        page3.style.display = 'none';
        page2.style.display = 'flex';
        
        setTimeout(() => {
            page2.classList.add('visible');
        }, 10);
    }, 250);
}

async function oobe_init_resolution_select() {
    const resolutions = await invoke('resolution_fetch_available');
    const resolutionOptions = document.getElementById('resolutionOptions');
    const resolutionSelected = document.getElementById('resolutionSelected');

    resolutionOptions.innerHTML = '';
    resolutions.forEach((res, index) => {
        const option = document.createElement('div');
        option.className = 'select-option' + (index === 0 ? ' selected' : '');
        option.dataset.value = `${res[0]}x${res[1]}`;
        option.textContent = res[2];
        resolutionOptions.appendChild(option);
    });

    if (resolutions.length > 0) {
        resolutionSelected.textContent = resolutions[0][2];
    }
    
    oobe_setup_custom_selects();
}

function oobe_setup_custom_selects() {
    document.querySelectorAll('.custom-select:not([data-initialized])').forEach(select => {
        select.setAttribute('data-initialized', 'true');
        
        const selected = select.querySelector('.select-selected');
        const options = select.querySelector('.select-options');

        selected.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-select').forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            select.classList.toggle('open');
        });

        options.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (option) {
                selected.textContent = option.textContent;
                options.querySelectorAll('.select-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                select.classList.remove('open');
                
                if (select.id === 'languageSelect' && window.i18n) {
                    const newLocale = option.dataset.value;
                    await window.i18n.update_locale(newLocale);
                    oobe_update_page_texts();
                }
                
                if (select.id === 'themeSelect' && window.ThemeManager) {
                    const themeName = option.dataset.value;
                    await window.ThemeManager.theme_update_active(themeName);
                }
                
                if (select.id === 'cameraSelect') {
                    try {
                        const deviceId = option.dataset.value;
                        await oobe_init_camera_resolution_select(deviceId);
                        oobe_hide_camera_preview();
                        oobe_init_camera_preview();
                    } catch (error) {
                        console.error('切换摄像头失败:', error);
                    }
                }
                
                if (select.id === 'cameraResolutionSelect') {
                    oobe_hide_camera_preview();
                    oobe_init_camera_preview();
                }
            }
        });
    });
}

let oobe_document_click_initialized = false;

function oobe_init_document_click_handler() {
    if (oobe_document_click_initialized) return;
    oobe_document_click_initialized = true;
    
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select').forEach(s => s.classList.remove('open'));
    });
}

function oobe_setup_page1_buttons() {
    document.getElementById('btnNext1').addEventListener('click', async () => {
        const languageSelect = document.getElementById('languageSelect');
        const themeSelect = document.getElementById('themeSelect');
        
        const language = languageSelect.querySelector('.select-option.selected').dataset.value;
        const theme = themeSelect.querySelector('.select-option.selected').dataset.value;

        oobe_cached_settings.language = language;
        oobe_cached_settings.theme = theme;
        oobe_show_page2();
    });
}

function oobe_setup_close_button() {
    document.getElementById('closeBtn').addEventListener('click', async () => {
        await invoke('app_submit_exit');
    });
}

function oobe_setup_page2_buttons() {
    document.getElementById('quickSetup').addEventListener('click', async () => {
        oobe_show_page3();
    });

    document.getElementById('importConfig').addEventListener('click', async () => {
        try {
            const { open } = window.__TAURI__.dialog;
            const { readTextFile } = window.__TAURI__.fs;
            
            const filePath = await open({
                filters: [{ name: 'JSON', extensions: ['json'] }]
            });
            
            if (filePath) {
                const jsonStr = await readTextFile(filePath);
                const settings = JSON.parse(jsonStr);
                
                if (oobe_validate_config(settings)) {
                    await invoke('settings_save_all', { settings });
                    console.log('设置已导入:', filePath);
                    oobe_show_page5();
                } else {
                    console.error('配置文件格式不正确');
                }
            }
        } catch (error) {
            console.error('导入设置失败:', error);
        }
    });

    document.getElementById('btnBack2').addEventListener('click', () => {
        oobe_show_page1_from_page2();
    });
}

function oobe_validate_config(config) {
    if (!config || typeof config !== 'object') return false;
    
    const requiredFields = ['width', 'height', 'language'];
    for (const field of requiredFields) {
        if (config[field] === undefined) {
            return false;
        }
    }
    
    return true;
}

function oobe_setup_page3_buttons() {
    document.getElementById('btnBack3').addEventListener('click', () => {
        oobe_show_page2_from_page3();
    });

    document.getElementById('btnNext3').addEventListener('click', async () => {
        const resolutionSelect = document.getElementById('resolutionSelect');
        
        const resolution = resolutionSelect.querySelector('.select-option.selected').dataset.value;
        const [width, height] = resolution.split('x').map(Number);
        
        oobe_cached_settings.width = width;
        oobe_cached_settings.height = height;
        
        oobe_show_page4();
    });
}

async function oobe_show_page4() {
    const page3 = document.getElementById('page3');
    const page4 = document.getElementById('page4');
    
    page3.classList.remove('visible');
    
    setTimeout(() => {
        page3.style.display = 'none';
        page4.style.display = 'flex';
        
        setTimeout(() => {
            page4.classList.add('visible');
        }, 10);
        
        oobe_init_camera_select();
        oobe_setup_page4_buttons();
    }, 250);
}

function oobe_show_page3_from_page4() {
    const page3 = document.getElementById('page3');
    const page4 = document.getElementById('page4');
    
    oobe_hide_camera_preview();
    
    page4.classList.remove('visible');
    
    setTimeout(() => {
        page4.style.display = 'none';
        page3.style.display = 'flex';
        
        setTimeout(() => {
            page3.classList.add('visible');
        }, 10);
    }, 250);
}

async function oobe_init_camera_select() {
    const cameraOptions = document.getElementById('cameraOptions');
    const cameraSelected = document.getElementById('cameraSelected');
    const cameraResolutionSelected = document.getElementById('cameraResolutionSelected');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');

        cameraOptions.innerHTML = '';
        
        if (videoDevices.length === 0) {
            cameraSelected.textContent = window.i18n?.format_translate('settings.noCameraDetected') || '未检测到摄像头';
            cameraResolutionSelected.textContent = '-';
            oobe_hide_camera_settings();
            return;
        }

        videoDevices.forEach((device, index) => {
            const option = document.createElement('div');
            option.className = 'select-option' + (index === 0 ? ' selected' : '');
            option.dataset.value = device.deviceId;
            const cameraText = window.i18n?.format_translate('camera.camera') || '摄像头';
            option.textContent = device.label || `${cameraText} ${index + 1}`;
            cameraOptions.appendChild(option);
        });

        const cameraText = window.i18n?.format_translate('camera.camera') || '摄像头';
        cameraSelected.textContent = videoDevices[0].label || `${cameraText} 1`;
        
        try {
            await oobe_init_camera_resolution_select(videoDevices[0].deviceId);
        } catch (e) {
            console.error('初始化分辨率选择失败:', e);
        }
        
        oobe_setup_custom_selects();
        oobe_init_camera_preview();
    } catch (error) {
        console.error('摄像头检测失败:', error.name);
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            cameraSelected.textContent = window.i18n?.format_translate('settings.noCameraPermission') || '无摄像头权限';
        } else if (error.name === 'NotFoundError') {
            cameraSelected.textContent = window.i18n?.format_translate('settings.noCameraDetected') || '未检测到摄像头';
        } else {
            cameraSelected.textContent = window.i18n?.format_translate('settings.getFailed') || '获取失败';
        }
        
        cameraResolutionSelected.textContent = '-';
        
        oobe_hide_camera_settings();
    }
}

function oobe_hide_camera_settings() {
    const cameraSettingItems = [
        document.querySelector('#cameraSelect')?.closest('.setting-item'),
        document.querySelector('#cameraResolutionSelect')?.closest('.setting-item'),
    ];
    
    cameraSettingItems.forEach(item => {
        if (item) {
            item.classList.add('disabled');
        }
    });
}

async function oobe_init_camera_preview() {
    const video = document.getElementById('cameraPreview');
    const placeholder = document.getElementById('cameraPreviewPlaceholder');
    const placeholderText = placeholder.querySelector('.placeholder-text');
    
    try {
        const cameraSelect = document.getElementById('cameraSelect');
        const cameraResolutionSelect = document.getElementById('cameraResolutionSelect');
        
        const cameraOption = cameraSelect.querySelector('.select-option.selected');
        const resolutionOption = cameraResolutionSelect.querySelector('.select-option.selected');
        
        const deviceId = cameraOption ? cameraOption.dataset.value : null;
        const width = resolutionOption ? parseInt(resolutionOption.dataset.width) : 1280;
        const height = resolutionOption ? parseInt(resolutionOption.dataset.height) : 720;
        
        const constraints = {
            video: {
                width: { ideal: width },
                height: { ideal: height }
            }
        };
        
        if (deviceId) {
            constraints.video.deviceId = { exact: deviceId };
        }
        
        oobe_camera_preview_stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = oobe_camera_preview_stream;
        video.classList.add('active');
        placeholder.classList.add('hidden');
    } catch (error) {
        console.error('摄像头预览初始化失败:', error);
        placeholderText.textContent = window.i18n?.format_translate('settings.noCameraDetected') || '未检测到摄像头';
    }
}

function oobe_hide_camera_preview() {
    if (oobe_camera_preview_stream) {
        oobe_camera_preview_stream.getTracks().forEach(track => track.stop());
        oobe_camera_preview_stream = null;
    }
}

async function oobe_fetch_supported_resolutions(deviceId) {
    const commonResolutions = [
        { w: 640, h: 480, label: '640 x 480 (VGA)', aspectRatio: '4:3' },
        { w: 800, h: 600, label: '800 x 600 (SVGA)', aspectRatio: '4:3' },
        { w: 1280, h: 720, label: '1280 x 720 (720p)', aspectRatio: '16:9' },
        { w: 1280, h: 960, label: '1280 x 960', aspectRatio: '4:3' },
        { w: 1600, h: 1200, label: '1600 x 1200', aspectRatio: '4:3' },
        { w: 1920, h: 1080, label: '1920 x 1080 (1080p)', aspectRatio: '16:9' },
        { w: 2560, h: 1440, label: '2560 x 1440 (2K)', aspectRatio: '16:9' },
        { w: 3840, h: 2160, label: '3840 x 2160 (4K)', aspectRatio: '16:9' }
    ];
    
    let stream = null;
    let track = null;
    const supportedResolutions = [];
    
    try {
        let constraints;
        if (deviceId) {
            constraints = { video: { deviceId: { exact: deviceId } } };
        } else {
            constraints = { video: true };
        }
        
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        track = stream.getVideoTracks()[0];
        
        const capabilities = track.getCapabilities();
        const maxWidth = capabilities.width?.max || 1920;
        const maxHeight = capabilities.height?.max || 1080;
        
        const testedResolutions = new Set();
        
        for (const res of commonResolutions) {
            if (res.w > maxWidth || res.h > maxHeight) continue;
            
            try {
                await track.applyConstraints({
                    width: { exact: res.w },
                    height: { exact: res.h }
                });
                
                const settings = track.getSettings();
                if (settings.width === res.w && settings.height === res.h) {
                    supportedResolutions.push({ ...res, actual: true });
                    testedResolutions.add(`${res.w}x${res.h}`);
                }
            } catch (e) {
                // 分辨率不支持，跳过
            }
        }
        
        try {
            await track.applyConstraints({
                width: { ideal: maxWidth },
                height: { ideal: maxHeight }
            });
            
            const maxSettings = track.getSettings();
            const actualMaxW = maxSettings.width;
            const actualMaxH = maxSettings.height;
            const maxKey = `${actualMaxW}x${actualMaxH}`;
            
            if (!testedResolutions.has(maxKey) && actualMaxW && actualMaxH) {
                const maxText = window.i18n?.format_translate('settings.maximum') || '最大';
                supportedResolutions.push({
                    w: actualMaxW,
                    h: actualMaxH,
                    label: `${actualMaxW} x ${actualMaxH} (${maxText})`,
                    actual: true
                });
            }
        } catch (e) {
            // 忽略错误
        }
        
    } catch (error) {
        console.error('检测摄像头分辨率失败:', error);
    } finally {
        if (track) {
            track.stop();
        }
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
        }
    }
    
    return supportedResolutions.sort((a, b) => (b.w * b.h) - (a.w * a.h));
}

async function oobe_init_camera_resolution_select(deviceId) {
    const cameraResolutionOptions = document.getElementById('cameraResolutionOptions');
    const cameraResolutionSelected = document.getElementById('cameraResolutionSelected');
    
    if (!cameraResolutionOptions || !cameraResolutionSelected) return;
    
    cameraResolutionOptions.innerHTML = '';
    
    const resolutions = await oobe_fetch_supported_resolutions(deviceId);
    
    if (resolutions.length === 0) {
        cameraResolutionSelected.textContent = window.i18n?.format_translate('settings.cannotGet') || '无法获取';
        return;
    }
    
    const defaultOption = resolutions.find(r => r.w === 1280 && r.h === 720) || resolutions[0];
    const defaultIndex = resolutions.indexOf(defaultOption);
    
    resolutions.forEach((res, index) => {
        const option = document.createElement('div');
        option.className = 'select-option' + (index === defaultIndex ? ' selected' : '');
        option.dataset.width = res.w;
        option.dataset.height = res.h;
        option.dataset.value = `${res.w}x${res.h}`;
        option.textContent = res.label;
        cameraResolutionOptions.appendChild(option);
    });
    
    cameraResolutionSelected.textContent = defaultOption.label;
}

function oobe_setup_page4_buttons() {
    document.getElementById('btnBack4').addEventListener('click', () => {
        oobe_show_page3_from_page4();
    });

    document.getElementById('btnNext4').addEventListener('click', async () => {
        const cameraSelect = document.getElementById('cameraSelect');
        const cameraResolutionSelect = document.getElementById('cameraResolutionSelect');
        
        const cameraOption = cameraSelect.querySelector('.select-option.selected');
        if (cameraOption) {
            oobe_cached_settings.defaultCamera = cameraOption.dataset.value;
        }
        
        const resolutionOption = cameraResolutionSelect.querySelector('.select-option.selected');
        if (resolutionOption) {
            oobe_cached_settings.cameraWidth = parseInt(resolutionOption.dataset.width);
            oobe_cached_settings.cameraHeight = parseInt(resolutionOption.dataset.height);
        } else {
            oobe_cached_settings.cameraWidth = 1280;
            oobe_cached_settings.cameraHeight = 720;
        }
        
        const finalSettings = oobe_save_merged_settings(oobe_cached_settings);
        
        oobe_hide_camera_preview();
        try {
            await invoke('device_detect_all');
            await invoke('settings_save_all', { settings: finalSettings });
            oobe_show_page5();
        } catch (error) {
            console.error('保存设置失败:', error);
        }
    });
}

function oobe_show_page5() {
    const currentPage = document.querySelector('.oobe-container.visible');
    const page5 = document.getElementById('page5');
    
    if (currentPage) {
        currentPage.classList.remove('visible');
    }
    
    setTimeout(() => {
        if (currentPage) {
            currentPage.style.display = 'none';
        }
        page5.style.display = 'flex';
        
        setTimeout(() => {
            page5.classList.add('visible');
        }, 10);
        
        oobe_setup_page5_buttons();
    }, 250);
}

function oobe_setup_page5_buttons() {
    document.getElementById('btnRestart').addEventListener('click', async () => {
        await invoke('oobe_submit_complete');
    });
}

function oobe_save_merged_settings(cached) {
    const base = oobe_imported_settings ? { ...oobe_imported_settings } : { ...oobe_default_config };
    
    return { ...base, ...cached };
}

oobe_start_aurora();
oobe_setup_carousel();
oobe_init_document_click_handler();
