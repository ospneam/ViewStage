/**
 * 撤销/重做系统 - 命令模式实现
 * 
 * 架构：
 * - Command: 命令基类，定义execute/undo/redo接口
 * - DrawCommand: 绘制命令
 * - EraseCommand: 橡皮擦命令
 * - ClearCommand: 清空命令
 * - SnapshotCommand: 快照命令（用于压缩）
 * - HistoryManager: 历史管理器，管理undo/redo栈
 */

export const MAX_HISTORY_STEPS = 50;

let historyState = {
    undoStack: [],
    redoStack: [],
    isExecuting: false,
    onStateChange: null
};

export function initHistoryManager(options = {}) {
    historyState.undoStack = [];
    historyState.redoStack = [];
    historyState.isExecuting = false;
    historyState.onStateChange = options.onStateChange || null;
}

class Command {
    constructor(type) {
        this.type = type;
        this.timestamp = Date.now();
    }

    execute() {
        throw new Error('Command.execute() must be implemented');
    }

    undo() {
        throw new Error('Command.undo() must be implemented');
    }

    redo() {
        return this.execute();
    }

    canCompact() {
        return true;
    }
}

export class DrawCommand extends Command {
    constructor(options) {
        super('draw');
        this.stroke = options.stroke;
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.redrawFn = options.redrawFn;
    }

    async execute() {
        if (!this.strokeHistoryRef.includes(this.stroke)) {
            this.strokeHistoryRef.push(this.stroke);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async undo() {
        const index = this.strokeHistoryRef.indexOf(this.stroke);
        if (index > -1) {
            this.strokeHistoryRef.splice(index, 1);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async redo() {
        await this.execute();
    }

    canCompact() {
        return true;
    }
}

export class EraseCommand extends Command {
    constructor(options) {
        super('erase');
        this.stroke = options.stroke;
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.redrawFn = options.redrawFn;
    }

    async execute() {
        if (!this.strokeHistoryRef.includes(this.stroke)) {
            this.strokeHistoryRef.push(this.stroke);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async undo() {
        const index = this.strokeHistoryRef.indexOf(this.stroke);
        if (index > -1) {
            this.strokeHistoryRef.splice(index, 1);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async redo() {
        await this.execute();
    }

    canCompact() {
        return false;
    }
}

export class ClearCommand extends Command {
    constructor(options) {
        super('clear');
        this.savedStrokeHistory = options.savedStrokeHistory || [];
        this.savedBaseImageURL = options.savedBaseImageURL || null;
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.baseImageURLRef = options.baseImageURLRef;
        this.baseImageObjRef = options.baseImageObjRef;
        this.redrawFn = options.redrawFn;
        this.loadBaseImageFn = options.loadBaseImageFn;
    }

    async execute() {
        this.strokeHistoryRef.length = 0;
        this.baseImageURLRef.value = null;
        this.baseImageObjRef.value = null;
        if (this.redrawFn) await this.redrawFn();
    }

    async undo() {
        this.strokeHistoryRef.length = 0;
        this.savedStrokeHistory.forEach(s => this.strokeHistoryRef.push(s));
        
        this.baseImageURLRef.value = this.savedBaseImageURL;
        this.baseImageObjRef.value = null;
        
        if (this.savedBaseImageURL && this.loadBaseImageFn) {
            await this.loadBaseImageFn(this.savedBaseImageURL);
        } else if (this.redrawFn) {
            await this.redrawFn();
        }
    }

    async redo() {
        await this.execute();
    }

    canCompact() {
        return false;
    }
}

export class SnapshotCommand extends Command {
    constructor(options) {
        super('snapshot');
        this.beforeImageURL = options.beforeImageURL;
        this.afterImageURL = options.afterImageURL;
        this.beforeStrokes = options.beforeStrokes || [];
        this.afterStrokes = options.afterStrokes || [];
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.baseImageURLRef = options.baseImageURLRef;
        this.baseImageObjRef = options.baseImageObjRef;
        this.redrawFn = options.redrawFn;
        this.loadBaseImageFn = options.loadBaseImageFn;
    }

    async execute() {
        this.strokeHistoryRef.length = 0;
        this.afterStrokes.forEach(s => this.strokeHistoryRef.push(s));
        this.baseImageURLRef.value = this.afterImageURL;
        this.baseImageObjRef.value = null;
        if (this.afterImageURL && this.loadBaseImageFn) {
            await this.loadBaseImageFn(this.afterImageURL);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async undo() {
        this.strokeHistoryRef.length = 0;
        this.beforeStrokes.forEach(s => this.strokeHistoryRef.push(s));
        this.baseImageURLRef.value = this.beforeImageURL;
        this.baseImageObjRef.value = null;
        if (this.beforeImageURL && this.loadBaseImageFn) {
            await this.loadBaseImageFn(this.beforeImageURL);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async redo() {
        await this.execute();
    }

    canCompact() {
        return false;
    }
}

export async function executeCommand(command) {
    if (historyState.isExecuting) return;
    
    historyState.isExecuting = true;
    try {
        await command.execute();
        historyState.undoStack.push(command);
        historyState.redoStack = [];
        
        // 硬性上限保护：防止压缩失败时栈无限增长
        const HARD_LIMIT = MAX_HISTORY_STEPS * 2;
        if (historyState.undoStack.length > HARD_LIMIT) {
            console.warn(`undoStack 超过硬性上限(${HARD_LIMIT}), 强制裁剪`);
            const excessCount = historyState.undoStack.length - MAX_HISTORY_STEPS;
            historyState.undoStack.splice(0, excessCount);
        }
    } finally {
        historyState.isExecuting = false;
    }
    
    notifyStateChange();
}

export function canUndo() {
    return historyState.undoStack.length > 0;
}

export function canRedo() {
    return historyState.redoStack.length > 0;
}

export async function undo() {
    if (historyState.isExecuting || historyState.undoStack.length === 0) return null;
    
    historyState.isExecuting = true;
    let command;
    try {
        command = historyState.undoStack.pop();
        await command.undo();
        historyState.redoStack.push(command);
    } finally {
        historyState.isExecuting = false;
    }
    
    notifyStateChange();
    return command;
}

export async function redo() {
    if (historyState.isExecuting || historyState.redoStack.length === 0) return null;
    
    historyState.isExecuting = true;
    let command;
    try {
        command = historyState.redoStack.pop();
        await command.redo();
        historyState.undoStack.push(command);
    } finally {
        historyState.isExecuting = false;
    }
    
    notifyStateChange();
    return command;
}

export function clearHistory() {
    historyState.undoStack = [];
    historyState.redoStack = [];
    notifyStateChange();
}

export function clearRedoStack() {
    historyState.redoStack = [];
    notifyStateChange();
}

export function getUndoStackLength() {
    return historyState.undoStack.length;
}

export function getRedoStackLength() {
    return historyState.redoStack.length;
}

export function getUndoStack() {
    return historyState.undoStack;
}

export function getRedoStack() {
    return historyState.redoStack;
}

function notifyStateChange() {
    if (historyState.onStateChange) {
        historyState.onStateChange({
            canUndo: canUndo(),
            canRedo: canRedo(),
            undoCount: historyState.undoStack.length,
            redoCount: historyState.redoStack.length
        });
    }
}

export function shouldCompact() {
    return historyState.undoStack.length > MAX_HISTORY_STEPS;
}

export function getCommandsToCompact() {
    if (historyState.undoStack.length <= MAX_HISTORY_STEPS) {
        return [];
    }
    
    const compactCount = historyState.undoStack.length - MAX_HISTORY_STEPS;
    return historyState.undoStack.slice(0, compactCount);
}

export function compactHistory(snapshotCommand) {
    const compactCount = historyState.undoStack.length - MAX_HISTORY_STEPS;
    if (compactCount <= 0) return false;
    
    historyState.undoStack = [
        snapshotCommand,
        ...historyState.undoStack.slice(compactCount)
    ];
    
    notifyStateChange();
    return true;
}

export { historyState };
