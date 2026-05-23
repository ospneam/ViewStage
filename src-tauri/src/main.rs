// main.rs — ViewStage 应用入口

// 禁止移除：在 Windows Release 模式下隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    viewstage_lib::app_init_run()
}
