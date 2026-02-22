/**
 * WASM 点处理模块
 * 提供高性能的点优化、距离计算等功能
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
            const { default: init, process_stroke_points, smooth_path, collect_points, batch_process_draw_commands, cull_strokes_by_viewport } = await import('./wasm/wasm_viewstage.js');
            
            await init();
            
            this.wasmModule = {
                process_stroke_points,
                smooth_path,
                collect_points,
                batch_process_draw_commands,
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

    async processStrokePoints(points, config) {
        await this.load();
        const request = {
            points,
            config
        };
        const requestJson = JSON.stringify(request);
        const resultJson = this.wasmModule.process_stroke_points(requestJson);
        return JSON.parse(resultJson);
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

    async collectPoints(points, config, lastTime, lastX, lastY) {
        await this.load();
        const currentTime = Date.now();
        const request = {
            points,
            config,
            lastTime: lastTime,
            lastX: lastX,
            lastY: lastY,
            currentTime: currentTime
        };
        const requestJson = JSON.stringify(request);
        const resultJson = this.wasmModule.collect_points(requestJson);
        return JSON.parse(resultJson);
    }

    async batchProcessDrawCommands(commands, minDistance, maxBatchSize) {
        await this.load();
        const request = {
            commands,
            min_distance: minDistance,
            max_batch_size: maxBatchSize
        };
        const requestJson = JSON.stringify(request);
        const resultJson = this.wasmModule.batch_process_draw_commands(requestJson);
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
