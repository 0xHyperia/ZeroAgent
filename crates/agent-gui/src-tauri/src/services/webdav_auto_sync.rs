//! 配置自动同步：把连续的配置变更合并成一次 WebDAV 上传。
//!
//! **只上传，不下载。** 自动拉取远端会在用户毫无察觉的情况下覆盖本机配置，
//! 出错方向不可接受，因此拉取永远是手动动作。

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,
};
use std::{cell::Cell, marker::PhantomData, rc::Rc};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{sync::mpsc, time::Duration};

/// 变更后等待这么久没有新变更才上传。
const DEBOUNCE: Duration = Duration::from_secs(1);
/// 防抖的硬上限。持续编辑（例如逐字输入 API Key）会不断刷新防抖窗口，
/// 没有上限的话可以无限推迟上传。
const MAX_WAIT: Duration = Duration::from_secs(10);

/// 自动同步结果事件。手动同步的成败由命令的返回值同步告知前端，
/// 不走这个事件 —— 所以收到事件就意味着「后台自动同步」。
const STATUS_EVENT: &str = "backup-sync-status-updated";

static DIRTY_TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static SUPPRESSION: AtomicUsize = AtomicUsize::new(0);
thread_local! { static STAGING: Cell<usize> = const { Cell::new(0) }; }

/// A working copy is private validation, not a committed configuration change.
/// This guard is thread-local and cannot suppress another profile's real writes.
pub(crate) struct ConfigurationStagingGuard(PhantomData<Rc<()>>);

pub(crate) fn staging() -> ConfigurationStagingGuard {
    STAGING.with(|depth| depth.set(depth.get() + 1));
    ConfigurationStagingGuard(PhantomData)
}

impl Drop for ConfigurationStagingGuard {
    fn drop(&mut self) {
        STAGING.with(|depth| depth.set(depth.get() - 1));
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoSyncStatus {
    /// 毫秒时间戳，仅成功时有值。
    last_sync_at: Option<i64>,
    last_error: Option<String>,
}

/// 抑制期计数器的 RAII 句柄。
pub struct AutoSyncSuppressionGuard;

impl Drop for AutoSyncSuppressionGuard {
    fn drop(&mut self) {
        SUPPRESSION.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 下载并应用远端快照期间必须持有。
///
/// 应用快照走的是各配置域的 `save_*`，它们会标脏；
/// 不抑制就会把刚从远端拉下来的数据原样推回去。
pub fn suppress() -> AutoSyncSuppressionGuard {
    SUPPRESSION.fetch_add(1, Ordering::SeqCst);
    AutoSyncSuppressionGuard
}

/// 标记配置已变更。未启动自动同步任务时为空操作（单测环境即如此）。
pub fn mark_dirty() {
    if suppressed() {
        return;
    }
    if let Some(tx) = DIRTY_TX.get() {
        notify_dirty(tx);
    }
}

fn notify_dirty(tx: &mpsc::Sender<()>) {
    if !STAGING.with(|depth| depth.get() > 0) {
        let _ = tx.try_send(());
    }
}

fn suppressed() -> bool {
    SUPPRESSION.load(Ordering::SeqCst) > 0
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel(1);
    if DIRTY_TX.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(run(app, rx));
}

async fn run(app: AppHandle, mut rx: mpsc::Receiver<()>) {
    // Canonical settings can change through K-brain/Gateway while the WebView is suspended.
    // Poll only the opted-in backup path; a persisted digest prevents unchanged uploads.
    let period = Duration::from_secs(5);
    let mut poll = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        // 空闲时阻塞在这里，第一个脏信号开启一个防抖窗口。
        tokio::select! {
            signal = rx.recv() => { if signal.is_none() { return; } },
            _ = poll.tick() => { sync_once(&app).await; continue; },
        }

        let cap = tokio::time::sleep(MAX_WAIT);
        tokio::pin!(cap);
        loop {
            tokio::select! {
                // 静默满 DEBOUNCE：窗口内的所有变更合并成下面这一次上传。
                _ = tokio::time::sleep(DEBOUNCE) => break,
                // 一直有新变更时也不能无限等。
                _ = &mut cap => break,
                signal = rx.recv() => {
                    if signal.is_none() {
                        return;
                    }
                }
            }
        }

        sync_once(&app).await;
    }
}

async fn sync_once(app: &AppHandle) {
    // 防抖期间用户可能开始了手动下载，这里再确认一次。
    //
    // 直接 return 会丢掉这次已经被 `rx.recv()` 消费掉的脏信号（通道容量 1，
    // 且抑制期内 `mark_dirty` 是空操作，不会有新信号补进来），于是抑制窗口里
    // 攒下的所有本地改动永远等不到下一次上传。补一次标脏：此刻 SUPPRESSION
    // 尚未归零，`mark_dirty` 仍会被挡掉，所以要绕过它直接投递。
    //
    // 代价是抑制期间这里每 DEBOUNCE（1s）空转一次，直到守卫释放。下载是秒级
    // 操作，多几次纯内存的重投递不值得为它引入条件变量之类的额外机制。
    if suppressed() {
        if let Some(tx) = DIRTY_TX.get() {
            let _ = tx.try_send(());
        }
        return;
    }

    match crate::commands::settings::auto_upload_backup_snapshot(app).await {
        // 未开启自动同步或凭据不全，静默跳过，不打扰用户。
        Ok(None) => {}
        Ok(Some(last_sync_at)) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: Some(last_sync_at),
                last_error: None,
            },
        ),
        // 自动同步失败不能阻塞任何操作，只推事件让 UI 显示横幅。
        Err(error) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: None,
                last_error: Some(error),
            },
        ),
    }
}

fn emit_status(app: &AppHandle, status: AutoSyncStatus) {
    if let Err(error) = app.emit(STATUS_EVENT, status) {
        eprintln!("failed to emit backup sync status: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_copy_validation_cannot_publish_dirty_but_other_threads_can_commit() {
        let (tx, mut rx) = mpsc::channel(1);
        let outer = staging();
        notify_dirty(&tx);
        {
            let _inner = staging();
            notify_dirty(&tx);
        }
        assert!(rx.try_recv().is_err());
        let other = tx.clone();
        std::thread::spawn(move || notify_dirty(&other))
            .join()
            .unwrap();
        assert!(
            rx.try_recv().is_ok(),
            "one working copy must not suppress another profile's commit"
        );
        drop(outer);
        notify_dirty(&tx);
        assert!(
            rx.try_recv().is_ok(),
            "only the real commit publishes the staged change"
        );
    }

    #[test]
    fn abandoned_working_copy_restores_dirty_notifications() {
        let (tx, mut rx) = mpsc::channel(1);
        let _ = std::panic::catch_unwind(|| {
            let _staging = staging();
            panic!("fixture validation failure");
        });
        notify_dirty(&tx);
        assert!(rx.try_recv().is_ok());
    }

    /// 抑制的进入/嵌套/退出合并成一个用例：`SUPPRESSION` 是进程级全局，
    /// 拆成多个用例会在并行测试下互相踩踏。
    #[test]
    fn suppression_is_reference_counted_and_gates_dirty_marks() {
        assert!(!suppressed(), "初始状态不应处于抑制期");

        let outer = suppress();
        assert!(suppressed());
        // 抑制期内标脏必须无效，否则应用远端快照会立刻把数据推回远端。
        mark_dirty();

        {
            let _inner = suppress();
            assert!(suppressed());
        }
        // 内层释放不能提前解除外层的抑制。
        assert!(suppressed(), "仍有外层 guard 存活时必须保持抑制");

        drop(outer);
        assert!(!suppressed(), "全部 guard 释放后应恢复标脏");
    }

    /// 容量 1 的 channel 把窗口内的多次变更压成一个信号 —— 这是防抖合并的基础。
    #[test]
    fn dirty_channel_coalesces_bursts_into_one_signal() {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        for _ in 0..5 {
            let _ = tx.try_send(());
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err(), "5 次变更只应留下 1 个待处理信号");
    }
}
