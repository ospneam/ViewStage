/**
 * 实时绘制管理器
 * 直接在 Canvas 上绘制，无缓冲无延迟
 */
class RealtimeBatchDrawManager {
    constructor() {
        this.ctx = null;
        this.minDistance = 0.3;
        this.minDistanceSq = 0.09;  // 缓存平方值，避免重复计算
        this.lastType = null;       // 缓存上次类型，减少状态切换
        this.lastColor = null;      // 缓存上次颜色
        this.lastLineWidth = null;  // 缓存上次线宽
    }
    
    /**
     * 获取 ctx，延迟初始化
     */
    getCtx() {
        if (!this.ctx) {
            this.ctx = window.dom.drawCtx;
        }
        return this.ctx;
    }
    
    /**
     * 添加绘制命令 - 钢笔模式使用固定线宽
     */
    addCommand(type, fromX, fromY, toX, toY, color, lineWidth) {
        // 使用平方距离避免 sqrt 计算
        const dx = toX - fromX;
        const dy = toY - fromY;
        const distSq = dx * dx + dy * dy;
        
        if (distSq < this.minDistanceSq) {
            return;
        }
        
        // 直接绘制
        this.drawSingleLine(type, fromX, fromY, toX, toY, color, lineWidth);
    }
    
    /**
     * 绘制单条固定线宽线段 - 优化状态切换
     */
    drawSingleLine(type, fromX, fromY, toX, toY, color, lineWidth) {
        const ctx = this.getCtx();
        const isErase = type === 'erase';
        
        // 只在状态变化时设置 globalCompositeOperation
        if (this.lastType !== type) {
            if (isErase) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
            } else {
                ctx.globalCompositeOperation = 'source-over';
            }
            this.lastType = type;
        }
        
        // 只在颜色变化时设置（非擦除模式）
        if (!isErase && this.lastColor !== color) {
            ctx.strokeStyle = color;
            this.lastColor = color;
        }
        
        // 只在线宽变化时设置
        if (this.lastLineWidth !== lineWidth) {
            ctx.lineWidth = lineWidth;
            this.lastLineWidth = lineWidth;
        }
        
        // lineCap 和 lineJoin 只需设置一次（构造函数中设置）
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
    }
    
    /**
     * 开始绘制
     */
    startDrawing() {
        // 初始化 Canvas 状态（只设置一次）
        const ctx = this.getCtx();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }
    
    /**
     * 结束绘制
     */
    async endDrawing() {
        // 重置缓存，确保下次绘制状态正确
        this.lastType = null;
        this.lastColor = null;
        this.lastLineWidth = null;
    }
    
    /**
     * 清空
     */
    clear() {
        this.lastType = null;
        this.lastColor = null;
        this.lastLineWidth = null;
    }
}

// 全局实时绘制管理器 - 挂载到 window 对象以便 main.js 访问
window.batchDrawManager = new RealtimeBatchDrawManager();
