/**
 * 文档扫描模块（主页面嵌入面板）
 * 自动检测文档区域并裁剪
 */

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', doc_scan_setup_events);
} else {
    doc_scan_setup_events();
}

function doc_scan_setup_events() {
}

function doc_scan_handle_panel_toggle() {
    const panel = window.dom?.docScanPanel;
    if (!panel) return;
    
    if (panel.classList.contains('visible')) {
        doc_scan_hide_panel();
    } else {
        doc_scan_show_panel();
    }
}

function doc_scan_show_panel() {
    if (!window.dom?.docScanPanel) return;
    
    if (window.main_hide_pen_control_panel) window.main_hide_pen_control_panel();
    if (window.main_hide_settings_panel) window.main_hide_settings_panel();
    
    window.dom.docScanPanel.classList.add('visible');
}

function doc_scan_hide_panel() {
    if (!window.dom?.docScanPanel) return;
    window.dom.docScanPanel.classList.remove('visible');
}

async function doc_scan_handle_apply() {
    const hasCamera = window.state?.isCameraOpen;
    const hasImage = window.state?.currentImage;
    const hasPdfPage = window.state?.currentFolderIndex >= 0 && window.state?.currentFolderPageIndex >= 0;
    const hasImageIndex = window.state?.currentImageIndex >= 0;
    
    console.log('文档扫描状态检查:', {
        hasCamera,
        hasImage: !!hasImage,
        hasPdfPage,
        hasImageIndex
    });
    
    if (!hasCamera && !hasImage && !hasPdfPage && !hasImageIndex) {
        alert(window.i18n?.format_translate('docScan.noImage') || '请先打开图片、文档或摄像头');
        return;
    }
    
    try {
        doc_scan_show_processing();
        
        const imageData = await doc_scan_fetch_image_data();
        
        const result = await doc_scan_handle_invoke(imageData);
        
        await doc_scan_handle_result(result);
        
        doc_scan_hide_panel();
        
        console.log('文档扫描完成，置信度:', result.confidence);
    } catch (error) {
        console.error('文档扫描失败:', error);
        alert(window.i18n?.format_translate('docScan.failed') || '文档扫描失败: ' + error.message);
    } finally {
        doc_scan_hide_processing();
    }
}

async function doc_scan_fetch_image_data() {
    if (window.state?.isCameraOpen) {
        const video = document.getElementById('cameraVideo');
        if (!video) throw new Error('摄像头未找到');
        
        const videoW = video.videoWidth;
        const videoH = video.videoHeight;
        
        const tempCanvas = document.createElement('canvas');
        const ctx = tempCanvas.getContext('2d');
        
        const rotation = window.state?.cameraRotation || 0;
        
        if (rotation % 180 === 0) {
            tempCanvas.width = videoW;
            tempCanvas.height = videoH;
        } else {
            tempCanvas.width = videoH;
            tempCanvas.height = videoW;
        }
        
        ctx.save();
        ctx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
        if (rotation !== 0) {
            ctx.rotate(rotation * Math.PI / 180);
        }
        ctx.drawImage(video, -videoW / 2, -videoH / 2);
        ctx.restore();
        
        return tempCanvas.toDataURL('image/png');
    }
    
    if (window.state?.currentImage) {
        return window.state.currentImage.src;
    }
    
    const imageElement = document.getElementById('imageElement');
    if (imageElement && imageElement.src) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = parseInt(imageElement.style.width) || imageElement.naturalWidth;
        tempCanvas.height = parseInt(imageElement.style.height) || imageElement.naturalHeight;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(imageElement, 0, 0, tempCanvas.width, tempCanvas.height);
        return tempCanvas.toDataURL('image/png');
    }
    
    throw new Error('没有可用的图像');
}

async function doc_scan_handle_invoke(imageData) {
    if (!window.__TAURI__) {
        throw new Error('文档扫描功能需要Tauri后端支持');
    }
    
    const { invoke } = window.__TAURI__.core;
    
    const request = {
        image_data: imageData
    };
    
    return await invoke('scan_process_document', { request });
}

async function doc_scan_handle_result(result) {
    if (!result.enhanced_image) {
        throw new Error('扫描结果无效');
    }
    
    const enhancedImg = new Image();
    
    await new Promise((resolve, reject) => {
        enhancedImg.onload = resolve;
        enhancedImg.onerror = () => reject(new Error('加载增强图像失败'));
        enhancedImg.src = result.enhanced_image;
    });
    
    if (window.state?.isCameraOpen) {
        if (window.main_save_image_to_list_no_highlight) {
            const photoName = window.i18n?.format_translate('docScan.scannedDoc') || `扫描文档${window.state.imageList.length + 1}`;
            await window.main_save_image_to_list_no_highlight(enhancedImg, photoName);
        }
    } else if (window.state?.currentImageIndex >= 0) {
        window.state.currentImage = enhancedImg;
        
        if (window.main_render_image_centered) {
            window.main_render_image_centered(enhancedImg);
        }
        
        if (window.state.imageList && window.state.currentImageIndex < window.state.imageList.length) {
            window.state.imageList[window.state.currentImageIndex].full = result.enhanced_image;
            window.state.imageList[window.state.currentImageIndex].thumbnail = result.enhanced_image;
            
            if (window.main_update_sidebar_content) {
                window.main_update_sidebar_content();
            }
        }
        
        if (window.main_delete_all_drawings) {
            window.main_delete_all_drawings();
        }
    }
    
    if (result.text_bbox) {
        console.log('检测到文本区域:', result.text_bbox);
    }
}

function doc_scan_show_processing() {
    const btn = document.getElementById('btnApplyScan');
    if (btn) {
        btn.disabled = true;
        btn.textContent = window.i18n?.format_translate('docScan.processing') || '处理中...';
    }
}

function doc_scan_hide_processing() {
    const btn = document.getElementById('btnApplyScan');
    if (btn) {
        btn.disabled = false;
        btn.textContent = window.i18n?.format_translate('docScan.apply') || '应用';
    }
}

window.doc_scan_handle_panel_toggle = doc_scan_handle_panel_toggle;
window.doc_scan_show_panel = doc_scan_show_panel;
window.doc_scan_hide_panel = doc_scan_hide_panel;
window.doc_scan_handle_apply = doc_scan_handle_apply;

console.log('文档扫描模块已加载');
