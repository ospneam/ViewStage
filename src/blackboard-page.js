/**
 * ViewStage 小黑板多页管理器
 * 管理黑板的多个页面，每页维护独立的笔画历史和快照
 */

export class BlackboardPageManager {
    constructor() {
        this.pages_list = [];
        this.current_index = -1;
    }

    init() {
        this.pages_list = [];
        this.current_index = -1;
        this.add_page();
    }

    get_page_count() {
        return this.pages_list.length;
    }

    get_current_page() {
        if (this.current_index < 0 || this.current_index >= this.pages_list.length) return null;
        return this.pages_list[this.current_index];
    }

    add_page() {
        const page = {
            stroke_history: [],
            snapshot_url: null,
        };
        this.pages_list.push(page);
        this.current_index = this.pages_list.length - 1;
        return this.current_index;
    }

    switch_page(index) {
        if (index < 0 || index >= this.pages_list.length) return false;
        if (index === this.current_index) return false;

        this.current_index = index;

        return true;
    }

    nav_prev() {
        if (this.current_index <= 0) return false;
        return this.switch_page(this.current_index - 1);
    }

    nav_next() {
        if (this.current_index >= this.pages_list.length - 1) {
            return false;
        }
        return this.switch_page(this.current_index + 1);
    }

    delete_page(index) {
        if (this.pages_list.length <= 1) return false;
        if (index < 0 || index >= this.pages_list.length) return false;

        this.pages_list.splice(index, 1);
        if (this.current_index >= this.pages_list.length) {
            this.current_index = this.pages_list.length - 1;
        }
        return true;
    }

    destroy() {
        this.pages_list = [];
        this.current_index = -1;
    }
}
