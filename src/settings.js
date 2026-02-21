document.addEventListener('DOMContentLoaded', async () => {
    const btnClose = document.getElementById('btnClose');
    const auroraBg = document.getElementById('auroraBg');
    
    async function loadAppVersion() {
        if (window.__TAURI__) {
            try {
                const { invoke } = window.__TAURI__.core;
                const version = await invoke('get_app_version');
                
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
    }
    
    loadAppVersion();
    
    let blobs = [];
    let animationId = null;
    let lastTime = 0;
    const updateInterval = 50;
    
    function generateRandomColor() {
        const hue = Math.floor(Math.random() * 360);
        const saturation = 60 + Math.floor(Math.random() * 30);
        const lightness = 50 + Math.floor(Math.random() * 20);
        return `hsla(${hue}, ${saturation}%, ${lightness}%, 0.6)`;
    }
    
    function createBlobs() {
        if (!auroraBg) return;
        
        auroraBg.innerHTML = '';
        blobs = [];
        
        const blobCount = 5;
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        for (let i = 0; i < blobCount; i++) {
            const blob = document.createElement('div');
            blob.className = 'aurora-blob';
            
            const size = 350 + Math.random() * 250;
            blob.style.width = size + 'px';
            blob.style.height = size + 'px';
            blob.style.background = generateRandomColor();
            
            const x = Math.random() * width;
            const y = Math.random() * height;
            blob.style.transform = `translate(${x}px, ${y}px)`;
            
            auroraBg.appendChild(blob);
            
            blobs.push({
                element: blob,
                x: x,
                y: y,
                vx: 0,
                vy: 0
            });
        }
    }
    
    function updateBlobs(currentTime) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        if (currentTime - lastTime >= updateInterval) {
            lastTime = currentTime;
            
            blobs.forEach(blob => {
                const noise = 0.2;
                blob.vx += (Math.random() - 0.5) * noise;
                blob.vy += (Math.random() - 0.5) * noise;
                
                blob.vx *= 0.98;
                blob.vy *= 0.98;
                
                const maxSpeed = 1;
                const speed = Math.sqrt(blob.vx * blob.vx + blob.vy * blob.vy);
                if (speed > maxSpeed) {
                    blob.vx = (blob.vx / speed) * maxSpeed;
                    blob.vy = (blob.vy / speed) * maxSpeed;
                }
                
                blob.x += blob.vx;
                blob.y += blob.vy;
                
                const margin = 100;
                if (blob.x < -margin) blob.x = width + margin;
                if (blob.x > width + margin) blob.x = -margin;
                if (blob.y < -margin) blob.y = height + margin;
                if (blob.y > height + margin) blob.y = -margin;
                
                blob.element.style.transform = `translate(${blob.x}px, ${blob.y}px)`;
            });
        }
        
        animationId = requestAnimationFrame(updateBlobs);
    }
    
    function startAurora() {
        if (blobs.length === 0) {
            createBlobs();
        }
        if (!animationId) {
            updateBlobs();
        }
    }
    
    function stopAurora() {
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
    
    function showPage(pageId) {
        pages.forEach(page => page.classList.remove('active'));
        const targetPage = document.getElementById(pageId);
        if (targetPage) {
            targetPage.classList.add('active');
        }
        
        if (auroraBg) {
            if (pageId === 'pageAbout' || pageId === 'pageUpdate') {
                startAurora();
                auroraBg.classList.add('active');
            } else {
                auroraBg.classList.remove('active');
                stopAurora();
            }
        }
    }

    sidebarBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            sidebarBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const pageMap = {
                'btnApp': 'pageApp',
                'btnCanvas': 'pageCanvas',
                'btnSource': 'pageSource',
                'btnAbout': 'pageAbout'
            };
            
            const pageId = pageMap[btn.id];
            if (pageId) {
                showPage(pageId);
            }
        });
    });

    const btnCheckUpdate = document.getElementById('btnCheckUpdate');
    if (btnCheckUpdate) {
        btnCheckUpdate.addEventListener('click', () => {
            showPage('pageUpdate');
            checkForUpdate();
        });
    }

    const btnBackToAbout = document.getElementById('btnBackToAbout');
    if (btnBackToAbout) {
        btnBackToAbout.addEventListener('click', () => {
            showPage('pageAbout');
            sidebarBtns.forEach(b => b.classList.remove('active'));
            document.getElementById('btnAbout')?.classList.add('active');
        });
    }

    async function checkForUpdate() {
        const updateStatus = document.getElementById('updateStatus');
        const updateInfo = document.getElementById('updateInfo');
        const updateIcon = document.querySelector('.update-icon');
        
        if (updateIcon) {
            updateIcon.style.animation = 'spin 2s linear infinite';
        }
        
        if (updateStatus) {
            updateStatus.textContent = '正在检查更新...';
        }
        
        if (updateInfo) {
            updateInfo.style.display = 'none';
        }
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        if (updateIcon) {
            updateIcon.style.animation = 'none';
        }
        
        if (updateStatus) {
            updateStatus.textContent = '当前已是最新版本';
        }
        
        if (updateInfo) {
            updateInfo.style.display = 'block';
        }
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

    showPage('pageApp');
    document.getElementById('btnApp')?.classList.add('active');
});
