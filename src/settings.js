/**
 * ViewStage 设置窗口脚本
 * 
 * 功能模块：
 * - 应用设置：语言、主题、启动选项
 * - Canvas调节：画布尺寸、帧率
 * - 信号源调节：摄像头选择、分辨率、镜像
 * - 关于：版本信息、检查更新
 */

document.addEventListener('DOMContentLoaded', async () => {
    await i18n.init_start();
    
    // ==================== 自定义弹窗函数 ====================
    function settings_show_dialog(title, message, type = 'info') {
        const existing = document.getElementById('settingsDialog');
        if (existing) existing.remove();
        
        const dialog = document.createElement('div');
        dialog.id = 'settingsDialog';
        dialog.className = 'settings-dialog-overlay';
        
        const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
        
        dialog.innerHTML = `
            <div class="settings-dialog">
                <div class="settings-dialog-icon">${icon}</div>
                <div class="settings-dialog-title">${title}</div>
                <div class="settings-dialog-message">${message}</div>
                <button class="settings-dialog-btn" id="settingsDialogClose">${window.i18n?.format_translate('common.confirm') || '确定'}</button>
            </div>
        `;
        document.body.appendChild(dialog);
        
        const closeBtn = document.getElementById('settingsDialogClose');
        closeBtn?.addEventListener('click', () => dialog.remove());
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.remove();
        });
    }
    
    // ==================== DOM 元素引用 ====================
    const btnClose = document.getElementById('btnClose');
    const auroraBg = document.getElementById('auroraBg');
    
    // ==================== 版本信息加载 ====================
    /**
     * 加载应用版本号和版权年份
     */
    async function settings_load_version() {
        if (window.__TAURI__) {
            try {
                const { invoke } = window.__TAURI__.core;
                const version = await invoke('app_fetch_version');
                
                const versionNumber = document.getElementById('versionNumber');
                const currentVersion = document.getElementById('currentVersion');
                const latestVersion = document.getElementById('latestVersion');
                
                if (versionNumber) versionNumber.textContent = version;
                if (currentVersion) currentVersion.textContent = version;
                if (latestVersion) latestVersion.textContent = version;
            } catch (error) {
                console.error('获取版本号失败:', error);
            }
        }
        
        const copyrightYear = document.getElementById('copyrightYear');
        if (copyrightYear) {
            copyrightYear.textContent = new Date().getFullYear();
        }
    }
    
    // ==================== 摄像头设置禁用 ====================
    function settings_hide_camera() {
        const cameraSettingItems = [
            document.querySelector('#cameraSelect')?.closest('.setting-item'),
            document.querySelector('#cameraResolutionSelect')?.closest('.setting-item'),
            document.querySelector('#mirrorToggle')?.closest('.setting-item'),
        ];
        
        cameraSettingItems.forEach(item => {
            if (item) {
                item.classList.add('disabled');
            }
        });
    }
    
    // ==================== 文档扫描设置禁用 ====================
    function settings_hide_doc_scan() {
        const docScanSettingItems = [
            document.querySelector('#showDocScanButtonToggle')?.closest('.setting-item'),
            document.querySelector('#scanQualitySelect')?.closest('.setting-item'),
            document.querySelector('#scanModeSelect')?.closest('.setting-item'),
            document.querySelector('#enhanceModeSelect')?.closest('.setting-item'),
        ];
        
        docScanSettingItems.forEach(item => {
            if (item) {
                item.classList.add('disabled');
            }
        });
        
        const modelCards = document.querySelectorAll('.model-card');
        modelCards.forEach(card => {
            card.classList.add('disabled');
        });
    }
    
    // ==================== 设置加载 ====================
    /**
     * 从后端加载设置并更新UI
     */
    async function settings_load_all() {
        if (window.__TAURI__) {
            try {
                const { invoke } = window.__TAURI__.core;
                const settings = await invoke('settings_fetch_all');
                
                const selectSelected = document.getElementById('selectSelected');
                const languageOptions = document.querySelectorAll('#selectOptions .select-option');
                
                if (settings.language && selectSelected) {
                    languageOptions.forEach(option => {
                        if (option.dataset.value === settings.language) {
                            selectSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                const resolutionSelected = document.getElementById('resolutionSelected');
                const resolutionOptionsContainer = document.getElementById('resolutionOptions');
                
                if (resolutionSelected && resolutionOptionsContainer) {
                    const availableResolutions = await invoke('resolution_fetch_available');
                    
                    resolutionOptionsContainer.innerHTML = '';
                    
                    availableResolutions.forEach(res => {
                        const [width, height, label] = res;
                        const option = document.createElement('div');
                        option.className = 'select-option';
                        option.dataset.value = `${width}x${height}`;
                        option.dataset.width = width;
                        option.dataset.height = height;
                        option.textContent = label;
                        resolutionOptionsContainer.appendChild(option);
                    });
                    
                    if (settings.width && settings.height) {
                        const resolution = `${settings.width}x${settings.height}`;
                        const resolutionOptions = document.querySelectorAll('#resolutionOptions .select-option');
                        resolutionOptions.forEach(option => {
                            if (option.dataset.value === resolution) {
                                resolutionSelected.textContent = option.textContent;
                                option.classList.add('selected');
                            } else {
                                option.classList.remove('selected');
                            }
                        });
                    }
                }
                
                const cameraSelected = document.getElementById('cameraSelected');
                const cameraOptionsContainer = document.getElementById('cameraOptions');
                const cameraResolutionSelected = document.getElementById('cameraResolutionSelected');
                
                let hasCameraPermission = false;
                let hasCamera = false;
                let cameraStream = null;
                
                try {
                    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
                    hasCameraPermission = true;
                    cameraStream.getTracks().forEach(t => t.stop());
                } catch (e) {
                    console.log('摄像头权限检测:', e.name);
                    hasCameraPermission = false;
                }
                
                const requestCameraPermissionItem = document.getElementById('requestCameraPermissionItem');
                const btnRequestCameraPermission = document.getElementById('btnRequestCameraPermission');
                
                if (cameraSelected && cameraOptionsContainer) {
                    try {
                        const devices = await navigator.mediaDevices.enumerateDevices();
                        const videoDevices = devices.filter(device => device.kind === 'videoinput');
                        hasCamera = videoDevices.length > 0;
                        
                        cameraOptionsContainer.innerHTML = '';
                        
                        if (!hasCameraPermission) {
                            cameraSelected.textContent = window.i18n?.format_translate('settings.noCameraPermission') || '无摄像头权限';
                            cameraResolutionSelected.textContent = '-';
                            settings_hide_camera();
                            settings_hide_doc_scan();
                            if (requestCameraPermissionItem && btnRequestCameraPermission) {
                                requestCameraPermissionItem.style.display = 'flex';
                                btnRequestCameraPermission.textContent = window.i18n?.format_translate('settings.requestCameraPermission') || '获取摄像头权限';
                                btnRequestCameraPermission.dataset.mode = 'request';
                            }
                        } else if (videoDevices.length === 0) {
                            cameraSelected.textContent = window.i18n?.format_translate('settings.noCameraDetected') || '未检测到摄像头';
                            cameraResolutionSelected.textContent = '-';
                            settings_hide_camera();
                            settings_hide_doc_scan();
                            if (requestCameraPermissionItem && btnRequestCameraPermission) {
                                requestCameraPermissionItem.style.display = 'none';
                            }
                        } else {
                            videoDevices.forEach((device, index) => {
                                const option = document.createElement('div');
                                option.className = 'select-option';
                                option.dataset.value = device.deviceId;
                                
                                const cameraText = window.i18n?.format_translate('camera.camera') || '摄像头';
                                let label = device.label || `${cameraText} ${index + 1}`;
                                if (label.includes('back') || label.includes('后置') || label.includes('rear')) {
                                    label = `${window.i18n?.format_translate('camera.rearCamera') || '后置'}: ${label}`;
                                } else if (label.includes('front') || label.includes('前置') || label.includes('user')) {
                                    label = `${window.i18n?.format_translate('camera.frontCamera') || '前置'}: ${label}`;
                                }
                                
                                option.textContent = label;
                                cameraOptionsContainer.appendChild(option);
                            });
                            
                            if (settings.defaultCamera) {
                                const cameraOptions = cameraOptionsContainer.querySelectorAll('.select-option');
                                let found = false;
                                cameraOptions.forEach(option => {
                                    if (option.dataset.value === settings.defaultCamera) {
                                        cameraSelected.textContent = option.textContent;
                                        option.classList.add('selected');
                                        found = true;
                                    } else {
                                        option.classList.remove('selected');
                                    }
                                });
                                
                                if (!found && cameraOptions.length > 0) {
                                    cameraSelected.textContent = cameraOptions[0].textContent;
                                    cameraOptions[0].classList.add('selected');
                                }
                            } else {
                                const cameraOptions = cameraOptionsContainer.querySelectorAll('.select-option');
                                if (cameraOptions.length > 0) {
                                    cameraSelected.textContent = cameraOptions[0].textContent;
                                    cameraOptions[0].classList.add('selected');
                                }
                            }
                            
                            if (requestCameraPermissionItem && btnRequestCameraPermission) {
                                requestCameraPermissionItem.style.display = 'flex';
                                btnRequestCameraPermission.textContent = window.i18n?.format_translate('settings.revokeCameraPermission') || '撤销授权';
                                btnRequestCameraPermission.dataset.mode = 'revoke';
                            }
                        }
                    } catch (error) {
                        console.error('获取摄像头列表失败:', error);
                        cameraSelected.textContent = window.i18n?.format_translate('settings.getFailed') || '获取失败';
                        cameraResolutionSelected.textContent = '-';
                        settings_hide_camera();
                    }
                }
                
                const cameraResolutionOptionsContainer = document.getElementById('cameraResolutionOptions');
                
                if (cameraResolutionSelected && cameraResolutionOptionsContainer && hasCameraPermission && hasCamera) {
                    const selectedCameraOption = cameraOptionsContainer.querySelector('.select-option.selected');
                    const selectedCameraId = selectedCameraOption ? selectedCameraOption.dataset.value : null;
                    try {
                        await settings_update_camera_resolution_options(selectedCameraId, settings.cameraWidth, settings.cameraHeight);
                    } catch (e) {
                        console.error('初始化分辨率选择失败:', e);
                    }
                }
                
                // PDF 输出分辨率设置
                const pdfScaleSelected = document.getElementById('pdfScaleSelected');
                const pdfScaleOptionsContainer = document.getElementById('pdfScaleOptions');
                
                if (pdfScaleSelected && pdfScaleOptionsContainer) {
                    const savedPdfScale = settings.pdfScale || 2;
                    const pdfScaleOptions = pdfScaleOptionsContainer.querySelectorAll('.select-option');
                    pdfScaleOptions.forEach(option => {
                        if (parseFloat(option.dataset.value) === savedPdfScale) {
                            pdfScaleSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // DPR 限制设置
                const dprLimitSelected = document.getElementById('dprLimitSelected');
                const dprLimitOptionsContainer = document.getElementById('dprLimitOptions');

                if (dprLimitSelected && dprLimitOptionsContainer) {
                    const savedDprLimit = settings.dprLimit !== undefined ? settings.dprLimit : 2;
                    const dprLimitOptions = dprLimitOptionsContainer.querySelectorAll('.select-option');
                    dprLimitOptions.forEach(option => {
                        if (parseFloat(option.dataset.value) === savedDprLimit) {
                            dprLimitSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }

                // 画笔颜色设置
                const DEFAULT_COLORS = [
                    '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
                    '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e',
                    '#14b8a6', '#64748b', '#1e293b', '#000000', '#ffffff'
                ];
                const savedColors = settings.penColors || DEFAULT_COLORS;
                
                // 颜色格式转换函数
                function settings_calc_color_to_hex(color) {
                    if (typeof color === 'string') {
                        return color;
                    }
                    if (typeof color === 'object' && color.r !== undefined) {
                        return settings_calc_rgb_to_hex(color.r, color.g, color.b);
                    }
                    return '#000000';
                }
                
                function settings_calc_rgb_to_hex(r, g, b) {
                    return '#' + [r, g, b].map(x => {
                        const hex = x.toString(16);
                        return hex.length === 1 ? '0' + hex : hex;
                    }).join('');
                }
                
                for (let i = 1; i <= 15; i++) {
                    const colorBtn = document.querySelector(`.color-edit-item[data-index="${i - 1}"] .color-edit-btn`);
                    if (colorBtn) {
                        const color = savedColors[i - 1] || DEFAULT_COLORS[i - 1];
                        const hexColor = settings_calc_color_to_hex(color);
                        colorBtn.style.backgroundColor = hexColor;
                        colorBtn.dataset.color = hexColor;
                    }
                }
                
                // 镜像设置
                const mirrorToggle = document.getElementById('mirrorToggle');
                if (mirrorToggle) {
                    try {
                        const isMirrored = await invoke('mirror_fetch_state');
                        mirrorToggle.checked = isMirrored;
                    } catch (error) {
                        console.error('获取镜像状态失败:', error);
                        mirrorToggle.checked = false;
                    }
                }
                
                // 降噪帧数设置
                const denoiseFrameCount = settings.denoiseFrameCount || 3;
                const denoiseFrameSelected = document.getElementById('denoiseFrameSelected');
                const denoiseFrameOptions = document.querySelectorAll('#denoiseFrameOptions .select-option');
                if (denoiseFrameSelected && denoiseFrameOptions.length > 0) {
                    denoiseFrameOptions.forEach(option => {
                        if (parseInt(option.dataset.value) === denoiseFrameCount) {
                            denoiseFrameSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 降噪强度设置
                const denoiseStrength = settings.denoiseStrength || 'medium';
                const denoiseStrengthSelected = document.getElementById('denoiseStrengthSelected');
                const denoiseStrengthOptions = document.querySelectorAll('#denoiseStrengthOptions .select-option');
                if (denoiseStrengthSelected && denoiseStrengthOptions.length > 0) {
                    denoiseStrengthOptions.forEach(option => {
                        if (option.dataset.value === denoiseStrength) {
                            denoiseStrengthSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 帧率模式设置
                const frameRateModeGroup = document.getElementById('frameRateModeGroup');
                if (frameRateModeGroup) {
                    const mode = settings.frameRateMode || 'adaptive';
                    frameRateModeGroup.dataset.active = mode;
                    const buttons = frameRateModeGroup.querySelectorAll('.option-btn');
                    buttons.forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.value === mode);
                    });
                    if (window.batchDrawManager) {
                        window.batchDrawManager.batch_draw_update_frame_rate(mode);
                    }
                }
                
                // 钢笔效果模式设置
                const penEffectModeGroup = document.getElementById('penEffectModeGroup');
                if (penEffectModeGroup) {
                    const mode = settings.penEffectMode || 'limited';
                    penEffectModeGroup.dataset.active = mode;
                    const buttons = penEffectModeGroup.querySelectorAll('.option-btn');
                    buttons.forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.value === mode);
                    });
                    if (window.DRAW_CONFIG) {
                        window.DRAW_CONFIG.penEffectMode = mode;
                        if (window.realPenManager) {
                            window.realPenManager.invalidate_cache();
                        }
                    }
                }
                
                // 显示文档扫描按钮设置
                const showDocScanButtonToggle = document.getElementById('showDocScanButtonToggle');
                if (showDocScanButtonToggle) {
                    showDocScanButtonToggle.checked = settings.showDocScanButton !== false;
                }
                
                // 扫描质量设置
                const scanQualitySelected = document.getElementById('scanQualitySelected');
                const scanQualityOptionsContainer = document.getElementById('scanQualityOptions');
                if (scanQualitySelected && scanQualityOptionsContainer) {
                    const savedScanQuality = settings.scanQuality || 'standard';
                    const scanQualityOptions = scanQualityOptionsContainer.querySelectorAll('.select-option');
                    scanQualityOptions.forEach(option => {
                        if (option.dataset.value === savedScanQuality) {
                            scanQualitySelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 扫描模式设置
                const scanModeSelected = document.getElementById('scanModeSelected');
                const scanModeOptionsContainer = document.getElementById('scanModeOptions');
                if (scanModeSelected && scanModeOptionsContainer) {
                    const savedScanMode = settings.scanMode || 'auto';
                    const scanModeOptions = scanModeOptionsContainer.querySelectorAll('.select-option');
                    scanModeOptions.forEach(option => {
                        if (option.dataset.value === savedScanMode) {
                            scanModeSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 增强模式设置
                const enhanceModeSelected = document.getElementById('enhanceModeSelected');
                const enhanceModeOptionsContainer = document.getElementById('enhanceModeOptions');
                if (enhanceModeSelected && enhanceModeOptionsContainer) {
                    const savedEnhanceMode = settings.enhanceMode || 'auto';
                    const enhanceModeOptions = enhanceModeOptionsContainer.querySelectorAll('.select-option');
                    enhanceModeOptions.forEach(option => {
                        if (option.dataset.value === savedEnhanceMode) {
                            enhanceModeSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 主题设置
                const themeSelected = document.getElementById('themeSelected');
                const themeOptionsContainer = document.getElementById('themeOptions');
                if (themeSelected && themeOptionsContainer) {
                    const savedTheme = settings.theme || 'simplify';
                    const themeOptions = themeOptionsContainer.querySelectorAll('.select-option');
                    themeOptions.forEach(option => {
                        if (option.dataset.value === savedTheme) {
                            themeSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 默认旋转角度设置
                const defaultRotationSelected = document.getElementById('defaultRotationSelected');
                const defaultRotationOptionsContainer = document.getElementById('defaultRotationOptions');
                if (defaultRotationSelected && defaultRotationOptionsContainer) {
                    const savedRotation = settings.defaultRotation || 0;
                    const rotationOptions = defaultRotationOptionsContainer.querySelectorAll('.select-option');
                    rotationOptions.forEach(option => {
                        if (parseInt(option.dataset.value) === savedRotation) {
                            defaultRotationSelected.textContent = option.textContent;
                            option.classList.add('selected');
                        } else {
                            option.classList.remove('selected');
                        }
                    });
                }
                
                // 文件关联设置
                const assocPdf = document.getElementById('assocPdf');
                if (assocPdf) {
                    try {
                        const isDefault = await invoke('filetype_validate_pdf_default');
                        
                        if (isDefault) {
                            assocPdf.checked = settings.fileAssociations === true;
                        } else {
                            assocPdf.checked = false;
                            
                            if (settings.fileAssociations === true) {
                                await settings_save_all_local({ fileAssociations: false });
                            }
                        }
                    } catch (error) {
                        console.error('检查默认程序失败:', error);
                        assocPdf.checked = false;
                    }
                }
                
                const assocWord = document.getElementById('assocWord');
                if (assocWord) {
                    assocWord.checked = settings.wordAssociations === true;
                }
                
                const autoClearCacheDays = settings.autoClearCacheDays ?? 15;
                const autoClearCacheSelected = document.getElementById('autoClearCacheSelected');
                const autoClearCacheOptions = document.getElementById('autoClearCacheOptions');
                if (autoClearCacheSelected && autoClearCacheOptions) {
                    const options = autoClearCacheOptions.querySelectorAll('.select-option');
                    options.forEach(opt => {
                        if (parseInt(opt.dataset.value) === autoClearCacheDays) {
                            autoClearCacheSelected.textContent = opt.textContent;
                        }
                    });
                }
                
                return settings;
            } catch (error) {
                console.error('加载设置失败:', error);
                return {};
            }
        }
        return {};
    }
    
    async function settings_save_all_local(settings) {
        if (window.__TAURI__) {
            try {
                const { invoke } = window.__TAURI__.core;
                const { emit } = window.__TAURI__.event;
                await invoke('settings_save_all', { settings });
                
                await emit('settings-changed', settings);
                
                return true;
            } catch (error) {
                console.error('保存设置失败:', error);
                return false;
            }
        }
        return false;
    }
    
    async function settings_fetch_supported_resolutions(deviceId) {
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
            if (deviceId && deviceId !== '') {
                constraints = { video: { deviceId: { exact: deviceId } } };
            } else {
                constraints = { video: true };
            }
            
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            track = stream.getVideoTracks()[0];
            
            const capabilities = track.getCapabilities();
            const maxWidth = capabilities.width?.max || 1920;
            const maxHeight = capabilities.height?.max || 1080;
            
            for (const res of commonResolutions) {
                if (res.w <= maxWidth && res.h <= maxHeight) {
                    supportedResolutions.push({ ...res, actual: true });
                }
            }
            
            const maxText = window.i18n?.format_translate('settings.maximum') || '最大';
            supportedResolutions.push({
                w: maxWidth,
                h: maxHeight,
                label: `${maxWidth} x ${maxHeight} (${maxText})`,
                actual: true
            });
            
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
        
        const uniqueResolutions = [];
        const seen = new Set();
        for (const res of supportedResolutions) {
            const key = `${res.w}x${res.h}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResolutions.push(res);
            }
        }
        
        return uniqueResolutions.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    }
    
    async function settings_update_camera_resolution_options(deviceId, savedWidth, savedHeight) {
        const cameraResolutionOptionsContainer = document.getElementById('cameraResolutionOptions');
        const cameraResolutionSelected = document.getElementById('cameraResolutionSelected');
        
        if (!cameraResolutionOptionsContainer || !cameraResolutionSelected) return false;
        
        cameraResolutionOptionsContainer.innerHTML = '';
        
        const resolutions = await settings_fetch_supported_resolutions(deviceId);
        
        if (resolutions.length === 0) {
            cameraResolutionSelected.textContent = window.i18n?.format_translate('settings.cannotGet') || '无法获取';
            return false;
        }
        
        resolutions.forEach(res => {
            const option = document.createElement('div');
            option.className = 'select-option';
            option.dataset.width = res.w;
            option.dataset.height = res.h;
            option.dataset.value = `${res.w}x${res.h}`;
            option.textContent = res.label;
            cameraResolutionOptionsContainer.appendChild(option);
        });
        
        const targetWidth = savedWidth || 1280;
        const targetHeight = savedHeight || 720;
        const targetRes = `${targetWidth}x${targetHeight}`;
        
        const resOptions = cameraResolutionOptionsContainer.querySelectorAll('.select-option');
        let found = false;
        
        resOptions.forEach(option => {
            if (option.dataset.value === targetRes) {
                cameraResolutionSelected.textContent = option.textContent;
                option.classList.add('selected');
                found = true;
            }
        });
        
        if (!found && resOptions.length > 0) {
            const defaultOption = Array.from(resOptions).find(opt => 
                opt.dataset.value === '1280x720'
            ) || resOptions[0];
            cameraResolutionSelected.textContent = defaultOption.textContent;
            defaultOption.classList.add('selected');
        }
        
        return true;
    }
    
    settings_load_version();
    settings_load_all().then(() => {
        settings_setup_resolution_options();
    });
    
    const languageSelect = document.getElementById('languageSelect');
    const selectSelected = document.getElementById('selectSelected');
    const languageOptions = document.querySelectorAll('#selectOptions .select-option');
    
    if (languageSelect && selectSelected) {
        selectSelected.addEventListener('click', () => {
            languageSelect.classList.toggle('open');
        });
        
        languageOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const value = option.dataset.value;
                selectSelected.textContent = option.textContent;
                
                languageOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                
                languageSelect.classList.remove('open');
                
                const saved = await settings_save_all_local({ language: value });
                
                if (saved) {
                    const restartModal = document.getElementById('restartModal');
                    if (restartModal) {
                        restartModal.classList.add('active');
                    }
                } else {
                    settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', window.i18n?.format_translate('settings.saveFailedRetry') || '保存设置失败，请重试', 'error');
                }
            });
        });
        
        document.addEventListener('click', (e) => {
            if (!languageSelect.contains(e.target)) {
                languageSelect.classList.remove('open');
            }
        });
    }
    
    const resolutionSelect = document.getElementById('resolutionSelect');
    const resolutionSelected = document.getElementById('resolutionSelected');
    
    if (resolutionSelect && resolutionSelected) {
        resolutionSelected.addEventListener('click', () => {
            resolutionSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!resolutionSelect.contains(e.target)) {
                resolutionSelect.classList.remove('open');
            }
        });
    }
    
    function settings_setup_resolution_options() {
        const resolutionOptions = document.querySelectorAll('#resolutionOptions .select-option');
        
        resolutionOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const width = parseInt(option.dataset.width);
                const height = parseInt(option.dataset.height);
                resolutionSelected.textContent = option.textContent;
                
                resolutionOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                
                resolutionSelect.classList.remove('open');
                
                const saved = await settings_save_all_local({ width, height });
                
                if (saved) {
                    // 显示重启提示
                    const restartModal = document.getElementById('restartModal');
                    const modalMessage = restartModal?.querySelector('.modal-message');
                    if (modalMessage) {
                        modalMessage.textContent = window.i18n?.format_translate('settings.resolutionChanged') || '分辨率设置已更改，需要重启应用才能生效。';
                    }
                    if (restartModal) {
                        restartModal.classList.add('active');
                    }
                } else {
                    settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', window.i18n?.format_translate('settings.saveFailedRetry') || '保存设置失败，请重试', 'error');
                }
            });
        });
    }
    
    const cameraSelect = document.getElementById('cameraSelect');
    const cameraSelected = document.getElementById('cameraSelected');
    
    if (cameraSelect && cameraSelected) {
        cameraSelected.addEventListener('click', () => {
            cameraSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!cameraSelect.contains(e.target)) {
                cameraSelect.classList.remove('open');
            }
        });
        
        cameraSelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const value = option.dataset.value;
            cameraSelected.textContent = option.textContent;
            
            const cameraOptions = cameraSelect.querySelectorAll('.select-option');
            cameraOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            cameraSelect.classList.remove('open');
            
            try {
                const saved = await settings_save_all_local({ defaultCamera: value });
                
                if (saved) {
                    const currentResolutionOption = document.querySelector('#cameraResolutionOptions .select-option.selected');
                    const currentWidth = currentResolutionOption ? parseInt(currentResolutionOption.dataset.width) : null;
                    const currentHeight = currentResolutionOption ? parseInt(currentResolutionOption.dataset.height) : null;
                    
                    const success = await settings_update_camera_resolution_options(value, currentWidth, currentHeight);
                    
                    if (success) {
                        const newResolutionOption = document.querySelector('#cameraResolutionOptions .select-option.selected');
                        if (newResolutionOption) {
                            const newWidth = parseInt(newResolutionOption.dataset.width);
                            const newHeight = parseInt(newResolutionOption.dataset.height);
                            if (newWidth && newHeight) {
                                await settings_save_all_local({ cameraWidth: newWidth, cameraHeight: newHeight });
                            }
                        }
                    }
                } else {
                    settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', window.i18n?.format_translate('settings.saveFailedRetry') || '保存设置失败，请重试', 'error');
                }
            } catch (error) {
                console.error('切换摄像头失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', String(error), 'error');
            }
        });
    }
    
    // 摄像头分辨率选择
    const cameraResolutionSelect = document.getElementById('cameraResolutionSelect');
    const cameraResolutionSelected = document.getElementById('cameraResolutionSelected');
    
    if (cameraResolutionSelect && cameraResolutionSelected) {
        cameraResolutionSelected.addEventListener('click', () => {
            cameraResolutionSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!cameraResolutionSelect.contains(e.target)) {
                cameraResolutionSelect.classList.remove('open');
            }
        });
        
        cameraResolutionSelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const width = parseInt(option.dataset.width);
            const height = parseInt(option.dataset.height);
            cameraResolutionSelected.textContent = option.textContent;
            
            const resOptions = cameraResolutionSelect.querySelectorAll('.select-option');
            resOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            cameraResolutionSelect.classList.remove('open');
            
            try {
                await settings_save_all_local({ cameraWidth: width, cameraHeight: height });
            } catch (error) {
                console.error('保存分辨率设置失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', String(error), 'error');
            }
        });
    }
    
    // PDF 输出分辨率选择
    const pdfScaleSelect = document.getElementById('pdfScaleSelect');
    const pdfScaleSelected = document.getElementById('pdfScaleSelected');
    
    if (pdfScaleSelect && pdfScaleSelected) {
        pdfScaleSelected.addEventListener('click', () => {
            pdfScaleSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!pdfScaleSelect.contains(e.target)) {
                pdfScaleSelect.classList.remove('open');
            }
        });
        
        pdfScaleSelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const value = parseFloat(option.dataset.value);
            pdfScaleSelected.textContent = option.textContent;
            
            const pdfScaleOptions = pdfScaleSelect.querySelectorAll('.select-option');
            pdfScaleOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            pdfScaleSelect.classList.remove('open');
            
            await settings_save_all_local({ pdfScale: value });
        });
    }
    
    // DPR 限制选择
    const dprLimitSelect = document.getElementById('dprLimitSelect');
    const dprLimitSelected = document.getElementById('dprLimitSelected');
    
    if (dprLimitSelect && dprLimitSelected) {
        dprLimitSelected.addEventListener('click', () => {
            dprLimitSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!dprLimitSelect.contains(e.target)) {
                dprLimitSelect.classList.remove('open');
            }
        });
        
        dprLimitSelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const value = parseFloat(option.dataset.value);
            dprLimitSelected.textContent = option.textContent;
            
            const dprLimitOptions = dprLimitSelect.querySelectorAll('.select-option');
            dprLimitOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            dprLimitSelect.classList.remove('open');
            
            const saved = await settings_save_all_local({ dprLimit: value });
            
            if (saved) {
                const restartModal = document.getElementById('restartModal');
                const modalMessage = restartModal?.querySelector('.modal-message');
                if (modalMessage) {
                    modalMessage.textContent = window.i18n?.format_translate('settings.dprChanged') || '画面精度已更改，建议重启应用以确保完全生效。';
                }
                if (restartModal) {
                    restartModal.classList.add('active');
                }
            } else {
                settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', window.i18n?.format_translate('settings.saveFailedRetry') || '保存设置失败，请重试', 'error');
            }
        });
    }
    
    // 自定义颜色选择器
    const colorPickerPopup = document.getElementById('colorPickerPopup');
    const colorPickerSV = document.getElementById('colorPickerSV');
    const colorPickerSVCursor = document.getElementById('colorPickerSVCursor');
    const colorPickerHue = document.getElementById('colorPickerHue');
    const colorPickerHueCursor = document.getElementById('colorPickerHueCursor');
    const colorPickerPresets = document.getElementById('colorPickerPresets');
    const colorPickerPreview = document.getElementById('colorPickerPreview');
    const colorPickerInput = document.getElementById('colorPickerInput');
    const colorPickerConfirm = document.getElementById('colorPickerConfirm');
    const colorPickerCancel = document.getElementById('colorPickerCancel');
    
    let current_color_index = 0;
    let current_hue = 0;
    let current_saturation = 100;
    let current_value = 100;
    let color_picker_overlay = null;
    
    const PRESET_COLORS = [
        '#e74c3c', '#e91e63', '#9b59b6', '#673ab7',
        '#3498db', '#00bcd4', '#1abc9c', '#2ecc71',
        '#8bc34a', '#f39c12', '#ff5722', '#795548',
        '#34495e', '#000000', '#ffffff'
    ];
    
    function settings_init_color_picker_presets() {
        if (!colorPickerPresets) return;
        colorPickerPresets.innerHTML = '';
        PRESET_COLORS.forEach(color => {
            const preset = document.createElement('div');
            preset.className = 'color-picker-preset';
            preset.style.backgroundColor = color;
            preset.addEventListener('click', () => {
                const rgb = settings_calc_hex_to_rgb(color);
                if (rgb) {
                    const hsv = settings_calc_rgb_to_hsv(rgb.r, rgb.g, rgb.b);
                    current_hue = hsv.h;
                    current_saturation = hsv.s;
                    current_value = hsv.v;
                    settings_update_color_picker_ui();
                }
            });
            colorPickerPresets.appendChild(preset);
        });
    }
    
    function settings_calc_hsv_to_rgb(h, s, v) {
        s /= 100;
        v /= 100;
        const c = v * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255)
        };
    }
    
    function settings_calc_rgb_to_hsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = max === 0 ? 0 : (max - min) / max, v = max;
        if (max !== min) {
            const d = max - min;
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (max === g) h = ((b - r) / d + 2) * 60;
            else h = ((r - g) / d + 4) * 60;
        }
        return { h, s: s * 100, v: v * 100 };
    }
    
    function settings_calc_rgb_to_hex(r, g, b) {
        return '#' + [r, g, b].map(x => {
            const hex = x.toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }
    
    function settings_calc_hex_to_rgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }
    
    function settings_calc_current_hex_color() {
        const rgb = settings_calc_hsv_to_rgb(current_hue, current_saturation, current_value);
        return settings_calc_rgb_to_hex(rgb.r, rgb.g, rgb.b);
    }
    
    function settings_update_color_picker_ui() {
        const rgb = settings_calc_hsv_to_rgb(current_hue, current_saturation, current_value);
        const hex = settings_calc_rgb_to_hex(rgb.r, rgb.g, rgb.b);
        
        if (colorPickerSVCursor) {
            const x = (current_saturation / 100) * 240;
            const y = (1 - current_value / 100) * 180;
            colorPickerSVCursor.style.left = x + 'px';
            colorPickerSVCursor.style.top = y + 'px';
        }
        
        if (colorPickerHueCursor) {
            const hueX = (current_hue / 360) * 240;
            colorPickerHueCursor.style.left = hueX + 'px';
        }
        
        if (colorPickerSV) {
            const hueRgb = settings_calc_hsv_to_rgb(current_hue, 100, 100);
            const hueHex = settings_calc_rgb_to_hex(hueRgb.r, hueRgb.g, hueRgb.b);
            colorPickerSV.style.backgroundColor = hueHex;
        }
        
        if (colorPickerPreview) {
            colorPickerPreview.style.backgroundColor = hex;
        }
        
        if (colorPickerInput) {
            colorPickerInput.value = hex;
        }
    }
    
    function settings_show_color_picker(index) {
        current_color_index = index;
        const colorBtn = document.querySelector(`.color-edit-item[data-index="${index}"] .color-edit-btn`);
        if (colorBtn) {
            const hex = colorBtn.dataset.color || '#3498db';
            const rgb = settings_calc_hex_to_rgb(hex);
            if (rgb) {
                const hsv = settings_calc_rgb_to_hsv(rgb.r, rgb.g, rgb.b);
                current_hue = hsv.h;
                current_saturation = hsv.s;
                current_value = hsv.v;
            }
        }
        
        settings_update_color_picker_ui();
        settings_init_color_picker_presets();
        
        if (colorPickerPopup) {
            colorPickerPopup.classList.add('active');
        }
        
        if (!color_picker_overlay) {
            color_picker_overlay = document.createElement('div');
            color_picker_overlay.className = 'color-picker-overlay';
            color_picker_overlay.addEventListener('click', settings_hide_color_picker);
            document.body.appendChild(color_picker_overlay);
        }
        color_picker_overlay.style.display = 'block';
    }
    
    function settings_hide_color_picker() {
        if (colorPickerPopup) {
            colorPickerPopup.classList.remove('active');
        }
        if (color_picker_overlay) {
            color_picker_overlay.style.display = 'none';
        }
    }
    
    function settings_handle_sv_drag(e) {
        if (!colorPickerSV) return;
        const rect = colorPickerSV.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        let x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        let y = Math.max(0, Math.min(clientY - rect.top, rect.height));
        current_saturation = (x / rect.width) * 100;
        current_value = (1 - y / rect.height) * 100;
        settings_update_color_picker_ui();
    }
    
    function settings_handle_hue_drag(e) {
        if (!colorPickerHue) return;
        const rect = colorPickerHue.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        let x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        current_hue = (x / rect.width) * 360;
        settings_update_color_picker_ui();
    }
    
    if (colorPickerSV) {
        let is_sv_dragging = false;
        colorPickerSV.addEventListener('mousedown', (e) => { is_sv_dragging = true; settings_handle_sv_drag(e); });
        colorPickerSV.addEventListener('touchstart', (e) => { is_sv_dragging = true; settings_handle_sv_drag(e); }, { passive: true });
        document.addEventListener('mousemove', (e) => { if (is_sv_dragging) settings_handle_sv_drag(e); });
        document.addEventListener('touchmove', (e) => { if (is_sv_dragging) settings_handle_sv_drag(e); }, { passive: true });
        document.addEventListener('mouseup', () => { is_sv_dragging = false; });
        document.addEventListener('touchend', () => { is_sv_dragging = false; });
    }
    
    if (colorPickerHue) {
        let is_hue_dragging = false;
        colorPickerHue.addEventListener('mousedown', (e) => { is_hue_dragging = true; settings_handle_hue_drag(e); });
        colorPickerHue.addEventListener('touchstart', (e) => { is_hue_dragging = true; settings_handle_hue_drag(e); }, { passive: true });
        document.addEventListener('mousemove', (e) => { if (is_hue_dragging) settings_handle_hue_drag(e); });
        document.addEventListener('touchmove', (e) => { if (is_hue_dragging) settings_handle_hue_drag(e); }, { passive: true });
        document.addEventListener('mouseup', () => { is_hue_dragging = false; });
        document.addEventListener('touchend', () => { is_hue_dragging = false; });
    }
    
    if (colorPickerInput) {
        colorPickerInput.addEventListener('input', () => {
            const hex = colorPickerInput.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
                const rgb = settings_calc_hex_to_rgb(hex);
                if (rgb) {
                    const hsv = settings_calc_rgb_to_hsv(rgb.r, rgb.g, rgb.b);
                    current_hue = hsv.h;
                    current_saturation = hsv.s;
                    current_value = hsv.v;
                    settings_update_color_picker_ui();
                }
            }
        });
    }
    
    if (colorPickerConfirm) {
        colorPickerConfirm.addEventListener('click', async () => {
            const hex = settings_calc_current_hex_color();
            const colorBtn = document.querySelector(`.color-edit-item[data-index="${current_color_index}"] .color-edit-btn`);
            if (colorBtn) {
                colorBtn.style.backgroundColor = hex;
                colorBtn.dataset.color = hex;
            }
            
            const colors = [];
            for (let i = 0; i < 15; i++) {
                const btn = document.querySelector(`.color-edit-item[data-index="${i}"] .color-edit-btn`);
                const hexColor = btn ? btn.dataset.color : '#000000';
                const rgb = settings_calc_hex_to_rgb(hexColor);
                colors.push(rgb || { r: 0, g: 0, b: 0 });
            }
            await settings_save_all_local({ penColors: colors });
            
            settings_hide_color_picker();
        });
    }
    
    if (colorPickerCancel) {
        colorPickerCancel.addEventListener('click', settings_hide_color_picker);
    }
    
    document.querySelectorAll('.color-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.color-edit-item');
            if (item) {
                const index = parseInt(item.dataset.index);
                settings_show_color_picker(index);
            }
        });
    });
    
    // 镜像开关
    const mirrorToggle = document.getElementById('mirrorToggle');
    if (mirrorToggle) {
        mirrorToggle.addEventListener('change', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                await invoke('mirror_update_state', { enabled: mirrorToggle.checked });
            } catch (error) {
                console.error('设置镜像状态失败:', error);
            }
        });
    }
    
    // 降噪帧数选择
    const denoiseFrameSelect = document.getElementById('denoiseFrameSelect');
    const denoiseFrameSelected = document.getElementById('denoiseFrameSelected');
    
    if (denoiseFrameSelect && denoiseFrameSelected) {
        denoiseFrameSelected.addEventListener('click', () => {
            denoiseFrameSelect.classList.toggle('open');
        });
        
        const denoiseFrameOptions = document.querySelectorAll('#denoiseFrameOptions .select-option');
        denoiseFrameOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const value = option.dataset.value;
                denoiseFrameSelected.textContent = option.textContent;
                
                denoiseFrameOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                
                denoiseFrameSelect.classList.remove('open');
                
                await settings_save_all_local({ denoiseFrameCount: parseInt(value) });
            });
        });
    }
    
    // 降噪强度选择
    const denoiseStrengthSelect = document.getElementById('denoiseStrengthSelect');
    const denoiseStrengthSelected = document.getElementById('denoiseStrengthSelected');
    
    if (denoiseStrengthSelect && denoiseStrengthSelected) {
        denoiseStrengthSelected.addEventListener('click', () => {
            denoiseStrengthSelect.classList.toggle('open');
        });
        
        const denoiseStrengthOptions = document.querySelectorAll('#denoiseStrengthOptions .select-option');
        denoiseStrengthOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const value = option.dataset.value;
                denoiseStrengthSelected.textContent = option.textContent;
                
                denoiseStrengthOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                
                denoiseStrengthSelect.classList.remove('open');
                
                await settings_save_all_local({ denoiseStrength: value });
            });
        });
    }
    
    // 帧率模式选择
    const frameRateModeGroup = document.getElementById('frameRateModeGroup');
    if (frameRateModeGroup) {
        const buttons = frameRateModeGroup.querySelectorAll('.option-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.value;
                frameRateModeGroup.dataset.active = mode;
                buttons.forEach(b => b.classList.toggle('active', b === btn));
                await settings_save_all_local({ frameRateMode: mode });
                if (window.batchDrawManager) {
                    window.batchDrawManager.batch_draw_update_frame_rate(mode);
                }
            });
        });
    }
    
    // 钢笔效果模式选择
    const penEffectModeGroup = document.getElementById('penEffectModeGroup');
    if (penEffectModeGroup) {
        const buttons = penEffectModeGroup.querySelectorAll('.option-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.value;
                penEffectModeGroup.dataset.active = mode;
                buttons.forEach(b => b.classList.toggle('active', b === btn));
                await settings_save_all_local({ penEffectMode: mode });
                if (window.DRAW_CONFIG) {
                    window.DRAW_CONFIG.penEffectMode = mode;
                    if (window.realPenManager) {
                        window.realPenManager.invalidate_cache();
                    }
                }
            });
        });
    }
    
    // 显示文档扫描按钮开关
    const showDocScanButtonToggle = document.getElementById('showDocScanButtonToggle');
    if (showDocScanButtonToggle) {
        showDocScanButtonToggle.addEventListener('change', async () => {
            await settings_save_all_local({ showDocScanButton: showDocScanButtonToggle.checked });
        });
    }
    
    // 扫描质量选择
    const scanQualitySelect = document.getElementById('scanQualitySelect');
    const scanQualitySelected = document.getElementById('scanQualitySelected');
    if (scanQualitySelect && scanQualitySelected) {
        scanQualitySelected.addEventListener('click', () => {
            scanQualitySelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!scanQualitySelect.contains(e.target)) {
                scanQualitySelect.classList.remove('open');
            }
        });
        
        scanQualitySelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const value = option.dataset.value;
            scanQualitySelected.textContent = option.textContent;
            
            const scanQualityOptions = scanQualitySelect.querySelectorAll('.select-option');
            scanQualityOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            scanQualitySelect.classList.remove('open');
            
            await settings_save_all_local({ scanQuality: value });
        });
    }
    
    // 扫描模式选择
    const scanModeSelect = document.getElementById('scanModeSelect');
    const scanModeSelected = document.getElementById('scanModeSelected');
    if (scanModeSelect && scanModeSelected) {
        scanModeSelected.addEventListener('click', () => {
            scanModeSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!scanModeSelect.contains(e.target)) {
                scanModeSelect.classList.remove('open');
            }
        });
        
        scanModeSelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const value = option.dataset.value;
            scanModeSelected.textContent = option.textContent;
            
            const scanModeOptions = scanModeSelect.querySelectorAll('.select-option');
            scanModeOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            scanModeSelect.classList.remove('open');
            
            await settings_save_all_local({ scanMode: value });
        });
    }
    
    // 增强模式选择
    const enhanceModeSelect = document.getElementById('enhanceModeSelect');
    const enhanceModeSelected = document.getElementById('enhanceModeSelected');
    if (enhanceModeSelect && enhanceModeSelected) {
        enhanceModeSelected.addEventListener('click', () => {
            enhanceModeSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!enhanceModeSelect.contains(e.target)) {
                enhanceModeSelect.classList.remove('open');
            }
        });
        
        enhanceModeSelect.addEventListener('click', async (e) => {
            const option = e.target.closest('.select-option');
            if (!option) return;
            
            const value = option.dataset.value;
            enhanceModeSelected.textContent = option.textContent;
            
            const enhanceModeOptions = enhanceModeSelect.querySelectorAll('.select-option');
            enhanceModeOptions.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            enhanceModeSelect.classList.remove('open');
            
            await settings_save_all_local({ enhanceMode: value });
        });
    }
    
    // 主题选择
    const themeSelect = document.getElementById('themeSelect');
    const themeSelected = document.getElementById('themeSelected');
    
    if (themeSelect && themeSelected) {
        themeSelected.addEventListener('click', () => {
            themeSelect.classList.toggle('open');
        });
        
        const themeOptions = document.querySelectorAll('#themeOptions .select-option');
        themeOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const value = option.dataset.value;
                themeSelected.textContent = option.textContent;
                
                themeOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                
                themeSelect.classList.remove('open');
                
                const saved = await settings_save_all_local({ theme: value });
                if (saved) {
                    const restartModal = document.getElementById('restartModal');
                    if (restartModal) {
                        restartModal.classList.add('active');
                    }
                }
            });
        });
        
        document.addEventListener('click', (e) => {
            if (!themeSelect.contains(e.target)) {
                themeSelect.classList.remove('open');
            }
        });
    }
    
    // 默认旋转角度选择
    const defaultRotationSelect = document.getElementById('defaultRotationSelect');
    const defaultRotationSelected = document.getElementById('defaultRotationSelected');
    
    if (defaultRotationSelect && defaultRotationSelected) {
        defaultRotationSelected.addEventListener('click', () => {
            defaultRotationSelect.classList.toggle('open');
        });
        
        const rotationOptions = document.querySelectorAll('#defaultRotationOptions .select-option');
        rotationOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const value = parseInt(option.dataset.value);
                defaultRotationSelected.textContent = option.textContent;
                
                rotationOptions.forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                
                defaultRotationSelect.classList.remove('open');
                
                await settings_save_all_local({ defaultRotation: value });
            });
        });
        
        document.addEventListener('click', (e) => {
            if (!defaultRotationSelect.contains(e.target)) {
                defaultRotationSelect.classList.remove('open');
            }
        });
    }
    
    // 默认打开方式复选框
    const assocPdf = document.getElementById('assocPdf');
    if (assocPdf) {
        assocPdf.addEventListener('change', async () => {
            const { invoke } = window.__TAURI__.core;
            
            if (assocPdf.checked) {
                try {
                    await invoke('filetype_set_icons');
                    await settings_save_all_local({ fileAssociations: true });
                    settings_show_dialog(
                        window.i18n?.format_translate('common.success') || '成功',
                        window.i18n?.format_translate('settings.pdfDefaultSetSuccess') || 'PDF 已设置为默认打开方式',
                        'success'
                    );
                } catch (e) {
                    console.error('设置 PDF 默认打开方式失败:', e);
                    assocPdf.checked = false;
                    settings_show_dialog(
                        window.i18n?.format_translate('common.error') || '错误',
                        window.i18n?.format_translate('settings.pdfDefaultSetFailed') || '设置 PDF 默认打开方式失败，请手动在系统设置中设置',
                        'error'
                    );
                }
            } else {
                try {
                    await invoke('filetype_delete_icons');
                    await settings_save_all_local({ fileAssociations: false });
                    settings_show_dialog(
                        window.i18n?.format_translate('common.success') || '成功',
                        window.i18n?.format_translate('settings.pdfDefaultRemoved') || '已取消 PDF 默认打开方式设置',
                        'success'
                    );
                } catch (e) {
                    console.error('取消 PDF 默认打开方式失败:', e);
                    settings_show_dialog(
                        window.i18n?.format_translate('common.error') || '错误',
                        String(e),
                        'error'
                    );
                }
            }
        });
    }
    
    const assocWord = document.getElementById('assocWord');
    if (assocWord) {
        assocWord.addEventListener('change', async () => {
            const { invoke } = window.__TAURI__.core;
            
            if (assocWord.checked) {
                try {
                    await invoke('filetype_set_icons');
                    await settings_save_all_local({ wordAssociations: true });
                    settings_show_dialog(
                        window.i18n?.format_translate('common.success') || '成功',
                        window.i18n?.format_translate('settings.wordDefaultSetSuccess') || 'Word 文档已设置为默认打开方式',
                        'success'
                    );
                } catch (e) {
                    console.error('设置 Word 默认打开方式失败:', e);
                    assocWord.checked = false;
                    settings_show_dialog(
                        window.i18n?.format_translate('common.error') || '错误',
                        window.i18n?.format_translate('settings.wordDefaultSetFailed') || '设置 Word 默认打开方式失败，请手动在系统设置中设置',
                        'error'
                    );
                }
            } else {
                try {
                    await invoke('filetype_delete_icons');
                    await settings_save_all_local({ wordAssociations: false });
                    settings_show_dialog(
                        window.i18n?.format_translate('common.success') || '成功',
                        window.i18n?.format_translate('settings.wordDefaultRemoved') || '已取消 Word 文档默认打开方式设置',
                        'success'
                    );
                } catch (e) {
                    console.error('取消 Word 默认打开方式失败:', e);
                    settings_show_dialog(
                        window.i18n?.format_translate('common.error') || '错误',
                        String(e),
                        'error'
                    );
                }
            }
        });
    }
    
    const btnReset = document.getElementById('btnReset');
    const modalOverlay = document.getElementById('modalOverlay');
    const modalCancel = document.getElementById('modalCancel');
    const modalConfirm = document.getElementById('modalConfirm');
    
    // 导出设置
    const btnExportSettings = document.getElementById('btnExportSettings');
    if (btnExportSettings && window.__TAURI__) {
        btnExportSettings.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const { save } = window.__TAURI__.dialog;
                const { writeTextFile } = window.__TAURI__.fs;
                
                const settings = await invoke('settings_fetch_all');
                const jsonStr = JSON.stringify(settings, null, 2);
                
                const filePath = await save({
                    defaultPath: 'viewstage-settings.json',
                    filters: [{ name: 'JSON', extensions: ['json'] }]
                });
                
                if (filePath) {
                    await writeTextFile(filePath, jsonStr);
                    console.log('设置已导出:', filePath);
                }
            } catch (error) {
                console.error('导出设置失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.exportFailed') || '导出失败', String(error), 'error');
            }
        });
    }
    
    // 导入设置
    const btnImportSettings = document.getElementById('btnImportSettings');
    if (btnImportSettings && window.__TAURI__) {
        btnImportSettings.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const { open } = window.__TAURI__.dialog;
                const { readTextFile } = window.__TAURI__.fs;
                
                const filePath = await open({
                    filters: [{ name: 'JSON', extensions: ['json'] }]
                });
                
                if (filePath) {
                    const jsonStr = await readTextFile(filePath);
                    const settings = JSON.parse(jsonStr);
                    
                await invoke('settings_save_all', { settings });
                    console.log('设置已导入:', filePath);
                    
                    // 重新加载页面以应用新设置
                    location.reload();
                }
            } catch (error) {
                console.error('导入设置失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.importFailed') || '导入失败', String(error), 'error');
            }
        });
    }
    
    if (btnReset && modalOverlay && window.__TAURI__) {
        btnReset.addEventListener('click', () => {
            const modalTitle = modalOverlay.querySelector('.modal-title');
            const modalMessage = modalOverlay.querySelector('.modal-message');
            if (modalTitle && modalMessage) {
                modalTitle.textContent = window.i18n?.format_translate('settings.confirmReset') || '确认重置';
                modalMessage.textContent = window.i18n?.format_translate('settings.resetWarning') || '确定要重置应用吗？这将删除所有设置并重启应用。';
            }
            modalConfirm.dataset.action = 'reset';
            modalOverlay.classList.add('active');
        });
        
        modalCancel.addEventListener('click', () => {
            modalOverlay.classList.remove('active');
            delete modalConfirm.dataset.action;
        });
        
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                modalOverlay.classList.remove('active');
                delete modalConfirm.dataset.action;
            }
        });
        
        modalConfirm.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const { getCurrentWebview } = window.__TAURI__.webview;
                const webview = getCurrentWebview();
                await webview.clearAllBrowsingData();
                await invoke('settings_delete_all');
            } catch (error) {
                console.error('重置失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', String(error), 'error');
                modalOverlay.classList.remove('active');
            }
        });
    }
    
    // 缓存管理
    const cacheSizeEl = document.getElementById('cacheSize');
    const btnClearCache = document.getElementById('btnClearCache');
    
    async function settings_update_cache_size() {
        if (!window.__TAURI__) return;
        try {
            const { invoke } = window.__TAURI__.core;
            const size = await invoke('cache_fetch_size');
            if (cacheSizeEl) {
                if (size === 0) {
                    cacheSizeEl.textContent = '(0 B)';
                } else if (size < 1024) {
                    cacheSizeEl.textContent = `(${size} B)`;
                } else if (size < 1024 * 1024) {
                    cacheSizeEl.textContent = `(${(size / 1024).toFixed(1)} KB)`;
                } else if (size < 1024 * 1024 * 1024) {
                    cacheSizeEl.textContent = `(${(size / 1024 / 1024).toFixed(1)} MB)`;
                } else {
                    cacheSizeEl.textContent = `(${(size / 1024 / 1024 / 1024).toFixed(2)} GB)`;
                }
            }
        } catch (error) {
            console.error('获取缓存大小失败:', error);
        }
    }
    
    settings_update_cache_size();
    
    if (btnClearCache && window.__TAURI__) {
        btnClearCache.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const result = await invoke('cache_delete_all');
                settings_show_dialog(window.i18n?.format_translate('settings.clearComplete') || '清除完成', result, 'success');
                settings_update_cache_size();
            } catch (error) {
                console.error('清除缓存失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.clearFailed') || '清除失败', String(error), 'error');
            }
        });
    }
    
    // 自动清除缓存设置
    const autoClearCacheSelect = document.getElementById('autoClearCacheSelect');
    const autoClearCacheSelected = document.getElementById('autoClearCacheSelected');
    const autoClearCacheOptions = document.getElementById('autoClearCacheOptions');
    
    if (autoClearCacheSelect && autoClearCacheSelected && autoClearCacheOptions && window.__TAURI__) {
        autoClearCacheSelected.addEventListener('click', () => {
            autoClearCacheSelect.classList.toggle('open');
        });
        
        document.addEventListener('click', (e) => {
            if (!autoClearCacheSelect.contains(e.target)) {
                autoClearCacheSelect.classList.remove('open');
            }
        });
        
        autoClearCacheOptions.querySelectorAll('.select-option').forEach(option => {
            option.addEventListener('click', async () => {
                const days = parseInt(option.dataset.value);
                autoClearCacheSelected.textContent = option.textContent;
                autoClearCacheSelect.classList.remove('open');
                
                if (days === 0) {
                    settings_show_dialog(window.i18n?.format_translate('common.warning') || '警告', window.i18n?.format_translate('errors.autoClearWarning') || '若关闭自动清理可能导致C盘异常，强烈建议打开自动清理功能', 'error');
                }
                await settings_save_all_local({ autoClearCacheDays: days });
            });
        });
    }
    
    // 打开日志目录
    const btnOpenLogDir = document.getElementById('btnOpenLogDir');
    if (btnOpenLogDir && window.__TAURI__) {
        btnOpenLogDir.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const { openPath } = window.__TAURI__.opener;
                
                const configDir = await invoke('dir_fetch_config');
                const logDir = configDir + '\\log';
                
                await openPath(logDir);
            } catch (error) {
                console.error('打开日志目录失败:', error);
                settings_show_dialog(window.i18n?.format_translate('common.error') || '错误', window.i18n?.format_translate('settings.openLogDirFailed') || '打开日志目录失败', 'error');
            }
        });
    }
    
    // ==================== 模型资源管理 ====================
    const dbnetModelStatus = document.getElementById('dbnetModelStatus');
    const btnDownloadDbnetModel = document.getElementById('btnDownloadDbnetModel');
    const btnDeleteDbnetModel = document.getElementById('btnDeleteDbnetModel');
    const downloadProgress = document.getElementById('downloadProgress');
    const downloadProgressBar = document.getElementById('downloadProgressBar');
    const downloadProgressText = document.getElementById('downloadProgressText');
    
    async function settings_validate_dbnet_model() {
        if (!window.__TAURI__) return;
        
        try {
            const { invoke } = window.__TAURI__.core;
            const modelInfo = await invoke('model_fetch_dbnet_info');
            
            if (modelInfo.exists) {
                dbnetModelStatus.textContent = window.i18n?.format_translate('settings.modelInstalledWithSize', { size: modelInfo.size_mb.toFixed(2) }) || `已安装 (${modelInfo.size_mb.toFixed(2)} MB)`;
                dbnetModelStatus.style.color = '#27ae60';
                btnDownloadDbnetModel.style.display = 'none';
                btnDeleteDbnetModel.style.display = 'inline-block';
            } else {
                dbnetModelStatus.textContent = window.i18n?.format_translate('settings.modelNotInstalled') || '未安装';
                dbnetModelStatus.style.color = '#e74c3c';
                btnDownloadDbnetModel.style.display = 'inline-block';
                btnDeleteDbnetModel.style.display = 'none';
            }
        } catch (error) {
            console.error('检查模型状态失败:', error);
            dbnetModelStatus.textContent = window.i18n?.format_translate('settings.modelCheckFailed') || '检查失败';
            dbnetModelStatus.style.color = '#e74c3c';
        }
    }
    
    if (btnDownloadDbnetModel && window.__TAURI__) {
        btnDownloadDbnetModel.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const { getCurrentWindow } = window.__TAURI__.window;
                
                btnDownloadDbnetModel.disabled = true;
                btnDownloadDbnetModel.textContent = '下载中...';
                downloadProgress.style.display = 'block';
                
                const currentWindow = getCurrentWindow();
                
                const unlisten = await currentWindow.listen('download-progress', (event) => {
                    const progress = event.payload;
                    downloadProgressBar.style.width = progress + '%';
                    downloadProgressText.textContent = progress + '%';
                });
                
                await invoke('model_download_dbnet');
                
                unlisten();
                
                downloadProgress.style.display = 'none';
                btnDownloadDbnetModel.disabled = false;
                btnDownloadDbnetModel.textContent = '下载';
                
                settings_show_dialog('成功', 'DBNet 模型下载成功！', 'success');
                
                await settings_validate_dbnet_model();
            } catch (error) {
                console.error('下载模型失败:', error);
                downloadProgress.style.display = 'none';
                btnDownloadDbnetModel.disabled = false;
                btnDownloadDbnetModel.textContent = '下载';
                settings_show_dialog('错误', `下载失败: ${error}`, 'error');
            }
        });
    }
    
    if (btnDeleteDbnetModel && window.__TAURI__) {
        btnDeleteDbnetModel.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                
                const confirmed = confirm('确定要删除 DBNet 模型吗？删除后需要重新下载。');
                if (!confirmed) return;
                
                await invoke('model_delete_dbnet');
                
                settings_show_dialog('成功', 'DBNet 模型已删除！', 'success');
                
                await settings_validate_dbnet_model();
            } catch (error) {
                console.error('删除模型失败:', error);
                settings_show_dialog('错误', `删除失败: ${error}`, 'error');
            }
        });
    }
    
    // ==================== UVDoc 模型管理 ====================
    const uvdocModelStatus = document.getElementById('uvdocModelStatus');
    const btnDownloadUvdocModel = document.getElementById('btnDownloadUvdocModel');
    const btnDeleteUvdocModel = document.getElementById('btnDeleteUvdocModel');
    const uvdocDownloadProgress = document.getElementById('uvdocDownloadProgress');
    const uvdocDownloadProgressBar = document.getElementById('uvdocDownloadProgressBar');
    const uvdocDownloadProgressText = document.getElementById('uvdocDownloadProgressText');
    
    async function settings_validate_uvdoc_model() {
        if (!window.__TAURI__) return;
        
        try {
            const { invoke } = window.__TAURI__.core;
            const info = await invoke('model_fetch_uvdoc_info');
            
            if (info.exists) {
                uvdocModelStatus.textContent = window.i18n?.format_translate('settings.modelInstalledWithSize', { size: info.size_mb.toFixed(1) }) || `已安装 (${info.size_mb.toFixed(1)} MB)`;
                uvdocModelStatus.style.color = '#27ae60';
                btnDownloadUvdocModel.style.display = 'none';
                btnDeleteUvdocModel.style.display = 'inline-block';
            } else {
                uvdocModelStatus.textContent = window.i18n?.format_translate('settings.modelNotInstalled') || '未安装';
                uvdocModelStatus.style.color = '#e74c3c';
                btnDownloadUvdocModel.style.display = 'inline-block';
                btnDeleteUvdocModel.style.display = 'none';
            }
        } catch (error) {
            console.error('检查UVDoc模型状态失败:', error);
            uvdocModelStatus.textContent = window.i18n?.format_translate('settings.modelCheckFailed') || '检查失败';
            uvdocModelStatus.style.color = '#e74c3c';
        }
    }
    
    if (btnDownloadUvdocModel && window.__TAURI__) {
        btnDownloadUvdocModel.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                const { getCurrentWindow } = window.__TAURI__.window;
                
                btnDownloadUvdocModel.disabled = true;
                btnDownloadUvdocModel.textContent = '下载中...';
                uvdocDownloadProgress.style.display = 'block';
                
                const currentWindow = getCurrentWindow();
                
                const unlisten = await currentWindow.listen('uvdoc-download-progress', (event) => {
                    const progress = event.payload;
                    uvdocDownloadProgressBar.style.width = progress + '%';
                    uvdocDownloadProgressText.textContent = progress + '%';
                });
                
                await invoke('model_download_uvdoc');
                
                unlisten();
                
                uvdocDownloadProgress.style.display = 'none';
                btnDownloadUvdocModel.disabled = false;
                btnDownloadUvdocModel.textContent = '下载';
                
                settings_show_dialog('成功', 'UVDoc 模型下载成功！', 'success');
                
                await settings_validate_uvdoc_model();
            } catch (error) {
                console.error('下载UVDoc模型失败:', error);
                uvdocDownloadProgress.style.display = 'none';
                btnDownloadUvdocModel.disabled = false;
                btnDownloadUvdocModel.textContent = '下载';
                settings_show_dialog('错误', `下载失败: ${error}`, 'error');
            }
        });
    }
    
    if (btnDeleteUvdocModel && window.__TAURI__) {
        btnDeleteUvdocModel.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                
                const confirmed = confirm('确定要删除 UVDoc 模型吗？删除后需要重新下载。');
                if (!confirmed) return;
                
                await invoke('model_delete_uvdoc');
                
                settings_show_dialog('成功', 'UVDoc 模型已删除！', 'success');
                
                await settings_validate_uvdoc_model();
            } catch (error) {
                console.error('删除UVDoc模型失败:', error);
                settings_show_dialog('错误', `删除失败: ${error}`, 'error');
            }
        });
    }
    
    settings_validate_uvdoc_model();
    
    settings_validate_dbnet_model();
    
    // DexiNed 模型检查和管理
    const dexinedModelStatus = document.getElementById('dexinedModelStatus');
    const btnImportDexinedModel = document.getElementById('btnImportDexinedModel');
    const btnDeleteDexinedModel = document.getElementById('btnDeleteDexinedModel');
    
    async function settings_validate_dexined_model() {
        if (!window.__TAURI__ || !dexinedModelStatus) return;
        
        try {
            const { invoke } = window.__TAURI__.core;
            const exists = await invoke('model_check_dexined');
            
            if (exists) {
                dexinedModelStatus.textContent = window.i18n?.format_translate('settings.modelInstalled') || '已安装';
                dexinedModelStatus.style.color = '#27ae60';
                if (btnImportDexinedModel) btnImportDexinedModel.style.display = 'none';
                if (btnDeleteDexinedModel) btnDeleteDexinedModel.style.display = 'inline-block';
            } else {
                dexinedModelStatus.textContent = window.i18n?.format_translate('settings.modelNotInstalled') || '未安装';
                dexinedModelStatus.style.color = '#e74c3c';
                if (btnImportDexinedModel) btnImportDexinedModel.style.display = 'inline-block';
                if (btnDeleteDexinedModel) btnDeleteDexinedModel.style.display = 'none';
            }
        } catch (error) {
            console.error('检查 DexiNed 模型状态失败:', error);
            dexinedModelStatus.textContent = window.i18n?.format_translate('settings.modelCheckFailed') || '检查失败';
            dexinedModelStatus.style.color = '#e74c3c';
        }
    }
    
    // 导入 DexiNed 模型
    if (btnImportDexinedModel && window.__TAURI__) {
        btnImportDexinedModel.addEventListener('click', async () => {
            try {
                const { open } = window.__TAURI__.dialog;
                const { invoke } = window.__TAURI__.core;
                
                const selected = await open({
                    multiple: false,
                    filters: [{
                        name: 'ONNX Model',
                        extensions: ['onnx']
                    }]
                });
                
                if (selected) {
                    btnImportDexinedModel.disabled = true;
                    btnImportDexinedModel.textContent = '导入中...';
                    
                    await invoke('model_import_dexined', { sourcePath: selected });
                    
                    btnImportDexinedModel.disabled = false;
                    btnImportDexinedModel.textContent = '导入';
                    
                    settings_show_dialog('成功', 'DexiNed 模型导入成功！', 'success');
                    await settings_validate_dexined_model();
                }
            } catch (error) {
                console.error('导入 DexiNed 模型失败:', error);
                btnImportDexinedModel.disabled = false;
                btnImportDexinedModel.textContent = '导入';
                settings_show_dialog('错误', `导入失败: ${error}`, 'error');
            }
        });
    }
    
    // 删除 DexiNed 模型
    if (btnDeleteDexinedModel && window.__TAURI__) {
        btnDeleteDexinedModel.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                
                const confirmed = confirm('确定要删除 DexiNed 模型吗？');
                if (!confirmed) return;
                
                await invoke('model_delete_dexined');
                
                settings_show_dialog('成功', 'DexiNed 模型已删除！', 'success');
                await settings_validate_dexined_model();
            } catch (error) {
                console.error('删除 DexiNed 模型失败:', error);
                settings_show_dialog('错误', `删除失败: ${error}`, 'error');
            }
        });
    }
    
    settings_validate_dexined_model();
    
    const restartModal = document.getElementById('restartModal');
    const restartLater = document.getElementById('restartLater');
    const restartNow = document.getElementById('restartNow');
    
    if (restartModal && window.__TAURI__) {
        restartLater.addEventListener('click', () => {
            restartModal.classList.remove('active');
        });
        
        restartModal.addEventListener('click', (e) => {
            if (e.target === restartModal) {
                restartModal.classList.remove('active');
            }
        });
        
        restartNow.addEventListener('click', async () => {
            try {
                const { invoke } = window.__TAURI__.core;
                await invoke('app_restart_process');
            } catch (error) {
                console.error('重启失败:', error);
                settings_show_dialog(window.i18n?.format_translate('settings.saveFailed') || '保存失败', String(error), 'error');
            }
        });
    }
    
    let blobs = [];
    let animationId = null;
    let lastFrameTime = 0;
    const frameInterval = 33; // ~30 FPS
    
    function settings_calc_random_color() {
        const hue = Math.floor(Math.random() * 360);
        const saturation = 55 + Math.floor(Math.random() * 25);
        const lightness = 45 + Math.floor(Math.random() * 20);
        return `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`;
    }
    
    function settings_create_blobs() {
        if (!auroraBg) return;
        
        auroraBg.innerHTML = '';
        blobs = [];
        
        const blobCount = 5;
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        for (let i = 0; i < blobCount; i++) {
            const blob = document.createElement('div');
            blob.className = 'aurora-blob';
            
            const size = 400 + Math.random() * 300;
            blob.style.width = size + 'px';
            blob.style.height = size + 'px';
            blob.style.background = settings_calc_random_color();
            
            auroraBg.appendChild(blob);
            
            const x = Math.random() * width;
            const y = Math.random() * height;
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.5 + Math.random() * 1.5;
            
            blobs.push({
                element: blob,
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                speed: speed
            });
        }
    }
    
    function settings_update_blobs(currentTime) {
        if (currentTime - lastFrameTime < frameInterval) {
            animationId = requestAnimationFrame(settings_update_blobs);
            return;
        }
        lastFrameTime = currentTime;
        
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        blobs.forEach(blob => {
            blob.x += blob.vx;
            blob.y += blob.vy;
            
            // 边界反弹
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
        
        animationId = requestAnimationFrame(settings_update_blobs);
    }
    
    function settings_start_aurora() {
        if (blobs.length === 0) {
            settings_create_blobs();
        }
        if (!animationId) {
            lastFrameTime = 0;
            settings_update_blobs(performance.now());
        }
    }
    
    function settings_hide_aurora() {
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }
    
    if (btnClose) {
        btnClose.addEventListener('click', async () => {
            if (window.__TAURI__) {
                try {
                    const { getCurrentWindow } = window.__TAURI__.window;
                    const appWindow = getCurrentWindow();
                    await appWindow.close();
                } catch (error) {
                    console.error('关闭窗口失败:', error);
                }
            }
        });
    }

    const sidebarBtns = document.querySelectorAll('.sidebar-btn');
    const pages = document.querySelectorAll('.page');
    
    function settings_show_page(pageId) {
        pages.forEach(page => page.classList.remove('active'));
        const targetPage = document.getElementById(pageId);
        if (targetPage) {
            targetPage.classList.add('active');
        }
        
        if (auroraBg) {
            const showAurora = window.ThemeManager?.theme_fetch_aurora_effect?.() ?? true;
            if ((pageId === 'pageAbout' || pageId === 'pageUpdate') && showAurora) {
                settings_start_aurora();
                auroraBg.classList.add('active');
            } else {
                auroraBg.classList.remove('active');
                settings_hide_aurora();
            }
        }
    }

    sidebarBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            sidebarBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const pageMap = {
                'btnApp': 'pageApp',
                'btnStorage': 'pageStorage',
                'btnResources': 'pageResources',
                'btnCanvas': 'pageCanvas',
                'btnSource': 'pageSource',
                'btnTheme': 'pageTheme',
                'btnAbout': 'pageAbout'
            };
            
            const pageId = pageMap[btn.id];
            if (pageId) {
                settings_show_page(pageId);
            }
        });
    });

    const btnUpdate = document.getElementById('btnUpdate');
    if (btnUpdate) {
        btnUpdate.addEventListener('click', () => {
            settings_show_page('pageUpdate');
            settings_load_update_page();
        });
    }

    const btnBackToAbout = document.getElementById('btnBackToAbout');
    if (btnBackToAbout) {
        btnBackToAbout.addEventListener('click', () => {
            settings_show_page('pageAbout');
            sidebarBtns.forEach(b => b.classList.remove('active'));
            document.getElementById('btnAbout')?.classList.add('active');
        });
    }

    // 更新页面元素
    const updateCurrentVersion = document.getElementById('updateCurrentVersion');
    const updateReleaseNotesContent = document.getElementById('updateReleaseNotesContent');
    const updateDownloadProgress = document.getElementById('updateDownloadProgress');
    const updateProgressBar = document.getElementById('updateProgressBar');
    const updateProgressText = document.getElementById('updateProgressText');
    const btnCheckUpdate = document.getElementById('btnCheckUpdate');
    const btnUpdateDownload = document.getElementById('btnUpdateDownload');
    const updateStatus = document.getElementById('updateStatus');
    const useMirrorToggle = document.getElementById('useMirrorToggle');

    let latestReleaseData = null;
    let useMirror = false;

    if (useMirrorToggle) {
        const savedMirror = localStorage.getItem('useMirror');
        if (savedMirror === 'true') {
            useMirror = true;
            useMirrorToggle.checked = true;
        }

        useMirrorToggle.addEventListener('change', () => {
            useMirror = useMirrorToggle.checked;
            localStorage.setItem('useMirror', useMirror.toString());
        });
    }

    async function settings_load_update_page() {
        if (!window.__TAURI__) return;

        const { invoke } = window.__TAURI__.core;
        const currentVersion = await invoke('app_fetch_version');
        updateCurrentVersion.textContent = currentVersion;

        updateReleaseNotesContent.textContent = i18n.format_translate('settings.checkingForUpdates') || '正在检查更新...';
        btnCheckUpdate.disabled = true;
        btnUpdateDownload.style.display = 'none';
        updateStatus.textContent = '';

        try {
            const result = await invoke('update_fetch_check');
            const release = result.release;
            const currentRelease = result.current_release;

            btnCheckUpdate.disabled = false;

            let releaseNotes = '';

            if (currentRelease) {
                const currentNotes = currentRelease.body || `版本 ${currentVersion}`;
                releaseNotes += `【当前版本: v${currentVersion}】\n${currentNotes}\n\n`;
            }

            if (!release) {
                releaseNotes += i18n.format_translate('settings.alreadyLatest') || '当前已是最新版本';
                updateStatus.textContent = i18n.format_translate('settings.alreadyLatest') || '当前已是最新版本';
                updateStatus.className = 'update-status status-latest';
                latestReleaseData = null;
            } else {
                latestReleaseData = release;
                
                const latestNotes = release.body || '暂无更新日志';
                releaseNotes += `【最新版本: v${latestReleaseData.tag_name.replace(/^v/, '')}】\n${latestNotes}`;

                const size = release.assets && release.assets.length > 0 ? release.assets[0].size : 0;
                const sizeText = size > 0 ? settings_format_file_size(size) : '';
                if (sizeText) {
                    releaseNotes += `\n\n${i18n.format_translate('settings.fileSize') || '文件大小'}: ${sizeText}`;
                }

                updateStatus.textContent = i18n.format_translate('settings.updateAvailable') || '发现新版本';
                updateStatus.className = 'update-status status-available';
                btnUpdateDownload.style.display = 'inline-block';
            }

            updateReleaseNotesContent.textContent = releaseNotes;
        } catch (error) {
            console.error('检查更新失败:', error);
            updateReleaseNotesContent.textContent = i18n.format_translate('settings.updateCheckFailedDetail') || '检查更新失败，请稍后重试';
            updateStatus.textContent = i18n.format_translate('settings.updateCheckFailedDetail') || '检查更新失败，请稍后重试';
            updateStatus.className = 'update-status status-error';
            btnCheckUpdate.disabled = false;
            latestReleaseData = null;
        }
    }

    function settings_format_file_size(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    if (btnCheckUpdate) {
        btnCheckUpdate.addEventListener('click', async () => {
            await settings_load_update_page();
        });
    }

    if (btnUpdateDownload) {
        btnUpdateDownload.addEventListener('click', async () => {
            if (!latestReleaseData || !latestReleaseData.assets || latestReleaseData.assets.length === 0) return;

            const { invoke } = window.__TAURI__.core;
            const { getCurrentWindow } = window.__TAURI__.window;

            const asset = latestReleaseData.assets[0];
            const downloadUrl = asset.browser_download_url;
            const fileName = asset.name;

            btnUpdateDownload.disabled = true;
            btnUpdateDownload.textContent = i18n.format_translate('settings.downloading') || '正在下载...';
            updateDownloadProgress.style.display = 'block';
            updateProgressBar.style.width = '0%';
            updateProgressText.textContent = '0%';

            try {
                const currentWindow = getCurrentWindow();

                const unlisten = await currentWindow.listen('update-download-progress', (event) => {
                    const progress = event.payload;
                    updateProgressBar.style.width = progress + '%';
                    updateProgressText.textContent = i18n.format_translate('settings.downloadingUpdate', { percent: Math.round(progress) }) || `正在下载 ${Math.round(progress)}%`;
                });

                const downloadPath = await invoke('update_download_file', { url: downloadUrl, fileName: fileName, useMirror: useMirror });

                unlisten();

                updateDownloadProgress.style.display = 'none';
                btnUpdateDownload.style.display = 'none';
                updateStatus.textContent = i18n.format_translate('settings.downloadComplete') || '下载完成';
                updateStatus.className = 'update-status status-success';

                const restartModal = document.getElementById('restartModal');
                const restartModalMessage = restartModal?.querySelector('.modal-message');
                if (restartModalMessage) {
                    restartModalMessage.textContent = i18n.format_translate('settings.restartToUpdate') || '更新包已下载完成，请重启应用以完成更新。';
                }
                if (restartModal) {
                    restartModal.classList.add('active');
                }
            } catch (error) {
                console.error('下载更新失败:', error);
                updateDownloadProgress.style.display = 'none';
                btnUpdateDownload.disabled = false;
                btnUpdateDownload.textContent = i18n.format_translate('settings.downloadUpdate') || '下载更新';
                settings_show_dialog(i18n.format_translate('settings.downloadFailed') || '下载失败', String(error), 'error');
            }
        });
    }

    const linkGithub = document.getElementById('linkGithub');
    if (linkGithub && window.__TAURI__) {
        linkGithub.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://github.com/ospneam/ViewStage');
        });
    }

    const linkLicense = document.getElementById('linkLicense');
    if (linkLicense && window.__TAURI__) {
        linkLicense.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://github.com/ospneam/ViewStage?tab=Apache-2.0-1-ov-file');
        });
    }

    const btnRequestCameraPermission = document.getElementById('btnRequestCameraPermission');
    if (btnRequestCameraPermission) {
        btnRequestCameraPermission.addEventListener('click', async () => {
            const mode = btnRequestCameraPermission.dataset.mode;
            
            if (mode === 'revoke') {
                const modalOverlay = document.getElementById('modalOverlay');
                const modalTitle = modalOverlay?.querySelector('.modal-title');
                const modalMessage = modalOverlay?.querySelector('.modal-message');
                const modalConfirm = document.getElementById('modalConfirm');
                
                if (modalOverlay && modalTitle && modalMessage) {
                    modalTitle.textContent = window.i18n?.format_translate('settings.revokePermission') || '撤销授权';
                    modalMessage.textContent = window.i18n?.format_translate('settings.revokePermissionHint') || '撤销摄像头权限需要重置应用，这将删除所有设置并重启应用。确定要继续吗？';
                    modalOverlay.classList.add('active');
                    
                    modalConfirm.dataset.action = 'revoke-permission';
                }
            } else {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    stream.getTracks().forEach(t => t.stop());
                    
                    location.reload();
                } catch (error) {
                    console.error('获取摄像头权限失败:', error);
                    settings_show_dialog(
                        window.i18n?.format_translate('common.error') || '错误',
                        window.i18n?.format_translate('settings.cameraPermissionDenied') || '无法获取摄像头权限，请在系统设置中手动授权',
                        'error'
                    );
                }
            }
        });
    }

    settings_show_page('pageApp');
    document.getElementById('btnApp')?.classList.add('active');
});
