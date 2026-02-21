document.addEventListener('DOMContentLoaded', async () => {
    const btnClose = document.getElementById('btnClose');
    
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
});
