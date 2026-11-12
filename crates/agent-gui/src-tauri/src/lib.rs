mod commands;
mod runtime;
mod services;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;
#[cfg(desktop)]
use tauri::WindowEvent;
#[cfg(mobile)]
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(mobile)]
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
/// 等待原生全屏退出完成的兜底时长;超时仍未收到通知就直接隐藏。
#[cfg(target_os = "macos")]
const FULLSCREEN_EXIT_HIDE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
// Only size + maximized are persisted: POSITION would fight multi-monitor
// layouts we don't manage, VISIBLE would re-show a tray-hidden window on
// startup, and DECORATIONS would override the per-platform window chrome
// (Windows runs undecorated with custom chrome).
#[cfg(desktop)]
pub(crate) const WINDOW_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::SIZE
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);
#[cfg(desktop)]
const TRAY_SHOW_MENU_ON_LEFT_CLICK: bool = !cfg!(target_os = "windows");
#[cfg(desktop)]
const TERMINAL_EXIT_REQUESTED_EVENT: &str = "terminal:exit-requested";
#[cfg(desktop)]
/// 统一的「前端动作」事件：托盘菜单与全局快捷键中需要前端语义的动作
/// （开会话/新建对话/切工作空间/改主题/停止运行等）都经此事件转发，
/// 两端各自监听并只处理自己拥有的 action（App.tsx / ChatPage.tsx）。
const APP_ACTION_EVENT: &str = "app:action";
#[cfg(desktop)]
/// Rust 直连动作的结果反馈（如托盘触发 cron）：前端收到后 toast 呈现。
const APP_ACTION_FEEDBACK_EVENT: &str = "app:action-feedback";

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitRequestedEvent {
    running_count: usize,
}

pub fn app_version() -> &'static str {
    env!("ZEROAGENT_APP_VERSION")
}

#[cfg(desktop)]
macro_rules! app_invoke_handler {
    () => {{
        let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            // Chat history
            services::device_credentials::device_default_name,
            services::device_credentials::zeroagent_app_version,
            services::desktop_oauth::desktop_oauth_login,
            services::account_session::api::account_session_bootstrap,
            services::account_session::api::account_session_import_legacy,
            services::account_session::api::account_session_current,
            services::account_session::api::account_session_http,
            services::account_session::api::account_session_logout,
            services::account_session::api::account_session_reveal_key,
            services::account_session::gateway::account_gateway_http,
            services::account_session::gateway::account_device_register,
            services::account_session::gateway::account_device_identity,
            services::account_session::gateway::account_device_rotate,
            services::account_session::gateway::account_gateway_socket_connect,
            services::account_session::gateway::account_gateway_socket_send,
            services::account_session::gateway::account_gateway_socket_close,
            services::account_session::desktop_remote::account_remote_open,
            services::account_session::desktop_remote::account_remote_http,
            services::account_session::desktop_remote::account_remote_close,
            services::account_session::desktop_cloud::account_cloud_open,
            services::account_session::desktop_cloud::account_cloud_fetch,
            services::account_session::desktop_cloud::account_cloud_read,
            services::account_session::desktop_cloud::account_cloud_close,
            services::account_session::desktop_cloud::account_workspace_handoff,
            commands::chat_history::chat_history_list,
            commands::chat_history::chat_history_workdirs,
            commands::chat_history::chat_history_shared_list,
            commands::chat_history::chat_history_search,
            commands::chat_history::chat_history_get_window,
            commands::chat_history::chat_history_upsert,
            commands::chat_history::chat_history_upsert_active_segment,
            commands::chat_history::chat_history_append_segment,
            commands::chat_history::chat_history_rename,
            commands::chat_history::chat_history_branch,
            commands::chat_history::chat_history_replace_from_message,
            commands::chat_history::chat_history_set_pinned,
            commands::chat_history::chat_history_set_model,
            commands::chat_history::chat_history_set_cwd,
            commands::chat_history::chat_history_share_get,
            commands::chat_history::chat_history_share_set,
            commands::chat_history::chat_history_delete,
            commands::chat_history::legacy_history_migration_page,
            commands::chat_history::legacy_history_migration_signature,
            commands::planning::planning_migrate_legacy,
            // Trajectory (events ride the owning history segment)
            commands::chat_history::trajectory_append_events,
            commands::chat_history::trajectory_get_events,
            commands::chat_history::trajectory_get_window,
            commands::chat_history::trajectory_resolve_turn_number,
            commands::chat_history::trajectory_get_subagent_runs,
            commands::chat_history::trajectory_put_sections,
            commands::chat_history::trajectory_get_sections,
            // Subagent store
            commands::subagent_store::subagent_identity_upsert,
            commands::subagent_store::subagent_identity_list,
            commands::subagent_store::subagent_run_save,
            commands::subagent_store::subagent_run_list,
            commands::subagent_store::subagent_run_load,
            commands::subagent_store::subagent_run_prune,
            commands::subagent_store::subagent_message_append,
            commands::subagent_store::subagent_message_list,
            // File system
            commands::fs::fs_read_text,
            commands::fs::fs_read_editable_text,
            commands::fs::fs_path_status,
            commands::fs::fs_read_image_source,
            commands::fs::fs_read_workspace_image,
            commands::fs::fs_read_workspace_preview_asset,
            commands::fs::fs_write_text,
            commands::fs::fs_edit_text,
            commands::fs::fs_delete,
            commands::fs::fs_open_workspace_path,
            #[cfg(desktop)]
            commands::fs::fs_workspace_file_apps,
            #[cfg(desktop)]
            commands::fs::fs_open_workspace_file_app,
            commands::fs::fs_save_workspace_copy,
            commands::fs::fs_workspace_editor_targets,
            commands::fs::fs_open_workspace_editor,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_roots,
            commands::fs::fs_list_dirs,
            commands::fs::fs_list,
            commands::fs::fs_glob,
            commands::fs::fs_grep,
            commands::fs::fs_mention_list,
            // 会话检查点(rewind)
            commands::checkpoint::checkpoint_begin_turn,
            commands::checkpoint::checkpoint_list,
            commands::checkpoint::checkpoint_diff_stats,
            commands::checkpoint::checkpoint_rewind_code,
            commands::checkpoint::checkpoint_clear,
            commands::chat_file_links::open_chat_file_link,
            commands::root_grants::workspace_root_grants_list,
            commands::root_grants::workspace_root_grants_apply,
            commands::root_grants::workspace_root_grants_revoke,
            // Subagent worktrees
            commands::subagent_worktree::subagent_worktree_create,
            commands::subagent_worktree::subagent_worktree_status,
            commands::subagent_worktree::subagent_worktree_apply,
            commands::subagent_worktree::subagent_worktree_cleanup,
            // Browser automation
            commands::browser::browser_action,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::workbench_browser,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::workbench_browser_open,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::workbench_browser_connect,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::extensions::workbench_browser_extensions,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::extensions::workbench_browser_prepare_store_extension,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::loopback::workbench_browser_loopback,
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::annotation_relay::workbench_browser_submit_annotations,
            commands::browser::browser_status,
            commands::browser::browser_close,
            commands::browser::browser_extension_install_info,
            commands::browser::browser_extension_reveal_dir,
            // MCP
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            // MCP OAuth
            commands::mcp_oauth::mcp_oauth_authorize,
            commands::mcp_oauth::mcp_oauth_status,
            commands::mcp_oauth::mcp_oauth_clear,
            // Memory
            commands::memory::memory_list,
            commands::memory::memory_read,
            commands::memory::memory_search,
            commands::memory::memory_write,
            commands::memory::memory_update,
            commands::memory::memory_delete,
            commands::memory::memory_delete_project,
            commands::memory::memory_accept,
            commands::memory::memory_apply_batch,
            commands::memory::memory_organize_run_create,
            commands::memory::memory_organize_run_update,
            commands::memory::memory_organize_run_list,
            commands::memory::memory_organize_run_read,
            commands::memory::memory_organize_run_clear_history,
            commands::memory::memory_organize_due_claim,
            commands::memory::memory_organize_due_complete,
            commands::memory::memory_index_overview,
            commands::memory::memory_paths_info,
            commands::memory::memory_recent_rejections,
            commands::memory::memory_today_local_date,
            commands::memory::memory_today_daily,
            commands::memory::memory_quota_summary,
            commands::memory::memory_wipe_all,
            // Settings
            commands::settings::settings_load_all,
            commands::settings::settings_save_canonical_batch,
            commands::settings::settings_save_ui_preferences,
            commands::settings::settings_list_ccswitch_providers,
            commands::settings::settings_list_cherry_studio_providers,
            commands::settings::settings_list_cherry_studio_providers_from_path,
            commands::settings::settings_reset_ssh_known_host,
            commands::settings::settings_kbrain_ssh_state,
            commands::settings::settings_reveal_stt_secret,
            services::stt::settings_test_stt,
            services::stt::stt_request_microphone_permission,
            services::stt::stt_start,
            services::stt::stt_send_audio,
            services::stt::stt_stop,
            services::stt::stt_cancel,
            commands::settings::settings_backup_export,
            commands::settings::settings_backup_peek_import,
            commands::settings::settings_backup_apply_import,
            commands::settings::settings_backup_load_sync_config,
            commands::settings::settings_backup_save_sync_config,
            commands::settings::settings_backup_test_sync_connection,
            commands::settings::settings_backup_fetch_remote_info,
            commands::settings::settings_backup_upload,
            commands::settings::settings_backup_download,
            commands::update::app_update_check,
            commands::update::app_update_install,
            commands::update::app_release_announcement,
            commands::update::app_release_announcement_preview,
            commands::update::app_restart,
            commands::app::app_runtime_platform,
            commands::app::app_frontend_ready,
            commands::app::app_set_close_window_behavior,
            commands::app::app_set_global_shortcuts,
            commands::app::app_run_shortcut,
            commands::app::app_window_pinned,
            commands::app::app_toggle_window_pin,
            commands::app::app_confirmed_exit,
            commands::app::app_macos_traffic_light_metrics,
            commands::tray::app_tray_menu_sync,
            // Hooks
            commands::hook::hook_run_script,
            commands::hook::hook_run_http_requests,
            commands::hook::hook_cancel_scope,
            // Automation (cron tasks + hooks store)
            commands::planning::planning_query,
            commands::planning::planning_mutate,
            commands::planning::planning_export,
            commands::planning::planning_set_labels,
            commands::planning::planning_notification_test,
            commands::notifications::chat_notification_deliver,
            commands::notifications::app_set_badge_count,
            commands::planning::planning_subscription,
            commands::planning::planning_import,
            commands::cron::cron_validate_expression,
            commands::cron::automation_snapshot,
            commands::cron::automation_cron_apply,
            commands::cron::automation_hooks_apply,
            commands::cron::automation_list_runs,
            commands::cron::automation_cron_occurrences,
            commands::cron::automation_clear_runs,
            commands::cron::automation_run_cron_now,
            commands::cron::automation_claim_prompt_runs,
            commands::cron::automation_release_prompt_run,
            commands::cron::automation_complete_prompt_run,
            // Local command execution
            commands::shell::shell_run,
            commands::shell::shell_session_start,
            commands::shell::shell_session_wait,
            commands::shell::shell_session_stop,
            commands::shell::runtime_cancel,
            commands::process::managed_process_start,
            commands::process::managed_process_status,
            commands::process::managed_process_stop,
            commands::process::managed_process_read_log,
            commands::process::managed_process_wait,
            commands::process::managed_process_snapshot,
            commands::process::managed_process_clear,
            commands::terminal::terminal_shell_options,
            commands::terminal::terminal_list,
            commands::terminal::terminal_create,
            commands::terminal::terminal_create_ssh,
            commands::terminal::terminal_answer_ssh_prompt,
            commands::terminal::terminal_cancel_ssh_prompt,
            commands::terminal::terminal_ssh_reconnect,
            commands::terminal::terminal_ssh_enable_sftp,
            commands::terminal::terminal_ssh_latency,
            commands::terminal::terminal_ssh_exec,
            commands::terminal::terminal_ssh_local_forward_start,
            commands::terminal::terminal_ssh_local_forward_list,
            commands::terminal::terminal_ssh_local_forward_stop,
            commands::terminal::terminal_ssh_local_forward_check_port,
            commands::terminal::ssh_terminal_tabs_list,
            commands::terminal::ssh_terminal_tab_open,
            commands::terminal::ssh_terminal_tab_close,
            commands::terminal::terminal_stream_attach,
            commands::terminal::terminal_stream_input,
            commands::terminal::terminal_stream_resize,
            commands::terminal::terminal_rename,
            commands::terminal::terminal_close,
            commands::terminal::terminal_close_project,
            commands::terminal::terminal_read_tail,
            commands::sftp::sftp_list,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_transfer,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_transfer_status,
            commands::git::git_status,
            commands::git::git_discover_repositories,
            commands::git::git_branches,
            commands::git::git_init,
            commands::git::git_clone_repository,
            commands::git::git_clone_repository_start,
            commands::git::git_clone_repository_tasks,
            commands::git::git_clone_repository_cancel,
            commands::git::git_clone_repository_dismiss,
            commands::git::git_list_remote_branches,
            commands::git::git_switch_branch,
            commands::git::git_create_branch,
            commands::git::git_create_worktree,
            commands::git::git_remove_worktree,
            commands::git::git_diff,
            commands::git::revision_preview::git_workspace_diff_preview,
            commands::git::turn_review::git_workspace_turn_review,
            commands::git::git_log,
            commands::git::git_commit_details,
            commands::git::git_compare_commit_with_remote,
            commands::git::git_commit_diff,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_unstage_all,
            commands::git::git_discard,
            commands::git::git_discard_all,
            commands::git::git_add_to_gitignore,
            commands::git::git_open_system_file_location,
            commands::git::git_commit,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_set_remote,
            commands::git::git_push,
            commands::git::git_delete_branch,
            commands::git::git_rename_branch,
            commands::git::git_stash_push,
            commands::git::git_stash_pop,
            commands::fonts::system_list_font_families,
            commands::proxy_detect::system_proxy_detect,
            commands::proxy_detect::system_proxy_test,
            commands::system::system_pick_folder,
            commands::system::system_resolve_dropped_workspace_folders,
            commands::system::system_classify_dropped_paths,
            commands::system::system_pick_file,
            commands::system::system_sandbox_capability,
            commands::system::system_save_preview_file,
            commands::image_export::image_export_asset,
            commands::system::system_create_project_folder,
            commands::system::system_import_pasted_texts,
            commands::system::system_import_readable_file_paths,
            commands::system::system_import_uploaded_readable_files,
            commands::system::system_pick_readable_files,
            commands::system::system_read_uploaded_image_preview,
            commands::system::system_upload_staging_base,
            commands::system::system_open_uploaded_image,
            commands::system::system_prepare_preview_file_save,
            commands::system::system_write_preview_file,
            commands::system::system_clipboard_write_image,
            commands::system::system_prepare_uploaded_image_clipboard,
            commands::system::system_clipboard_write_uploaded_image,
            commands::system::system_read_uploaded_native_attachment,
            commands::system::system_list_skill_files,
            commands::system::system_ensure_builtin_skills,
            commands::system::system_read_skill_metadata,
            commands::system::system_read_skill_text,
            commands::system::system_manage_skill,
            commands::system::system_append_debug_jsonl,
            commands::system::system_begin_power_activity,
            commands::system::system_end_power_activity,
            commands::system::system_clipboard_read_text,
            commands::cua_driver::cua_driver_probe,
            commands::cua_driver::cua_driver_install_command,
            commands::cua_driver::cua_driver_install,
            commands::cua_driver::cua_driver_permissions_status,
            commands::cua_driver::cua_driver_permissions_grant,
            commands::cua_driver::cua_driver_self_identity,
            commands::cua_driver::cua_driver_self_windows,
            commands::cua_driver::cua_driver_frontmost_pid,
            commands::cua_driver::cua_driver_list_installed_apps,
            commands::gateway::gateway_connect,
            commands::gateway::gateway_disconnect,
            commands::gateway::gateway_status,
            commands::gateway::gateway_nudge_connection,
            commands::gateway::gateway_send_chat_ingress_batch,
            commands::gateway::gateway_commit_chat_checkpoint,
            commands::gateway::gateway_chat_claim_next,
            commands::gateway::gateway_chat_mark_started,
            commands::gateway::gateway_chat_mark_local_started,
            commands::gateway::gateway_chat_mark_local_cancelled,
            commands::gateway::gateway_chat_mark_queued_in_gui,
            commands::gateway::gateway_chat_complete,
            commands::gateway::gateway_chat_fail,
            commands::gateway::gateway_chat_cancel_request,
            commands::gateway::gateway_chat_heartbeat,
            commands::gateway::gateway_chat_runtime_heartbeat,
            commands::gateway::gateway_chat_release_lease,
            commands::gateway::gateway_chat_queue_respond,
            commands::gateway::gateway_clarify_respond,
            commands::gateway::gateway_composer_action_respond,
            commands::gateway::gateway_clarify_delta,
            commands::gateway::gateway_publish_chat_queue_event,
            commands::gateway::gateway_publish_settings_sync,
            commands::gateway::gateway_publish_history_sync_v2,
            commands::gateway::gateway_tunnel_state,
            commands::gateway::gateway_tunnel_create,
            commands::gateway::gateway_tunnel_update,
            commands::gateway::gateway_tunnel_close,
            commands::gateway::gateway_tunnel_check,
            commands::gateway::workspace_watch_set,
            commands::gateway::provider_usage_query,
            commands::gateway::provider_usage_test,
            services::proxy::proxy_get_server_info,
            services::kbrain_backend::kbrain_backend_connection,
            services::kbrain_backend::kbrain_file_runtime_ready,
            services::kbrain_backend::kbrain_backend_activate_profile,
            services::kbrain_backend::kbrain_managed_credentials_replace,
        ];
        move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            let command = invoke.message.command();
            let bootstrap = command.starts_with("account_session_")
                || command.starts_with("account_gateway_")
                || command.starts_with("account_device_")
                || command.starts_with("account_remote_")
                || command.starts_with("account_cloud_")
                || command.starts_with("plugin:")
                || matches!(
                    command,
                    "desktop_oauth_login"
                        | "kbrain_backend_activate_profile"
                        | "app_frontend_ready"
                        | "zeroagent_app_version"
                        | "device_default_name"
                );
            let allowed = bootstrap
                || invoke
                    .message
                    .webview_ref()
                    .app_handle()
                    .try_state::<Arc<services::kbrain_backend::KBrainBackendState>>()
                    .is_some_and(|state| state.allows_profile_commands());
            if !allowed {
                invoke
                    .resolver
                    .reject("Verify the ZeroAgent profile before using native data or tools");
                return true;
            }
            handler(invoke)
        }
    }};
}

#[cfg(desktop)]
fn start_account_session_lifecycle(app: &tauri::AppHandle) {
    let account = app
        .state::<Arc<services::account_session::AccountSessionState>>()
        .inner()
        .clone();
    let sockets = app
        .state::<Arc<services::account_session::gateway::AccountSocketState>>()
        .inner()
        .clone();
    let remote = app
        .state::<Arc<services::account_session::desktop_remote::RemoteGatewayState>>()
        .inner()
        .clone();
    let cloud = app
        .state::<Arc<services::account_session::desktop_cloud::CloudGatewayState>>()
        .inner()
        .clone();
    let mut ended = account.subscribe_ended();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tokio::select! {
                event=ended.recv()=>{
                    let Ok(event)=event else{continue;};
                    #[cfg(target_os = "windows")]
                    commands::integration_commands::workbench_browser::close_for_account(&app, event.handle.clone());
                    sockets.close_session(&event.handle).await;
                    cloud.retire(&event.handle);
                    remote.close_session(&account, &event.handle).await;
                    let matched=app.state::<Arc<services::kbrain_backend::KBrainBackendState>>().close_account_session(&event.handle);
                    if matched {
                        if let Some(gateway)=app.try_state::<Arc<services::gateway::GatewayController>>(){let _=gateway.disconnect_runtime();gateway.shutdown_local_gateway();}
                        let _=services::device_credentials::deactivate_device_credential();
                        if let Some(terminals)=app.try_state::<Arc<runtime::terminal::TerminalSessionRegistry>>(){terminals.shutdown_cleanup();}
                        if let Some(shells)=app.try_state::<Arc<runtime::shell_session::ShellSessionManager>>(){shells.shutdown_cleanup();}
                        if let Some(processes)=app.try_state::<Arc<runtime::managed_process::ManagedProcessRegistry>>(){processes.shutdown_cleanup();}
                    }
                    if event.persistent_cleared{let _=app.emit("account-session-ended",event.handle);}else{let _=app.emit("account-session-suspended",event.handle);}
                }
                _=interval.tick()=>{
                    if let Some(handle)=account.active_handle().await{let _=account.verified_current(&handle).await;}
                }
            }
        }
    });
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(ready_state) = app.try_state::<Arc<commands::app::FrontendReadyState>>() {
        if !ready_state.0.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    }

    Ok(())
}

#[cfg(desktop)]
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else if let Err(error) = show_main_window(app) {
            eprintln!("failed to show ZeroAgent window from global shortcut: {error}");
        }
    }
}

#[cfg(desktop)]
fn toggle_main_window_pin(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let pin_state = app.state::<Arc<commands::app::WindowPinState>>();
        let next = !pin_state.0.load(Ordering::SeqCst);
        match window.set_always_on_top(next) {
            Ok(()) => {
                pin_state.0.store(next, Ordering::SeqCst);
                if next {
                    if let Err(error) = show_main_window(app) {
                        eprintln!("failed to show ZeroAgent window when pinning: {error}");
                    }
                }
                let _ = app.emit("global-shortcut:pin-changed", next);
                // 托盘勾选与置顶真源（WindowPinState）同步；托盘可能尚未建好。
                if let Some(handles) = app.try_state::<Arc<services::tray::TrayMenuHandles>>() {
                    handles.set_pin_checked(next);
                }
            }
            Err(error) => eprintln!("failed to toggle ZeroAgent window pin: {error}"),
        }
    }
}

#[cfg(desktop)]
/// 应用级动作总线：全局快捷键与托盘菜单的动作都收敛到这里执行。
/// Rust 能独立完成的直接做（webview 卡死时托盘仍可用）；需要前端语义的
/// 经 [`APP_ACTION_EVENT`] 转发（部分动作先呼出主窗口）。
#[derive(Debug, Clone)]
enum AppAction {
    Summon,
    ToggleWindow,
    TogglePin,
    NewChat,
    SearchConversations,
    OpenConversation(String),
    ViewAllConversations,
    SwitchWorkspace(String),
    StopRun(String),
    StopAllRuns,
    ToggleCronTask(String),
    GatewayToggle,
    SetTheme(&'static str),
    OpenSettings,
    CheckUpdates,
    OpenDataDir,
    Quit,
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppActionEvent {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppActionFeedbackEvent {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 结果附加值（如 cron 开关后的 "enabled"/"disabled"）。
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[cfg(desktop)]
/// 托盘菜单项 ID → 动作。静态 ID 与动态前缀都定义在 `services::tray`。
fn tray_menu_action(id: &str) -> Option<AppAction> {
    use services::tray as tray_ids;
    match id {
        tray_ids::TRAY_SHOW_ID => Some(AppAction::Summon),
        tray_ids::TRAY_NEW_CHAT_ID => Some(AppAction::NewChat),
        tray_ids::TRAY_PIN_ID => Some(AppAction::TogglePin),
        tray_ids::TRAY_RECENT_VIEW_ALL_ID => Some(AppAction::ViewAllConversations),
        tray_ids::TRAY_RUN_STOP_ALL_ID => Some(AppAction::StopAllRuns),
        tray_ids::TRAY_GATEWAY_ID => Some(AppAction::GatewayToggle),
        tray_ids::TRAY_THEME_LIGHT_ID => Some(AppAction::SetTheme("light")),
        tray_ids::TRAY_THEME_DARK_ID => Some(AppAction::SetTheme("dark")),
        tray_ids::TRAY_THEME_SYSTEM_ID => Some(AppAction::SetTheme("system")),
        tray_ids::TRAY_SETTINGS_ID => Some(AppAction::OpenSettings),
        tray_ids::TRAY_CHECK_UPDATES_ID => Some(AppAction::CheckUpdates),
        tray_ids::TRAY_OPEN_DATA_DIR_ID => Some(AppAction::OpenDataDir),
        tray_ids::TRAY_QUIT_ID => Some(AppAction::Quit),
        _ => {
            if let Some(rest) = id.strip_prefix(tray_ids::TRAY_RECENT_PREFIX) {
                Some(AppAction::OpenConversation(rest.to_string()))
            } else if let Some(rest) = id.strip_prefix(tray_ids::TRAY_WORKSPACE_PREFIX) {
                Some(AppAction::SwitchWorkspace(rest.to_string()))
            } else if let Some(rest) = id.strip_prefix(tray_ids::TRAY_RUN_PREFIX) {
                Some(AppAction::StopRun(rest.to_string()))
            } else {
                id.strip_prefix(tray_ids::TRAY_CRON_PREFIX)
                    .map(|rest| AppAction::ToggleCronTask(rest.to_string()))
            }
        }
    }
}

#[cfg(desktop)]
/// 转发前端动作。`show_window` 用于用户预期看到界面反馈的动作
/// （开会话/新建对话/打开设置等）；后台型动作（停止运行/改主题/网关开关）
/// 不抢焦点。
fn forward_app_action(
    app: &tauri::AppHandle,
    action: &'static str,
    id: Option<String>,
    value: Option<String>,
    show_window: bool,
) {
    if show_window {
        if let Err(error) = show_main_window(app) {
            eprintln!("failed to show ZeroAgent window for action {action}: {error}");
        }
    }
    if let Err(error) = app.emit(APP_ACTION_EVENT, AppActionEvent { action, id, value }) {
        eprintln!("failed to emit app action {action}: {error}");
    }
}

#[cfg(desktop)]
fn dispatch_app_action(app: &tauri::AppHandle, action: AppAction) {
    match action {
        AppAction::Summon => {
            if let Err(error) = show_main_window(app) {
                eprintln!("failed to show ZeroAgent window: {error}");
            }
        }
        AppAction::ToggleWindow => toggle_main_window(app),
        AppAction::TogglePin => toggle_main_window_pin(app),
        AppAction::NewChat => forward_app_action(app, "new-chat", None, None, true),
        AppAction::SearchConversations => {
            forward_app_action(app, "search-conversations", None, None, true);
        }
        AppAction::OpenConversation(id) => {
            forward_app_action(app, "open-conversation", Some(id), None, true);
        }
        AppAction::ViewAllConversations => {
            forward_app_action(app, "view-all-conversations", None, None, true);
        }
        AppAction::SwitchWorkspace(id) => {
            forward_app_action(app, "switch-workspace", Some(id), None, true);
        }
        AppAction::StopRun(id) => forward_app_action(app, "stop-run", Some(id), None, false),
        AppAction::StopAllRuns => forward_app_action(app, "stop-all-runs", None, None, false),
        AppAction::GatewayToggle => forward_app_action(app, "gateway-toggle", None, None, false),
        AppAction::SetTheme(theme) => {
            forward_app_action(app, "set-theme", None, Some(theme.to_string()), false);
        }
        AppAction::OpenSettings => forward_app_action(app, "open-settings", None, None, true),
        AppAction::CheckUpdates => forward_app_action(app, "check-updates", None, None, true),
        AppAction::ToggleCronTask(task_id) => {
            // 托盘的定时任务子项是启用开关：翻转走 AutomationStore 唯一的
            // cron_apply 写路径（CAS），成功后 automation:cron-changed 会驱动
            // 前端 store 与托盘勾选自然刷新。开关是后台动作，不呼出主窗口；
            // 结果经 feedback 事件给前端 toast（窗口可见时提示文案）。
            let Some(store) = app.try_state::<Arc<services::automation::AutomationStore>>() else {
                return;
            };
            let store = Arc::clone(store.inner());
            let app_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let (value, error) = match store.toggle_cron_task_enabled(&task_id) {
                    Ok(enabled) => (
                        Some(if enabled { "enabled" } else { "disabled" }.to_string()),
                        None,
                    ),
                    Err(error) => {
                        eprintln!("failed to toggle cron task from tray: {error}");
                        (None, Some(error))
                    }
                };
                if let Err(emit_error) = app_handle.emit(
                    APP_ACTION_FEEDBACK_EVENT,
                    AppActionFeedbackEvent {
                        action: "toggle-cron-task",
                        id: Some(task_id),
                        ok: error.is_none(),
                        error,
                        value,
                    },
                ) {
                    eprintln!("failed to emit cron toggle feedback: {emit_error}");
                }
            });
        }
        AppAction::OpenDataDir => {
            use tauri_plugin_opener::OpenerExt;
            match commands::settings::config_dir() {
                Ok(dir) => {
                    if let Err(error) = app
                        .opener()
                        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
                    {
                        eprintln!("failed to open ZeroAgent data directory: {error}");
                    }
                }
                Err(error) => eprintln!("failed to resolve ZeroAgent data directory: {error}"),
            }
        }
        AppAction::Quit => {
            let allow_exit = app.state::<Arc<AtomicBool>>();
            let terminal_registry = app.state::<Arc<runtime::terminal::TerminalSessionRegistry>>();
            request_app_exit(app, allow_exit.inner(), terminal_registry.inner());
        }
    }
}

#[cfg(desktop)]
fn handle_global_shortcut(
    app: &tauri::AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
) {
    let action = app
        .state::<Arc<commands::app::GlobalShortcutRegistry>>()
        .lookup_action(shortcut);
    let Some(action) = action else {
        return;
    };
    run_shortcut_action(app, &action);
}

#[cfg(desktop)]
fn run_shortcut_action(app: &tauri::AppHandle, action: &str) {
    let action = match action {
        "summon" => AppAction::Summon,
        "toggle" => AppAction::ToggleWindow,
        "newChat" => AppAction::NewChat,
        "searchConversations" => AppAction::SearchConversations,
        "pin" => AppAction::TogglePin,
        _ => return,
    };
    dispatch_app_action(app, action);
}

/// 关闭按钮默认隐藏到托盘。macOS 原生全屏下直接隐藏会在独立 Space 留下一块黑屏,
/// 所以先退出全屏,等 AppKit 发出 `NSWindowDidExitFullScreenNotification` 再隐藏
/// (见 [`install_fullscreen_exit_observer`])。
#[cfg(desktop)]
fn hide_main_window_on_close(window: &tauri::Window, hide_after_fullscreen_exit: &Arc<AtomicBool>) {
    #[cfg(target_os = "macos")]
    if window.is_fullscreen().unwrap_or(false) {
        if hide_after_fullscreen_exit.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(error) = window.set_fullscreen(false) {
            eprintln!("failed to leave fullscreen before hiding ZeroAgent window: {error}");
            hide_after_fullscreen_exit.store(false, Ordering::SeqCst);
        } else {
            // 兜底:退出通知没到(过渡被打断等)时,也不能让关闭按钮失效。
            let window = window.clone();
            let pending = Arc::clone(hide_after_fullscreen_exit);
            std::thread::spawn(move || {
                std::thread::sleep(FULLSCREEN_EXIT_HIDE_TIMEOUT);
                if pending.swap(false, Ordering::SeqCst) {
                    let _ = window.hide();
                }
            });
            return;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = hide_after_fullscreen_exit;

    if let Err(error) = window.hide() {
        eprintln!("failed to hide ZeroAgent window on close: {error}");
    }
}

/// tao 在 `set_fullscreen(false)` 调用后立刻清掉自身的全屏状态,NSWindow 的
/// styleMask 也在过渡开始时就去掉 FullScreen 位;而 AppKit 在过渡结束、切回原
/// Space 时会重新显示窗口,在那之前隐藏会被撤销。只有 didExit 通知代表真正结束。
#[cfg(target_os = "macos")]
fn install_fullscreen_exit_observer(
    app: &tauri::App,
    hide_after_fullscreen_exit: Arc<AtomicBool>,
) -> tauri::Result<()> {
    use objc2_app_kit::{NSWindow, NSWindowDidExitFullScreenNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    let ns_window_ptr = window.ns_window()?;
    if ns_window_ptr.is_null() {
        return Ok(());
    }
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast::<NSWindow>() };

    let block = block2::RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| {
        if hide_after_fullscreen_exit.swap(false, Ordering::SeqCst) {
            if let Err(error) = window.hide() {
                eprintln!("failed to hide ZeroAgent window after leaving fullscreen: {error}");
            }
        }
    });
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidExitFullScreenNotification),
            Some(ns_window),
            None,
            &block,
        )
    };
    // 主窗口与应用同生命周期,观察者无需注销。
    std::mem::forget(observer);
    Ok(())
}

#[cfg(desktop)]
fn request_app_exit(
    app: &tauri::AppHandle,
    allow_exit: &AtomicBool,
    terminal_registry: &runtime::terminal::TerminalSessionRegistry,
) {
    let running_count = terminal_registry.running_session_count();
    if running_count > 0 {
        if let Err(error) = show_main_window(app) {
            eprintln!("failed to show ZeroAgent window before terminal exit confirm: {error}");
        }
        if let Err(error) = app.emit(
            TERMINAL_EXIT_REQUESTED_EVENT,
            TerminalExitRequestedEvent { running_count },
        ) {
            eprintln!("failed to request terminal exit confirmation: {error}");
        }
        return;
    }

    allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg(desktop)]
fn configure_system_tray(app: &tauri::App) -> tauri::Result<()> {
    let skeleton = services::tray::build_tray_menu_skeleton(app, app_version())?;
    let menu = skeleton.menu.clone();

    let mut tray_builder = TrayIconBuilder::new()
        .tooltip("ZeroAgent")
        .menu(&menu)
        .show_menu_on_left_click(TRAY_SHOW_MENU_ON_LEFT_CLICK)
        .on_menu_event(|app, event| {
            if let Some(action) = tray_menu_action(event.id().as_ref()) {
                dispatch_app_action(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("failed to show ZeroAgent window from tray double-click: {error}");
                }
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } => {
                // Windows 惯例：左键单击即激活主窗口（菜单在右键）。
                // 其他平台左键弹菜单（TRAY_SHOW_MENU_ON_LEFT_CLICK）。
                if cfg!(target_os = "windows") {
                    if let Err(error) = show_main_window(tray.app_handle()) {
                        eprintln!("failed to show ZeroAgent window from tray click: {error}");
                    }
                }
            }
            _ => {}
        });

    #[cfg(target_os = "macos")]
    {
        match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon-macos.png")) {
            Ok(icon) => {
                tray_builder = tray_builder.icon(icon).icon_as_template(true);
            }
            Err(error) => {
                eprintln!("failed to load macOS tray icon: {error}");
                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            tray_builder = tray_builder.icon(icon.clone());
        }
    }

    let tray = tray_builder.build(app)?;
    let handles = Arc::new(services::tray::TrayMenuHandles::new(
        skeleton,
        tray.clone(),
        app_version(),
    ));
    app.manage(tray);
    app.manage(handles);

    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_windows_window_chrome(app: &tauri::App) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.set_decorations(false)?;
    }

    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
fn mobile_oauth_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(mobile)]
#[tauri::command]
fn mobile_open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "external URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("external URL must use HTTP or HTTPS".to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(any(mobile, test))]
fn is_mobile_oauth_callback_url(url: &url::Url) -> bool {
    url.scheme() == "top.usa0.zeroagent"
        && url.host_str().is_none()
        && url.path() == "/oauth/callback"
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event
                    .urls()
                    .iter()
                    .find(|url| is_mobile_oauth_callback_url(url))
                {
                    let _ = handle.emit("mobile-oauth-callback", url.to_string());
                }
            });
            Ok(())
        })
        .manage(services::mobile_gateway::MobileGatewayState::default())
        .invoke_handler(tauri::generate_handler![
            mobile_oauth_open,
            mobile_open_external_url,
            services::mobile_gateway::mobile_gateway_bootstrap,
            services::mobile_gateway::mobile_gateway_logout,
            services::mobile_gateway::mobile_gateway_multipart_request,
            services::mobile_gateway::mobile_gateway_request,
            services::mobile_gateway::mobile_gateway_stream_open,
            services::mobile_gateway::mobile_gateway_stream_read,
            services::mobile_gateway::mobile_gateway_stream_close,
            services::mobile_gateway::mobile_gateway_socket_connect,
            services::mobile_gateway::mobile_gateway_socket_send,
            services::mobile_gateway::mobile_gateway_socket_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZeroAgent mobile WebView");
}

#[cfg(test)]
mod mobile_oauth_callback_tests {
    use super::is_mobile_oauth_callback_url;

    #[test]
    fn accepts_standard_private_use_uri_callback() {
        let url = url::Url::parse("top.usa0.zeroagent:/oauth/callback?code=code-1&state=state-1")
            .expect("valid callback URL");

        assert!(is_mobile_oauth_callback_url(&url));
    }

    #[test]
    fn rejects_authority_style_and_unrelated_deep_links() {
        for raw in [
            "top.usa0.zeroagent://oauth/callback?code=code-1",
            "top.usa0.zeroagent:/unrelated?code=code-1",
            "https://usa0.top/oauth/callback?code=code-1",
        ] {
            let url = url::Url::parse(raw).expect("valid test URL");
            assert!(!is_mobile_oauth_callback_url(&url), "accepted {raw}");
        }
    }
}

#[cfg(desktop)]
pub(crate) fn start_native_profile_services(app: &tauri::AppHandle) -> Result<(), String> {
    // Called under KBrainBackendState's profile lock, after verified scope selection. No store,
    // crash reconciliation or scheduler may capture the default/offline root before this point.
    if app
        .try_state::<Arc<services::gateway::GatewayController>>()
        .is_some()
    {
        return Ok(());
    }
    commands::history_db::initialize_history_db()?;
    let automation_store = Arc::new(services::automation::AutomationStore::open()?);
    let automation_scheduler = Arc::new(services::automation::AutomationScheduler::new(
        Arc::clone(&automation_store),
    ));
    let automation_profile = app
        .state::<Arc<services::kbrain_backend::KBrainBackendState>>()
        .inner()
        .clone();
    automation_scheduler.set_profile_guard(Arc::new(move || {
        automation_profile.allows_profile_commands()
    }));
    let memory_store = Arc::new(services::memory::MemoryStore::open()?);
    let managed_process_registry =
        Arc::new(runtime::managed_process::ManagedProcessRegistry::open());
    let gateway_controller = Arc::new(services::gateway::GatewayController::new(
        app.clone(),
        Arc::clone(
            app.state::<Arc<services::provider_usage::ProviderUsageService>>()
                .inner(),
        ),
        Arc::clone(
            app.state::<Arc<runtime::terminal::TerminalSessionRegistry>>()
                .inner(),
        ),
        Arc::clone(
            app.state::<Arc<runtime::sftp::SftpSessionRegistry>>()
                .inner(),
        ),
        Arc::clone(&managed_process_registry),
        Arc::clone(
            app.state::<Arc<commands::git::GitCloneTaskRegistry>>()
                .inner(),
        ),
    ));
    managed_process_registry.set_notifier(runtime::managed_process::ManagedProcessNotifier {
        app_handle: app.clone(),
        gateway: Arc::downgrade(&gateway_controller),
    });
    automation_store.set_notifier(services::automation::AutomationNotifier {
        app_handle: app.clone(),
        gateway: Arc::downgrade(&gateway_controller),
        scheduler: Arc::downgrade(&automation_scheduler),
    });
    app.manage(automation_store);
    app.manage(Arc::clone(&automation_scheduler));
    app.manage(memory_store);
    app.manage(Arc::clone(&managed_process_registry));
    app.manage(Arc::clone(&gateway_controller));
    if let Err(error) = commands::settings::initialize_system_proxy_from_db() {
        eprintln!("failed to initialize system proxy state: {error}");
    }
    commands::system::gc_upload_staging_on_startup();
    commands::system::start_directory_import_staging_gc();
    if let Err(error) = services::skills::ensure_builtin_agent_skills_sync() {
        eprintln!("failed to seed builtin skills: {error}");
    }
    if !runtime::data_home::isolation_requested()
        && std::env::var_os("ZEROAGENT_CONFIG_DIR").is_none()
    {
        app.state::<Arc<services::browser::BrowserManager>>()
            .start_extension_bridge();
    }
    services::webdav_auto_sync::start(app.clone());
    managed_process_registry.spawn_startup_reconcile();
    managed_process_registry.spawn_monitor();
    automation_scheduler.start();
    services::planning::start(app.clone());
    if let Err(error) = gateway_controller.start() {
        eprintln!("failed to start remote gateway controller: {error}");
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = gateway_controller.reload_from_db().await {
            eprintln!("failed to load remote gateway settings: {error}");
        }
    });
    Ok(())
}

#[cfg(desktop)]
pub fn run() {
    // 最早期钩子:若本进程是 Windows 沙箱的自我再执行启动器(__sandbox_exec),
    // 就在此建立受限令牌并运行真实命令,以其退出码退出——绝不继续初始化 Tauri。
    // 非 Windows 平台为空操作。
    runtime::windows_sandbox::run_sandbox_launcher_if_requested();

    // 必须先于任何 tauri::async_runtime 调用:换成栈更大的 tokio 运行时,
    // 否则调试版处理 Gateway 消息时会撑爆默认 2 MiB 的 worker 栈。
    runtime::async_runtime::install_tauri_async_runtime();

    let automation_store = Arc::new(
        services::automation::AutomationStore::open()
            .expect("failed to initialize LiveAgent automation store"),
    );
    let automation_scheduler = Arc::new(services::automation::AutomationScheduler::new(
        Arc::clone(&automation_store),
    ));
    let memory_store = Arc::new(
        services::memory::MemoryStore::open().expect("failed to initialize LiveAgent memory store"),
    );
    let provider_usage_service =
        Arc::new(services::provider_usage::ProviderUsageService::default());
    let power_activity = Arc::new(services::power_activity::PowerActivityManager::default());
    let shell_session_manager = Arc::new(runtime::shell_session::ShellSessionManager::default());
    runtime::shell_session::ShellSessionManager::start_cleaner(&shell_session_manager);
    let terminal_registry = Arc::new(runtime::terminal::TerminalSessionRegistry::default());
    let git_clone_task_registry = Arc::new(commands::git::GitCloneTaskRegistry::default());
    let sftp_registry = Arc::new(runtime::sftp::SftpSessionRegistry::new(Arc::clone(
        &terminal_registry,
    )));
    let allow_exit = Arc::new(AtomicBool::new(false));
    let hide_after_fullscreen_exit = Arc::new(AtomicBool::new(false));
    let close_window_behavior = Arc::new(commands::app::CloseWindowBehaviorState::new(
        commands::app::CLOSE_WINDOW_BEHAVIOR_MINIMIZE,
    ));
    let stt_manager = Arc::new(services::stt::SttManager::default());
    let browser_manager = Arc::new(services::browser::BrowserManager::default());

    let builder = tauri::Builder::default();
    // dev 构建与已安装正式版共享 identifier；若 dev 也注册单实例，
    // `tauri dev` 会把启动转发给正在运行的正式版然后自我退出。
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Err(error) = show_main_window(app) {
            eprintln!("failed to focus existing ZeroAgent instance: {error}");
        }
    }));

    let account_sessions = Arc::new(
        services::account_session::AccountSessionState::new()
            .expect("Native account transport must initialize"),
    );
    let account_sockets =
        Arc::new(services::account_session::gateway::AccountSocketState::default());
    let builder = builder
        .manage(Arc::clone(&account_sessions))
        .manage(Arc::clone(&account_sockets))
        .manage(Arc::new(
            services::account_session::desktop_remote::RemoteGatewayState::default(),
        ))
        .manage(Arc::new(
            services::account_session::desktop_cloud::CloudGatewayState::default(),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    // The development inspection bridge must never expose a release listener.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .base_port(
                std::env::var("ZEROAGENT_DEV_MCP_BRIDGE_PORT")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(9223),
            )
            .build(),
    );
    let app = builder
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        handle_global_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(Arc::new(commands::app::GlobalShortcutRegistry::default()))
        .manage(Arc::new(commands::app::FrontendReadyState::default()))
        .manage(Arc::new(commands::app::WindowPinState::default()))
        .manage(Arc::clone(&provider_usage_service))
        .manage(Arc::clone(&power_activity))
        .manage(Arc::new(
            services::kbrain_backend::KBrainBackendState::with_account_sessions(Arc::clone(
                &account_sessions,
            )),
        ))
        .manage(Arc::new(runtime::shell_runner::ShellRunRegistry::default()))
        .manage(Arc::clone(&shell_session_manager))
        .manage(Arc::clone(&terminal_registry))
        .manage(Arc::clone(&sftp_registry))
        .manage(Arc::clone(&git_clone_task_registry))
        .manage(Arc::clone(&allow_exit))
        .manage(Arc::clone(&close_window_behavior))
        .manage(Arc::new(commands::hook::HookScopeRegistry::default()))
        .manage(stt_manager)
        .manage(Arc::clone(&browser_manager))
        .on_page_load(|webview, payload| {
            if webview.label() != MAIN_WINDOW_LABEL
                || !matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                return;
            }
            let app = webview.app_handle();
            #[cfg(target_os = "windows")]
            commands::integration_commands::workbench_browser::close_all();
            if let Some(cloud) =
                app.try_state::<Arc<services::account_session::desktop_cloud::CloudGatewayState>>()
            {
                cloud.start_document();
            }
            if let Some(ready_state) = app.try_state::<Arc<commands::app::FrontendReadyState>>() {
                ready_state.0.store(false, Ordering::SeqCst);
            }
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                }
            }
        })
        .setup({
            let terminal_registry = Arc::clone(&terminal_registry);
            let sftp_registry = Arc::clone(&sftp_registry);
            #[cfg(target_os = "macos")]
            let hide_after_fullscreen_exit = Arc::clone(&hide_after_fullscreen_exit);
            move |app| {
                configure_system_tray(app)?;
                services::planning::notification::install(app.handle());
                #[cfg(target_os = "windows")]
                configure_windows_window_chrome(app)?;
                #[cfg(target_os = "macos")]
                install_fullscreen_exit_observer(app, hide_after_fullscreen_exit)?;
                #[cfg(target_os = "macos")]
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    runtime::webview_background::keep_webview_live_when_covered(&window);
                }
                app.manage(services::proxy::start_proxy_server()?);
                if let Some(backend) = app.try_state::<Arc<services::kbrain_backend::KBrainBackendState>>() {
                    services::kbrain_ssh_sync::install(Arc::clone(backend.inner()));
                }
                start_account_session_lifecycle(app.handle());
                // 浏览器扩展同步到 ~/.zeroagent/extension：Chrome 加载解压
                // 扩展记录绝对路径，必须给一个不随应用更新变化的目录。
                if let Err(error) = commands::browser::sync_bundled_browser_extension(app.handle())
                {
                    eprintln!("failed to sync browser extension: {error}");
                }
                terminal_registry.attach_app_handle(app.handle().clone());
                sftp_registry.attach_app_handle(app.handle().clone());
                Ok(())
            }
        })
        .on_window_event({
            let allow_exit = Arc::clone(&allow_exit);
            let close_window_behavior = Arc::clone(&close_window_behavior);
            let terminal_registry = Arc::clone(&terminal_registry);
            move |window, event| {
                if window.label() != MAIN_WINDOW_LABEL {
                    return;
                }

                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if commands::app::is_close_window_exit(&close_window_behavior) {
                        request_app_exit(window.app_handle(), &allow_exit, &terminal_registry);
                    } else {
                        hide_main_window_on_close(window, &hide_after_fullscreen_exit);
                    }
                }
            }
        })
        .invoke_handler(app_invoke_handler!())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app, event| match event {
        tauri::RunEvent::Resumed => {
            if let Some(gateway_controller) =
                _app.try_state::<Arc<services::gateway::GatewayController>>()
            {
                if let Err(error) = gateway_controller.nudge_connection("app_resumed", true) {
                    eprintln!("failed to nudge gateway connection after app resume: {error}");
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_main_window(_app) {
                eprintln!("failed to show ZeroAgent window from dock reopen: {error}");
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !allow_exit.load(Ordering::SeqCst) {
                let running_count = terminal_registry.running_session_count();
                if running_count > 0 {
                    if let Err(error) = show_main_window(_app) {
                        eprintln!(
                            "failed to show ZeroAgent window before terminal exit confirm: {error}"
                        );
                    }
                    if let Err(error) = _app.emit(
                        TERMINAL_EXIT_REQUESTED_EVENT,
                        TerminalExitRequestedEvent { running_count },
                    ) {
                        eprintln!("failed to request terminal exit confirmation: {error}");
                    }
                    api.prevent_exit();
                    return;
                }
            }
            {
                // Stop our backend before other cleanup can block or the OS exits.
                if let Some(backend) =
                    _app.try_state::<Arc<services::kbrain_backend::KBrainBackendState>>()
                {
                    backend.shutdown_for_exit();
                }
                if let Some(gateway) = _app.try_state::<Arc<services::gateway::GatewayController>>()
                {
                    gateway.shutdown_local_gateway();
                }
                terminal_registry.shutdown_cleanup();
                shell_session_manager.shutdown_cleanup();
                if let Some(registry) =
                    _app.try_state::<Arc<runtime::managed_process::ManagedProcessRegistry>>()
                {
                    registry.shutdown_cleanup();
                }
                git_clone_task_registry.shutdown_cleanup();
                browser_manager.shutdown_cleanup();
                power_activity.clear_all();
            }
        }
        tauri::RunEvent::Exit => {
            // Native macOS termination can bypass ExitRequested; Drop is not guaranteed.
            if let Some(backend) =
                _app.try_state::<Arc<services::kbrain_backend::KBrainBackendState>>()
            {
                backend.shutdown_for_exit();
            }
            if let Some(gateway) = _app.try_state::<Arc<services::gateway::GatewayController>>() {
                gateway.shutdown_local_gateway();
            }
        }
        _ => {}
    });
}
