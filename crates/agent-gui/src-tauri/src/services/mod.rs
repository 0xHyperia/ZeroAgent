pub mod account_identity;
#[cfg(desktop)]
pub mod account_session;
pub mod automation;
pub(crate) mod backend_facade;
pub mod backend_profile;
pub mod browser;
pub mod chat_run_ledger;
pub(crate) mod configuration_coordinator;
pub mod cua_driver;
#[cfg(desktop)]
pub mod desktop_oauth;
pub mod device_credentials;
pub mod gateway;
pub mod gateway_bridge;
pub mod kbrain_backend;
pub mod local_gateway;
pub mod managed_model_broker;
pub mod mcp_oauth;
pub mod memory;
pub mod mobile_gateway;
#[cfg(test)]
#[path = "mobile_gateway/session.rs"]
mod mobile_gateway_session_tests;
pub mod mobile_secure_store;
pub mod planning;
pub mod power_activity;
pub mod provider_usage;
pub mod proxy;
pub mod proxy_detect;
pub mod skills;
pub mod stt;
pub mod system_proxy;
#[cfg(desktop)]
pub mod tray;
pub mod tunnel;
pub mod webdav;
pub mod webdav_auto_sync;
pub mod workspace_watch;
