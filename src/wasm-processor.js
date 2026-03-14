/**
 * WASM 点处理模块
 * 提供高性能的路径平滑和视口裁剪功能
 */

class WasmPointProcessor {
    constructor() {
        this.wasmModule = null;
        this.isLoaded = false;
        this.loadPromise = null;
    }

    async load() {
        if (this.isLoaded) {
            return this.wasmModule;
        }

        if (this.loadPromise) {
            return this.loadPromise;
        }

        this.loadPromise = this._loadWasm();
        try {
            return await this.loadPromise;
        } catch (error) {
            this.loadPromise = null;
            throw error;
        }
    }

    async _loadWasm() {
        try {
            const { default: init, smooth_path, cull_strokes_by_viewport } = await import('./wasm/wasm_viewstage.js');
            
            await init();
            
            this.wasmModule = {
                smooth_path,
                cull_strokes_by_viewport
            };
            
            this.isLoaded = true;
            console.log('WASM 点处理模块已加载');
            
            return this.wasmModule;
        } catch (error) {
            console.error('WASM 加载失败:', error);
            throw error;
        }
    }

    async smoothPath(points, smoothness, algorithm = 'bezier') {
        await this.load();
        const request = {
            points,
            smoothness,
            algorithm
        };
        const requestJson = JSON.stringify(request);
        const resultJson = this.wasmModule.smooth_path(requestJson);
        return JSON.parse(resultJson);
    }

    async cullStrokesByViewport(strokes, viewport) {
        await this.load();
        const request = {
            strokes,
            viewport
        };
        const requestJson = JSON.stringify(request);
        const resultJson = this.wasmModule.cull_strokes_by_viewport(requestJson);
        return JSON.parse(resultJson);
    }
}

const wasmPointProcessor = new WasmPointProcessor();
export default wasmPointProcessor;
