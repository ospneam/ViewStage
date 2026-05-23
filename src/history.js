/**
 * 撤销/重做系统 - 命令模式实现
 * 管理 undo/redo 栈，支持命令压缩快照
 */
export const MAX_HISTORY_STEPS = 50;

let history_state = {
    undo_list: [],
    redo_list: [],
    is_executing: false,
    on_state_change: null
};

/**
 * 初始化历史管理器
 * @param {Object} [options] - 配置项，on_state_change: 状态变化回调
 */
export function history_init_manager(options = {}) {
    history_state.undo_list = [];
    history_state.redo_list = [];
    history_state.is_executing = false;
    history_state.on_state_change = options.on_state_change || null;
}

// 命令基类，定义 execute/undo/redo 接口
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

    can_compact() {
        return true;
    }
}

// 绘制命令：向 strokeHistory 添加或移除一笔
export class DrawCommand extends Command {
    constructor(options) {
        super('draw');
        this.stroke = options.stroke;
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.redrawFn = options.redrawFn;
    }

    async execute(needRedraw = true) {
        if (!this.strokeHistoryRef.includes(this.stroke)) {
            this.strokeHistoryRef.push(this.stroke);
        }
        if (needRedraw && this.redrawFn) await this.redrawFn();
    }

    async undo() {
        const index = this.strokeHistoryRef.indexOf(this.stroke);
        if (index > -1) {
            this.strokeHistoryRef.splice(index, 1);
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async redo() {
        await this.execute(true);
    }

    can_compact() {
        return true;
    }
}

// 橡皮擦命令：向 strokeHistory 添加或移除一笔（标记为不可压缩）
export class EraseCommand extends Command {
    constructor(options) {
        super('erase');
        this.stroke = options.stroke;
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.redrawFn = options.redrawFn;
    }

    async execute(needRedraw = true) {
        if (!this.strokeHistoryRef.includes(this.stroke)) {
            this.strokeHistoryRef.push(this.stroke);
        }
        if (needRedraw && this.redrawFn) await this.redrawFn();
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

    can_compact() {
        return false;
    }
}

// 钢笔切割命令：将原始笔画替换为多条子笔画（按原始位置恢复）
export class PenEraseCommand extends Command {
    constructor(options) {
        super('pen_erase');
        this.pairs = options.pairs || [];
        this.strokeHistoryRef = options.strokeHistoryRef;
        this.redrawFn = options.redrawFn;
    }

    async execute(needRedraw = true) {
        for (const pair of this.pairs) {
            const idx = this.strokeHistoryRef.indexOf(pair.originalStroke);
            if (idx > -1) {
                pair.insertIndex = idx;
                this.strokeHistoryRef.splice(idx, 1, ...pair.subStrokes);
            }
        }
        if (needRedraw && this.redrawFn) await this.redrawFn();
    }

    async undo() {
        for (const pair of this.pairs) {
            for (let i = pair.subStrokes.length - 1; i >= 0; i--) {
                const idx = this.strokeHistoryRef.indexOf(pair.subStrokes[i]);
                if (idx > -1) this.strokeHistoryRef.splice(idx, 1);
            }
        }
        // 按原始位置升序插入，确保靠前的 original 先恢复，位置不偏移
        const sortedPairs = [...this.pairs].sort((a, b) => a.insertIndex - b.insertIndex);
        for (const pair of sortedPairs) {
            if (!this.strokeHistoryRef.includes(pair.originalStroke)) {
                const insertAt = Math.min(pair.insertIndex, this.strokeHistoryRef.length);
                this.strokeHistoryRef.splice(insertAt, 0, pair.originalStroke);
            }
        }
        if (this.redrawFn) await this.redrawFn();
    }

    async redo() {
        await this.execute(true);
    }

    can_compact() {
        return true;
    }
}

// 清空命令：记录清空前全部笔画和底图，可一键恢复
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

    can_compact() {
        return false;
    }
}

// 快照命令：用于压缩历史时的状态快照，记录压缩前后的状态
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

    can_compact() {
        return false;
    }
}

/**
 * 执行命令并压入 undo 栈，清空 redo 栈
 * 当 undo 栈超过硬性上限（MAX_HISTORY_STEPS * 2）时强制裁剪
 * @param {Command} command - 待执行命令
 * @param {boolean} [needRedraw=true] - 是否需要重绘
 */
export async function history_execute_command(command, needRedraw = true) {
    if (history_state.is_executing) return;

    history_state.is_executing = true;
    try {
        await command.execute(needRedraw);
        history_state.undo_list.push(command);
        history_state.redo_list = [];

        const HARD_LIMIT = MAX_HISTORY_STEPS * 2;
        if (history_state.undo_list.length > HARD_LIMIT) {
            console.warn(`undoStack 超过硬性上限(${HARD_LIMIT}), 强制裁剪`);
            const excessCount = history_state.undo_list.length - MAX_HISTORY_STEPS;
            history_state.undo_list.splice(0, excessCount);
        }
    } finally {
        history_state.is_executing = false;
    }

    history_handle_state_change();
}

/**
 * 检查是否可以撤销
 * @returns {boolean}
 */
export function history_validate_undo() {
    return history_state.undo_list.length > 0;
}

/**
 * 检查是否可以重做
 * @returns {boolean}
 */
export function history_validate_redo() {
    return history_state.redo_list.length > 0;
}

/**
 * 执行撤销：弹出 undo 栈顶命令并调用 undo()
 * @returns {Promise<Command|null>} 被撤销的命令，无命令可撤销时返回 null
 */
export async function history_handle_undo() {
    if (history_state.is_executing || history_state.undo_list.length === 0) return null;

    history_state.is_executing = true;
    let command;
    try {
        command = history_state.undo_list.pop();
        await command.undo();
        history_state.redo_list.push(command);
    } finally {
        history_state.is_executing = false;
    }

    history_handle_state_change();
    return command;
}

/**
 * 执行重做：弹出 redo 栈顶命令并调用 redo()
 * @returns {Promise<Command|null>} 被重做的命令，无命令可重做时返回 null
 */
export async function history_handle_redo() {
    if (history_state.is_executing || history_state.redo_list.length === 0) return null;

    history_state.is_executing = true;
    let command;
    try {
        command = history_state.redo_list.pop();
        await command.redo();
        history_state.undo_list.push(command);
    } finally {
        history_state.is_executing = false;
    }

    history_handle_state_change();
    return command;
}

/**
 * 清空 undo/redo 栈
 */
export function history_delete_all() {
    history_state.undo_list = [];
    history_state.redo_list = [];
    history_handle_state_change();
}

/**
 * 清空 redo 栈
 */
export function history_delete_redo_stack() {
    history_state.redo_list = [];
    history_handle_state_change();
}

/**
 * 获取 undo 栈长度
 * @returns {number}
 */
export function history_fetch_undo_length() {
    return history_state.undo_list.length;
}

/**
 * 获取 redo 栈长度
 * @returns {number}
 */
export function history_fetch_redo_length() {
    return history_state.redo_list.length;
}

/**
 * 获取 undo 栈引用
 * @returns {Array}
 */
export function history_fetch_undo_stack() {
    return history_state.undo_list;
}

/**
 * 获取 redo 栈引用
 * @returns {Array}
 */
export function history_fetch_redo_stack() {
    return history_state.redo_list;
}

// 触发状态变更回调
function history_handle_state_change() {
    if (history_state.on_state_change) {
        history_state.on_state_change({
            can_undo: history_validate_undo(),
            can_redo: history_validate_redo(),
            undoCount: history_state.undo_list.length,
            redoCount: history_state.redo_list.length
        });
    }
}

/**
 * 检查是否需要压缩（undo 栈超过 MAX_HISTORY_STEPS）
 * @returns {boolean}
 */
export function history_validate_compact() {
    return history_state.undo_list.length > MAX_HISTORY_STEPS;
}

/**
 * 获取需压缩的旧命令列表（超出 MAX_HISTORY_STEPS 的部分）
 * @returns {Array<Command>}
 */
export function history_fetch_commands_to_compact() {
    if (history_state.undo_list.length <= MAX_HISTORY_STEPS) {
        return [];
    }

    const compactCount = history_state.undo_list.length - MAX_HISTORY_STEPS;
    return history_state.undo_list.slice(0, compactCount);
}

/**
 * 将前 N 条旧命令替换为一条快照命令，完成压缩
 * @param {SnapshotCommand} snapshotCommand - 替换用的快照命令
 * @param {number} [explicitCount] - 显式指定压缩条数，不传则自动计算
 * @returns {boolean} 是否成功压缩
 */
export function history_format_compact(snapshotCommand, explicitCount) {
    const compactCount = explicitCount ?? (history_state.undo_list.length - MAX_HISTORY_STEPS);
    if (compactCount <= 0) return false;

    history_state.undo_list = [
        snapshotCommand,
        ...history_state.undo_list.slice(compactCount)
    ];

    history_handle_state_change();
    return true;
}

export { history_state };
