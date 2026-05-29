class RealtimeBatchDrawManager {
    constructor() {
        this.pendingCommands = [];
        this.pendingCount = 0;
        this.drawRafId = null;
        this.drawInterval = 1000 / 60;
        this.lastDrawTime = 0;
        this.lastType = null;
        this.lastColor = null;
        this.lastLineWidth = null;

        this.currentFps = 60;
        this.minFps = 15;
        this.maxFps = 60;
        this.fpsStep = 5;

        this.drawTimes = [];
        this.drawTimesMax = 10;

        this.commandCounts = [];
        this.commandCountsMax = 5;

        this.frameRateMode = 'adaptive';
        this.lastAdjustTime = 0;
        this.adjustCooldown = 100;

        this.LOW_LOAD_FPS = 60;
        this.MEDIUM_LOAD_FPS = 45;
        this.HIGH_LOAD_FPS = 30;
        this.CRITICAL_LOAD_FPS = 20;

        this.LOW_LOAD_THRESHOLD = 10;
        this.MEDIUM_LOAD_THRESHOLD = 30;
        this.HIGH_LOAD_THRESHOLD = 50;

        this.lastBatchMoveTime = 0;

        this._strokeStart = true;
        this._totalSegments = 0;
        this._lastMidX = null;
        this._lastMidY = null;
        this._lastToX = null;
        this._lastToY = null;
        this._speedBuffer = [];
        this._storedWidths = [];

        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._overlayTransformScale = 0;
        this._overlayTransformX = 0;
        this._overlayTransformY = 0;
    }

    init_overlay(container, screenW, screenH, dpr) {
        this._overlayCanvas = document.createElement('canvas');
        this._overlayCanvas.className = 'canvas-tile draw-overlay';
        const capped = Math.min(dpr, 1);
        this._overlayCanvas.width = Math.ceil(screenW * capped);
        this._overlayCanvas.height = Math.ceil(screenH * capped);
        this._overlayCanvas.style.width = screenW + 'px';
        this._overlayCanvas.style.height = screenH + 'px';
        container.appendChild(this._overlayCanvas);
        this._overlayCtx = this._overlayCanvas.getContext('2d');
        this._overlayCtx.imageSmoothingEnabled = false;
        this._overlayTransformScale = 0;
    }

    resize_overlay(screenW, screenH, dpr) {
        if (this._overlayCanvas) {
            const capped = Math.min(dpr, 1);
            this._overlayCanvas.width = Math.ceil(screenW * capped);
            this._overlayCanvas.height = Math.ceil(screenH * capped);
            this._overlayCanvas.style.width = screenW + 'px';
            this._overlayCanvas.style.height = screenH + 'px';
        }
        this._overlayTransformScale = 0;
    }

    destroy_overlay() {
        if (this._overlayCanvas && this._overlayCanvas.parentNode) {
            this._overlayCanvas.parentNode.removeChild(this._overlayCanvas);
        }
        this._overlayCanvas = null;
        this._overlayCtx = null;
    }

    _sync_overlay_transform() {
        if (!this._overlayCtx) return;
        const dpr = Math.min(window.DRAW_CONFIG.dpr, 1);
        const scale = window.state.scale || 1;
        const canvasX = window.state.canvasX || 0;
        const canvasY = window.state.canvasY || 0;
        this._overlayCtx.setTransform(scale * dpr, 0, 0, scale * dpr, canvasX * dpr, canvasY * dpr);
    }

    clear_overlay() {
        if (this._overlayCtx) {
            this._overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
            this._overlayCtx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
        }
        this._overlayTransformScale = 0;
    }

    _each_tile(x1, y1, x2, y2, fn) {
        const tr = window.tileRenderer;
        if (!tr) return;
        const infos = tr.infos_for_segment(x1, y1, x2, y2);
        for (const info of infos) {
            const ctx = info.ctx;
            const dpr = info.dpr;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr,
                -info.rect.x * dpr, -info.rect.y * dpr);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            fn(ctx);
            ctx.restore();
        }
    }

    _each_visible_tile(fn) {
        const tr = window.tileRenderer;
        if (!tr) return;
        const keys = tr.get_visible_keys();
        for (const info of tr.tileInfos) {
            if (keys.has(info.key)) {
                const ctx = info.ctx;
                const dpr = info.dpr;
                ctx.save();
                ctx.setTransform(dpr, 0, 0, dpr,
                    -info.rect.x * dpr, -info.rect.y * dpr);
                ctx.imageSmoothingEnabled = false;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                fn(ctx, info);
                ctx.restore();
            }
        }
    }

    batch_draw_update_frame_rate(mode) {
        this.frameRateMode = mode;

        if (mode === 'low') {
            this.currentFps = 30;
            this.drawInterval = 1000 / 30;
        } else if (mode === 'high') {
            this.currentFps = 60;
            this.drawInterval = 1000 / 60;
        } else {
            this.currentFps = 60;
            this.drawInterval = 1000 / 60;
        }
    }

    get is_adaptive() {
        return this.frameRateMode === 'adaptive';
    }

    batch_draw_calc_target_fps(commandCount) {
        if (commandCount < this.LOW_LOAD_THRESHOLD) {
            return this.LOW_LOAD_FPS;
        } else if (commandCount < this.MEDIUM_LOAD_THRESHOLD) {
            return this.MEDIUM_LOAD_FPS;
        } else if (commandCount < this.HIGH_LOAD_THRESHOLD) {
            return this.HIGH_LOAD_FPS;
        } else {
            return this.CRITICAL_LOAD_FPS;
        }
    }

    batch_draw_calc_adjust_fps(drawTime, commandCount) {
        const now = performance.now();
        if (now - this.lastAdjustTime < this.adjustCooldown) {
            return;
        }
        this.lastAdjustTime = now;

        this.drawTimes.push(drawTime);
        if (this.drawTimes.length > this.drawTimesMax) {
            this.drawTimes.shift();
        }

        this.commandCounts.push(commandCount);
        if (this.commandCounts.length > this.commandCountsMax) {
            this.commandCounts.shift();
        }

        const avgDrawTime = this.drawTimes.reduce((a, b) => a + b, 0) / this.drawTimes.length;
        const avgCommandCount = this.commandCounts.reduce((a, b) => a + b, 0) / this.commandCounts.length;

        const targetFps = this.batch_draw_calc_target_fps(avgCommandCount);
        const currentFrameTime = 1000 / this.currentFps;

        if (avgDrawTime > currentFrameTime * 1.5) {
            const newFps = Math.max(this.minFps, this.currentFps - this.fpsStep);
            if (newFps !== this.currentFps) {
                this.currentFps = newFps;
                this.drawInterval = 1000 / this.currentFps;
            }
        } else if (this.currentFps < targetFps && avgDrawTime < currentFrameTime * 0.7) {
            const newFps = Math.min(targetFps, this.currentFps + this.fpsStep);
            if (newFps !== this.currentFps) {
                this.currentFps = newFps;
                this.drawInterval = 1000 / this.currentFps;
            }
        }
    }

    batch_draw_fetch_stats() {
        return {
            currentFps: this.currentFps,
            targetFps: this.batch_draw_calc_target_fps(this.pendingCount),
            pendingCount: this.pendingCount,
            avgDrawTime: this.drawTimes.length > 0
                ? this.drawTimes.reduce((a, b) => a + b, 0) / this.drawTimes.length
                : 0,
            frameRateMode: this.frameRateMode
        };
    }

    batch_draw_create_command(type, fromX, fromY, toX, toY, color, lineWidth) {
        const idx = this.pendingCount++;
        if (idx >= this.pendingCommands.length) {
            this.pendingCommands.push({ type, fromX, fromY, toX, toY, color, lineWidth });
        } else {
            const cmd = this.pendingCommands[idx];
            cmd.type = type;
            cmd.fromX = fromX;
            cmd.fromY = fromY;
            cmd.toX = toX;
            cmd.toY = toY;
            cmd.color = color;
            cmd.lineWidth = lineWidth;
        }

        if (this.is_adaptive && this.pendingCount === 1) {
            const targetFps = this.batch_draw_calc_target_fps(1);
            if (this.currentFps > targetFps) {
                this.currentFps = targetFps;
                this.drawInterval = 1000 / this.currentFps;
            }
        }

        this.batch_draw_setup_schedule();
    }

    batch_draw_setup_schedule() {
        if (this.drawRafId !== null) return;

        const now = performance.now();
        const timeSinceLastDraw = now - this.lastDrawTime;

        if (timeSinceLastDraw >= this.drawInterval) {
            this.batch_draw_handle_flush();
        } else {
            this.drawRafId = requestAnimationFrame(() => {
                this.drawRafId = null;
                this.batch_draw_handle_flush();
            });
        }
    }

    _calc_pen_line_width(speed, baseWidth, lastLineWidth, dist) {
        const speedScale = Math.max(0.4, Math.min(2.5, baseWidth / 4));
        const maxSpeed = 2.5 * speedScale;
        const minSpeed = 0.2 * speedScale;

        let lineWidth;
        if (speed >= maxSpeed) {
            lineWidth = baseWidth * 0.5;
        } else if (speed <= minSpeed) {
            lineWidth = baseWidth;
        } else {
            const ratio = (speed - minSpeed) / (maxSpeed - minSpeed);
            const eased = ratio * ratio * (3 - 2 * ratio);
            lineWidth = baseWidth - eased * (baseWidth * 0.5);
        }

        const blend = Math.max(0.3, Math.min(0.85, 1 - dist / (baseWidth * 3)));
        lineWidth = lineWidth * (1 - blend) + lastLineWidth * blend;

        const maxDelta = baseWidth * 0.12;
        lineWidth = Math.min(lastLineWidth + maxDelta, Math.max(lastLineWidth - maxDelta, lineWidth));

        return Math.max(0.5, lineWidth);
    }

    _apply_start_taper(lineWidth, baseWidth, segmentIndex, totalInBatch) {
        const globalIndex = this._totalSegments + segmentIndex;
        if (globalIndex < 4) {
            const taperT = (globalIndex + 1) / 4;
            const eased = taperT * taperT * (3 - 2 * taperT);
            const minStart = baseWidth * 0.2;
            return minStart + (lineWidth - minStart) * eased;
        }
        return lineWidth;
    }


    batch_draw_handle_flush() {
        const count = this.pendingCount;
        if (count === 0) return;
        this.pendingCount = 0;

        const drawStart = performance.now();

        if (window.main_reset_context_state) {
            window.main_reset_context_state();
        }

        this._sync_overlay_transform();

        const commands = this.pendingCommands;
        let currentType = this.lastType;
        let currentColor = this.lastColor;
        let currentLineWidth = this.lastLineWidth;

        const updateCtx = window.main_update_context_state;
        const getPenEffect = window.get_pen_effect_mode;
        const penEffectActive = getPenEffect ? getPenEffect() !== 'off' : false;

        let lastLineWidth = currentLineWidth || 5;
        let lastMoveTime = this.lastBatchMoveTime || performance.now() - 16;

        const curTime = performance.now();
        const batchTimeSpan = Math.max(1, curTime - lastMoveTime);
        const perSegTime = Math.min(batchTimeSpan / count, 8);
        lastMoveTime = curTime;

        for (let i = 0; i < count; i++) {
            const cmd = commands[i];

            const fromX = cmd.fromX, fromY = cmd.fromY;
            const toX = cmd.toX, toY = cmd.toY;

            let lineWidth = cmd.lineWidth;
            if (penEffectActive && cmd.type === 'draw') {
                const dx = toX - fromX;
                const dy = toY - fromY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const rawSpeed = dist / perSegTime;
                this._speedBuffer.push(rawSpeed);
                if (this._speedBuffer.length > 3) {
                    this._speedBuffer.shift();
                }
                const speed = this._speedBuffer.reduce((a, b) => a + b, 0) / this._speedBuffer.length;
                lineWidth = this._calc_pen_line_width(speed, cmd.lineWidth, lastLineWidth, dist);

                if (this._strokeStart) {
                    lineWidth = this._apply_start_taper(lineWidth, cmd.lineWidth, i, count);
                }
            }

            if (penEffectActive && cmd.type === 'draw') {
                this._storedWidths.push(lineWidth);
            }
            lastLineWidth = lineWidth;

            if (cmd.type !== currentType || cmd.color !== currentColor) {
                currentType = cmd.type;
                currentColor = cmd.color;
            }

            const isFirst = (i === 0 && (this._strokeStart || this._lastMidX === null));
            const lastMX = isFirst ? null : (i === 0 ? this._lastMidX : ((commands[i - 1].fromX + commands[i - 1].toX) / 2));
            const lastMY = isFirst ? null : (i === 0 ? this._lastMidY : ((commands[i - 1].fromY + commands[i - 1].toY) / 2));

            const prevCmd = i > 0 ? commands[i - 1] : null;
            const segFromX = prevCmd ? (prevCmd.fromX + prevCmd.toX) / 2 : fromX;
            const segFromY = prevCmd ? (prevCmd.fromY + prevCmd.toY) / 2 : fromY;
            const boxMinX = Math.min(segFromX, fromX, toX);
            const boxMinY = Math.min(segFromY, fromY, toY);
            const boxMaxX = Math.max(segFromX, fromX, toX);
            const boxMaxY = Math.max(segFromY, fromY, toY);
            if (cmd.type === 'erase') {
                this._each_tile(boxMinX, boxMinY, boxMaxX, boxMaxY, (ctx) => {
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.strokeStyle = 'rgba(0,0,0,1)';
                    ctx.lineWidth = cmd.lineWidth;
                    ctx.beginPath();
                    ctx.moveTo(fromX, fromY);
                    ctx.lineTo(toX, toY);
                    ctx.stroke();
                });
            } else if (this._overlayCtx) {
                const ctx = this._overlayCtx;
                ctx.globalCompositeOperation = 'source-over';
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                if (cmd.color) {
                    ctx.strokeStyle = cmd.color;
                }
                ctx.lineWidth = Math.max(0.5, lineWidth);

                const midX = (fromX + toX) / 2;
                const midY = (fromY + toY) / 2;

                if (isFirst || lastMX === null) {
                    ctx.beginPath();
                    ctx.moveTo(fromX, fromY);
                    ctx.lineTo(midX, midY);
                    ctx.stroke();
                } else {
                    ctx.beginPath();
                    ctx.moveTo(lastMX, lastMY);
                    ctx.quadraticCurveTo(fromX, fromY, midX, midY);
                    ctx.stroke();
                }
            }

            if (i === count - 1) {
                this._lastMidX = (fromX + toX) / 2;
                this._lastMidY = (fromY + toY) / 2;
                this._lastToX = toX;
                this._lastToY = toY;
            }
        }

        this._totalSegments += count;
        this._strokeStart = false;

        this.lastBatchMoveTime = curTime;

        const drawEnd = performance.now();
        const drawTime = drawEnd - drawStart;
        this.lastDrawTime = drawEnd;

        this.lastType = currentType;
        this.lastColor = currentColor;
        this.lastLineWidth = lastLineWidth;

        if (this.is_adaptive) {
            this.batch_draw_calc_adjust_fps(drawTime, count);
        }
    }

    reset_state() {
        this.pendingCount = 0;
        this.pendingCommands.length = 0;
        if (this.drawRafId !== null) {
            cancelAnimationFrame(this.drawRafId);
            this.drawRafId = null;
        }
        this.lastType = null;
        this.lastColor = null;
        this.lastLineWidth = null;
        this.lastBatchMoveTime = 0;
        this._strokeStart = true;
        this._totalSegments = 0;
        this._lastMidX = null;
        this._lastMidY = null;
        this._lastToX = null;
        this._lastToY = null;
        this._speedBuffer = [];
        this._storedWidths = [];
        this.clear_overlay();
    }

    batch_draw_init_start() {
        this.pendingCount = 0;
        this.pendingCommands.length = 0;
        this.lastDrawTime = performance.now();
        this._strokeStart = true;
        this._totalSegments = 0;
        this._lastMidX = null;
        this._lastMidY = null;
        this._lastToX = null;
        this._lastToY = null;
        this._speedBuffer = [];
        this._storedWidths = [];

        if (this.is_adaptive) {
            this.currentFps = this.LOW_LOAD_FPS;
            this.drawInterval = 1000 / this.currentFps;
        }

        this._each_visible_tile((ctx, info) => {
            ctx.imageSmoothingEnabled = false;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
        });
    }

    batch_draw_handle_end() {
        if (this.drawRafId !== null) {
            cancelAnimationFrame(this.drawRafId);
            this.drawRafId = null;
        }

        this.batch_draw_handle_flush();
        this._sync_overlay_transform();

        if (this._lastMidX !== null && this._lastToX !== null) {
            if (this.lastType === 'erase') {
                this._each_tile(this._lastMidX, this._lastMidY, this._lastToX, this._lastToY, (ctx) => {
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.strokeStyle = 'rgba(0,0,0,1)';
                    ctx.lineWidth = this.lastLineWidth || 5;
                    ctx.beginPath();
                    ctx.moveTo(this._lastMidX, this._lastMidY);
                    ctx.lineTo(this._lastToX, this._lastToY);
                    ctx.stroke();
                });
            } else if (this._overlayCtx) {
                const ctx = this._overlayCtx;
                const cfg = window.DRAW_CONFIG || {};
                ctx.globalCompositeOperation = 'source-over';
                ctx.strokeStyle = cfg.penColor || '#3498db';
                ctx.lineWidth = this.lastLineWidth || 5;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(this._lastMidX, this._lastMidY);
                ctx.lineTo(this._lastToX, this._lastToY);
                ctx.stroke();
            }
        }

        this.clear_overlay();

        this._each_visible_tile((ctx, info) => {
            const cfg = window.DRAW_CONFIG || {};
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = cfg.penColor || '#3498db';
            ctx.lineWidth = cfg.penWidth || 5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
        });

        if (this.is_adaptive) {
            this.drawTimes = [];
            this.commandCounts = [];
        }
    }

    batch_draw_delete_all() {
        this.reset_state();
    }
}

window.batchDrawManager = new RealtimeBatchDrawManager();
