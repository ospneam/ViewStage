/**
 * 文档加载器 —— PDF/Word 文件加载、渲染、Blob URL 管理的纯工具函数
 * 从 main.js 提取，无状态耦合，供 document_reader.js 和 main.js 共用
 */

/**
 * 初始化 PDF.js worker 路径
 * @returns {boolean} 是否初始化成功
 */
export function init_pdfjs() {
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'JS/pdf.worker.min.js';
        return true;
    }
    console.warn('[DocLoader] PDF.js 库未加载');
    return false;
}

/**
 * 等待 PDF.js 库加载完成
 * @param {number} max_wait - 最大等待毫秒数
 * @returns {Promise<boolean>} 是否加载成功
 */
export async function wait_pdfjs(max_wait = 5000) {
    const start_time = Date.now();
    while (!window.pdfjsLib && (Date.now() - start_time) < max_wait) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (window.pdfjsLib) {
        init_pdfjs();
        return true;
    }
    return false;
}

/**
 * 渲染单个 PDF 页面为 JPEG blob URL
 * @param {Object} pdf - PDF.js document 对象
 * @param {number} page_num - 页码（1-based）
 * @param {number} doc_number - 文档编号（用于生成 sourceId）
 * @param {number} [scale] - 渲染缩放比例，默认取 DRAW_CONFIG.pdfScale
 * @param {number} [quality] - JPEG 输出质量
 * @returns {Promise<{full: string, thumbnail: string, pageNum: number, sourceId: string, loaded: boolean}>}
 */
export async function render_pdf_page(pdf, page_num, doc_number, scale, quality = 0.85) {
    const render_scale = scale || window.DRAW_CONFIG?.pdfScale || 2;
    const page = await pdf.getPage(page_num);
    const viewport = page.getViewport({ scale: render_scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    let full_blob;
    try {
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        full_blob = await new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Failed to create blob'));
            }, 'image/jpeg', quality);
        });
    } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup?.();
    }
    const full_url = URL.createObjectURL(full_blob);

    const source_id = doc_number !== null ? `doc-${doc_number}-${page_num}` : null;

    return {
        full: full_url,
        thumbnail: full_url,
        pageNum: page_num,
        sourceId: source_id,
        loaded: true,
        width: viewport.width,
        height: viewport.height
    };
}

/**
 * 懒加载渲染 PDF 页面：先渲染前 initialPages 页，其余创建占位对象
 * @param {Object} pdf - PDF.js document 对象
 * @param {number} total_pages - 总页数
 * @param {number} initial_pages - 立即渲染的页数
 * @param {number|null} doc_number - 文档编号
 * @returns {Promise<Array>} 页面数据数组
 */
export async function render_pdf_pages_lazy(pdf, total_pages, initial_pages = 3, doc_number = null) {
    const pages = [];
    const pages_to_load = Math.min(initial_pages, total_pages);

    for (let i = 1; i <= pages_to_load; i++) {
        update_loading_progress(
            window.i18n?.format_translate('loading.processingPage', { current: i, total: total_pages })
            || `正在处理 ${i}/${total_pages} 页`
        );
        const page_data = await render_pdf_page(pdf, i, doc_number);
        pages.push(page_data);
    }

    for (let i = pages_to_load + 1; i <= total_pages; i++) {
        const source_id = doc_number !== null ? `doc-${doc_number}-${i}` : null;
        pages.push({
            full: null,
            thumbnail: null,
            pageNum: i,
            sourceId: source_id,
            loaded: false
        });
    }

    return pages;
}

/**
 * 并行批量渲染所有 PDF 页面
 * @param {Object} pdf - PDF.js document 对象
 * @param {number} total_pages - 总页数
 * @param {number} batch_size - 每批并行数
 * @param {number|null} doc_number - 文档编号
 * @returns {Promise<Array>} 页面数据数组（按页码排序）
 */
export async function render_pdf_pages_parallel(pdf, total_pages, batch_size = 4, doc_number = null) {
    const pages = [];
    let processed_count = 0;

    async function render_page(page_num) {
        const page_data = await render_pdf_page(pdf, page_num, doc_number);
        processed_count++;
        update_loading_progress(
            window.i18n?.format_translate('loading.processingPage', { current: processed_count, total: total_pages })
            || `正在处理 ${processed_count}/${total_pages} 页`
        );
        return page_data;
    }

    for (let i = 1; i <= total_pages; i += batch_size) {
        const batch = [];
        for (let j = i; j <= Math.min(i + batch_size - 1, total_pages); j++) {
            batch.push(render_page(j));
        }
        const batch_results = await Promise.all(batch);
        pages.push(...batch_results);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    pages.sort((a, b) => a.pageNum - b.pageNum);
    return pages;
}

// ====== 加载/错误 UI ======

/**
 * 显示加载遮罩
 * @param {string} message - 显示的加载消息
 */
export function show_loading_overlay(message) {
    const existing = document.getElementById('loadingOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `
        <div class="loading-content">
            <div class="loading-spinner"></div>
            <div class="loading-message" id="loadingMessage">${message}</div>
        </div>
    `;
    document.body.appendChild(overlay);
}

/**
 * 更新加载进度消息
 * @param {string} message - 新的进度消息
 */
export function update_loading_progress(message) {
    const el = document.getElementById('loadingMessage');
    if (el) el.textContent = message;
}

/**
 * 隐藏加载遮罩
 */
export function hide_loading_overlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.remove();
}

/**
 * 显示错误弹窗
 * @param {string} title - 错误标题
 * @param {string} message - 错误消息
 * @param {Function|null} retry_callback - 重试回调（可选）
 */
export function show_error_dialog(title, message, retry_callback = null) {
    const existing = document.getElementById('errorDialog');
    if (existing) existing.remove();

    const retry_text = window.i18n?.format_translate('common.retry') || '重试';
    const close_text = window.i18n?.format_translate('common.close') || '关闭';

    const dialog = document.createElement('div');
    dialog.id = 'errorDialog';
    dialog.className = 'error-dialog-overlay';
    dialog.innerHTML = `
        <div class="error-dialog">
            <div class="error-icon">⚠️</div>
            <div class="error-title">${title}</div>
            <div class="error-message">${message}</div>
            <div class="error-buttons">
                ${retry_callback ? `<button class="error-btn error-btn-retry" id="errorRetry">${retry_text}</button>` : ''}
                <button class="error-btn error-btn-close" id="errorClose">${close_text}</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    document.getElementById('errorClose')?.addEventListener('click', () => dialog.remove());
    document.getElementById('errorRetry')?.addEventListener('click', () => {
        dialog.remove();
        if (retry_callback) retry_callback();
    });
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.remove();
    });
}

// ====== Blob URL 管理 ======

/**
 * 释放指定文档的所有页面 blob URL
 * @param {number} doc_number - 文档编号
 */
export function revoke_document_blob_urls(doc_number) {
    const folder = window.state?.fileList?.find(f => f.docNumber === doc_number);
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

/**
 * 释放所有文档的全部页面 blob URL
 */
export function revoke_all_document_blob_urls() {
    if (!window.state?.fileList) return;
    window.state.fileList.forEach(folder => {
        folder.pages.forEach(page => {
            if (page.full && page.full.startsWith('blob:')) {
                URL.revokeObjectURL(page.full);
            }
            if (page.thumbnail && page.thumbnail.startsWith('blob:') && page.thumbnail !== page.full) {
                URL.revokeObjectURL(page.thumbnail);
            }
        });
    });
}

export const DocLoader = {
    init_pdfjs,
    wait_pdfjs,
    render_pdf_page,
    render_pdf_pages_lazy,
    render_pdf_pages_parallel,
    show_loading_overlay,
    update_loading_progress,
    hide_loading_overlay,
    show_error_dialog,
    revoke_document_blob_urls,
    revoke_all_document_blob_urls
};
