use std::sync::Arc;

use tauri::Emitter;

use crate::commands::chat_history::{self};
use crate::commands::settings::reset_ssh_known_host_everywhere;
#[cfg(desktop)]
use crate::services::device_plugins::{
    remote_device_plugins_operation, DevicePluginAction, DevicePluginRequest,
};
use crate::services::gateway_bridge;
use crate::services::workspace_watch::WatchSource;

use super::*;

pub(super) fn provider_usage_agent_envelope(
    request_id: String,
    response: proto::ProviderUsageResponse,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ProviderUsageResp(response)),
    }
}

impl GatewayController {
    #[cfg(desktop)]
    async fn read_device_ui_surface(
        self: &Arc<Self>,
        request_id: &str,
        request: proto::DeviceUiSurfaceRequest,
    ) -> Result<String, String> {
        use crate::services::device_plugins::surface::{run_surface, SurfaceAction, SurfaceRequest};
        use crate::services::kbrain_backend::KBrainBackendState;
        use tauri::Manager;

        let action = match request.action.as_str() {
            "history" => SurfaceAction::History,
            "preview" => SurfaceAction::Preview,
            "panel" => SurfaceAction::Panel,
            "mcp" => SurfaceAction::Mcp,
            _ => return Err("DEVICE_UI_SURFACE_INVALID".into()),
        };
        let state = self.app_handle.try_state::<Arc<KBrainBackendState>>()
            .ok_or("DEVICE_UI_SURFACE_UNAVAILABLE")?;
        let state = Arc::clone(state.inner());
        state.require_current_device_owner(request.owner_id)?;
        let connection = state.running_connection().ok_or("DEVICE_UI_SURFACE_UNAVAILABLE")?;
        let session_id = if action == SurfaceAction::Panel {
            None
        } else {
            let value = self.run_composer_action(super::composer_action::GatewayComposerActionEvent {
                request_id: format!("{request_id}:ui-surface"),
                kind: "history".into(),
                conversation_id: request.conversation_id,
                action: "ui_surface_session".into(),
                cron: String::new(),
                interval: String::new(),
                prompt: String::new(),
                reasoning: String::new(),
                loop_id: String::new(),
                data: None,
            }).await.map_err(|_| "DEVICE_UI_SURFACE_UNAVAILABLE")?;
            value["sessionId"].as_str().map(str::to_owned)
        };
        let result = run_surface(
            state,
            connection,
            Some(request.owner_id),
            SurfaceRequest {
                action,
                workdir: Some(request.workdir),
                resource_id: (!request.resource_id.is_empty()).then_some(request.resource_id),
                plugin_id: (!request.plugin_id.is_empty()).then_some(request.plugin_id),
                plugin_version: (!request.plugin_version.is_empty()).then_some(request.plugin_version),
            },
            session_id,
        ).await?;
        serde_json::to_string(&result).map_err(|_| "DEVICE_UI_SURFACE_INVALID".to_owned())
    }

    pub(crate) async fn handle_gateway_envelope(
        self: &Arc<Self>,
        envelope: proto::GatewayEnvelope,
    ) -> Result<(), String> {
        let request_id = envelope.request_id.clone();
        if matches!(
            envelope.payload.as_ref(),
            Some(
                proto::gateway_envelope::Payload::HistoryList(_)
                    | proto::gateway_envelope::Payload::HistoryWorkdirs(_)
                    | proto::gateway_envelope::Payload::HistoryGet(_)
                    | proto::gateway_envelope::Payload::HistoryRename(_)
                    | proto::gateway_envelope::Payload::HistoryPin(_)
                    | proto::gateway_envelope::Payload::HistorySetCwd(_)
                    | proto::gateway_envelope::Payload::HistoryDelete(_)
                    | proto::gateway_envelope::Payload::HistoryBranch(_)
                    | proto::gateway_envelope::Payload::HistoryShareGet(_)
                    | proto::gateway_envelope::Payload::HistoryShareSet(_)
                    | proto::gateway_envelope::Payload::HistoryShareResolve(_)
                    | proto::gateway_envelope::Payload::TrajectoryFetch(_)
                    | proto::gateway_envelope::Payload::Checkpoint(_)
            )
        ) {
            // Every desktop conversation is a K-brain session, and only the
            // webview owns the local->backend id mapping, so these requests go
            // through the frontend's K-brain history bridge, not the legacy store.
            let controller = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                if let Some(payload) = envelope.payload {
                    if let Err(error) = controller
                        .handle_kbrain_history_request(request_id, &payload)
                        .await
                    {
                        eprintln!("gateway ZeroAgent engine history request failed: {error}");
                    }
                }
            });
            return Ok(());
        }

        match envelope.payload {
            Some(proto::gateway_envelope::Payload::Ping(ping)) => {
                let pong = proto::AgentEnvelope {
                    request_id: request_id.clone(),
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::Pong(proto::PongResponse {
                        timestamp: ping.timestamp,
                    })),
                };
                if is_chat_runtime_wake_request_id(&request_id) {
                    if let Err(error) = self.wake_chat_runtime("gateway_ping") {
                        eprintln!("emit gateway chat runtime wake ping failed: {error}");
                    }
                }
                // Never block the receive loop on outbound saturation, and
                // never let a pong failure tear down the connection. Pongs
                // ride the dedicated control lane so chat.prepare probes are
                // answered even while streamed tokens saturate the data
                // queue; the data queue is only a best-effort fallback while
                // the lanes are being swapped mid-reconnect.
                let pong = match self.current_outbound_control_sender() {
                    Ok(sender) => match sender.try_send(pong) {
                        Ok(()) => return Ok(()),
                        Err(envelope) => envelope,
                    },
                    Err(_) => pong,
                };
                if let Ok(sender) = self.current_outbound_sender() {
                    let _ = sender.try_send(pong);
                }
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelState(snapshot)) => {
                self.handle_tunnel_state_snapshot(snapshot);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelMutation(mutation)) => {
                self.handle_tunnel_mutation_request(request_id, mutation);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelFrame(frame)) => {
                if frame.stream_id.starts_with("image-") {
                    #[cfg(desktop)]
                    return self.device_images.handle(self, frame);
                    #[cfg(not(desktop))]
                    return self
                        .send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::TunnelFrame(
                                proto::TunnelFrame {
                                    stream_id: frame.stream_id,
                                    kind: proto::TunnelFrameKind::Error as i32,
                                    ..Default::default()
                                },
                            )),
                        })
                        .await;
                }
                if frame.stream_id.starts_with("private-") {
                    #[cfg(windows)]
                    return self.private_loopback.handle(self, frame);
                    #[cfg(not(windows))]
                    return self
                        .send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::TunnelFrame(
                                proto::TunnelFrame {
                                    stream_id: frame.stream_id,
                                    kind: proto::TunnelFrameKind::Error as i32,
                                    ..Default::default()
                                },
                            )),
                        })
                        .await;
                }
                self.tunnel_proxy.handle_frame(self, frame)
            }
            Some(proto::gateway_envelope::Payload::WorkspaceWatch(request)) => {
                self.workspace_watch
                    .set_desired(WatchSource::Gateway, request.workdirs);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ChatCommand(command)) => {
                self.handle_chat_command(request_id, command).await
            }
            Some(proto::gateway_envelope::Payload::ChatQueue(request)) => {
                self.handle_chat_queue_request(request_id, request).await
            }
            Some(proto::gateway_envelope::Payload::ClarifyTurn(request)) => {
                // handle_clarify_turn blocks on a 120s oneshot for slow
                // completions; spawn it so it never stalls the single-threaded
                // gateway dispatcher loop.
                let this = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = this.handle_clarify_turn(request_id, request).await {
                        eprintln!("handle clarify turn failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ChatIngressAck(ack)) => {
                self.handle_chat_ingress_ack(request_id, ack).await
            }
            Some(proto::gateway_envelope::Payload::Planning(request)) => {
                let result =
                    crate::services::planning::handle_request(&self.app_handle, request).await;
                match result {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::PlanningResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::CronManage(request)) => {
                match gateway_bridge::handle_cron_manage(self.app_handle.clone(), request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::CronManageResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryList(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_list(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryListResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.list handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryWorkdirs(_request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_workdirs().await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryWorkdirsResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.workdirs handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryGet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_get(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryGetResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.get handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TrajectoryFetch(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_trajectory_fetch(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::TrajectoryFetchResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway trajectory.fetch handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryPrefix(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_prefix(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryPrefixResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.prefix handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryRename(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_rename(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryRenameResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.rename handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryBranch(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_branch(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryBranchResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.branch handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryPin(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_pin(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryPinResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.pin handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistorySetCwd(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_set_cwd(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistorySetCwdResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.set_cwd handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareGet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_get(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareGetResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.get handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareSet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_set(request).await {
                        Ok(response) => {
                            if let Some(share) = response.share.as_ref() {
                                match chat_history::chat_history_get_summary_inner(
                                    share.conversation_id.clone(),
                                )
                                .await
                                {
                                    Ok(summary) => {
                                        controller
                                            .publish_history_sync(build_history_sync_upsert(
                                                &summary,
                                            ))
                                            .await;
                                    }
                                    Err(error) => {
                                        eprintln!(
                                            "publish history share sync event failed: {error}"
                                        )
                                    }
                                }
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareSetResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.set handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareResolve(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_resolve(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareResolveResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            let code = history_share_resolve_error_code(&error);
                            controller
                                .send_error_response(request_id.clone(), code, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.resolve handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryDelete(request)) => {
                let deleted_conversation_id = request.conversation_id.trim().to_string();
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_delete(request).await {
                        Ok(response) => {
                            controller
                                .publish_history_sync(build_history_sync_delete(
                                    deleted_conversation_id,
                                ))
                                .await;
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryDeleteResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.delete handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ProviderList(_request)) => {
                match gateway_bridge::handle_provider_list(self.app_handle.clone()).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ProviderListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::ProviderUsage(request)) => {
                let sender = self.current_outbound_sender()?;
                let provider_usage_service = Arc::clone(&self.provider_usage_service);
                tauri::async_runtime::spawn(async move {
                    let envelope = match gateway_bridge::handle_provider_usage(
                        provider_usage_service,
                        request,
                    )
                    .await
                    {
                        Ok(response) => provider_usage_agent_envelope(request_id, response),
                        Err(error) => build_error_response_envelope(request_id, 500, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("gateway provider usage handler failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ProviderModels(request)) => {
                // Model discovery can wait on an external service. Keep history,
                // chat and heartbeat dispatch independent of that wait, and keep
                // its response on the connection that accepted the request.
                let sender = self.current_outbound_sender()?;
                let app = self.app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let envelope = match gateway_bridge::handle_provider_models(app, request).await
                    {
                        Ok(response) => proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ProviderModelsResp(
                                response,
                            )),
                        },
                        Err(error) => build_error_response_envelope(request_id, 502, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("gateway provider models response failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::PromptTemplateList(_))
            | Some(proto::gateway_envelope::Payload::PromptTemplateExpand(_)) => {
                // 提示词模板已并入指令目录（slash_command_list）与 ChatRequest.prompt_command，
                // Gateway 也不再放行这两条通道；保留 proto 字段只为兼容。
                self.send_error_response(
                    request_id,
                    410,
                    "prompt template requests are retired; use slash_command_list and prompt_command"
                        .to_string(),
                )
                .await
            }
            // 以下三类都要等 K-brain 或 WebView 回应，一律 spawn，避免卡住单线程的分发循环。
            Some(proto::gateway_envelope::Payload::SlashCommandList(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_slash_command_list(
                        controller.app_handle.clone(),
                        request,
                    )
                    .await
                    {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::SlashCommandListResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => controller.send_error_response(request_id, 502, error).await,
                    };
                    if let Err(error) = result {
                        eprintln!("handle slash command list failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::GoalManage(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = controller.handle_goal_manage(request_id, request).await {
                        eprintln!("handle goal manage failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::LoopManage(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = controller.handle_loop_manage(request_id, request).await {
                        eprintln!("handle loop manage failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::SettingsGet(_request)) => {
                // Keep replies on the stream that received the request, across a slow commit.
                let response_sender = self.current_outbound_sender()?;
                match self.current_settings_snapshot().await {
                    Ok(snapshot) => {
                        let settings_json = match serialize_settings_sync_payload(&snapshot) {
                            Ok(settings_json) => settings_json,
                            Err(error) => {
                                return send_agent_envelope_to(
                                    response_sender.clone(),
                                    build_error_response_envelope(request_id, 500, error),
                                )
                                .await;
                            }
                        };
                        send_agent_envelope_to(
                            response_sender.clone(),
                            proto::AgentEnvelope {
                                request_id,
                                timestamp: now_unix_seconds(),
                                payload: Some(proto::agent_envelope::Payload::SettingsGetResp(
                                    proto::SettingsGetResponse { settings_json },
                                )),
                            },
                        )
                        .await
                    }
                    Err(error) => {
                        send_agent_envelope_to(
                            response_sender.clone(),
                            build_error_response_envelope(request_id, 500, error),
                        )
                        .await
                    }
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsUpdate(request)) => {
                // Keep replies on the stream that received the request, across a slow commit.
                let response_sender = self.current_outbound_sender()?;
                let input = match parse_settings_sync_payload(&request.settings_json) {
                    Ok(input) => input,
                    Err(error) => {
                        return send_agent_envelope_to(
                            response_sender.clone(),
                            build_error_response_envelope(request_id, 400, error),
                        )
                        .await
                    }
                };
                let mut saved = match crate::commands::settings::save_device_configuration(
                    self.app_handle.clone(),
                    input,
                )
                .await
                {
                    Ok(saved) => saved,
                    Err(error)
                        if error.contains("ZEROAGENT_CONFIGURATION_")
                            || error.contains("ZEROAGENT_NATIVE_CONFIGURATION_")
                            || error.contains("ZEROAGENT_UI_PREFERENCES_") =>
                    {
                        return send_agent_envelope_to(
                            response_sender.clone(),
                            proto::AgentEnvelope {
                                request_id,
                                timestamp: now_unix_seconds(),
                                payload: Some(proto::agent_envelope::Payload::SettingsUpdateResp(
                                    proto::SettingsUpdateResponse {
                                        accepted: false,
                                        message: "configuration_changed".into(),
                                    },
                                )),
                            },
                        )
                        .await;
                    }
                    Err(error) => {
                        return send_agent_envelope_to(
                            response_sender.clone(),
                            build_error_response_envelope(request_id, 400, error),
                        )
                        .await
                    }
                };
                // From this point on persistence succeeded. Notification/transport failures
                // must not report that the configuration was rejected or save it again.
                if self
                    .app_handle
                    .emit(
                        GATEWAY_SETTINGS_SYNC_EVENT,
                        serde_json::json!({"committed":true}),
                    )
                    .is_err()
                {
                    saved.warning = Some("配置已保存，桌面界面暂未刷新".into());
                }
                if let Some(snapshot) = saved.snapshot.clone() {
                    if self.publish_settings_sync(snapshot).await.is_err() {
                        saved.warning = Some("配置已保存，设备广播暂未完成，请重新读取设置".into());
                    }
                }
                let message =
                    serde_json::to_string(&saved).map_err(|_| "无法序列化设备保存回执")?;
                send_agent_envelope_to(
                    response_sender.clone(),
                    proto::AgentEnvelope {
                        request_id,
                        timestamp: now_unix_seconds(),
                        payload: Some(proto::agent_envelope::Payload::SettingsUpdateResp(
                            proto::SettingsUpdateResponse {
                                accepted: true,
                                message,
                            },
                        )),
                    },
                )
                .await
            }
            Some(proto::gateway_envelope::Payload::SettingsResetSshKnownHost(request)) => {
                let host = request.host.trim().to_string();
                let port = match u16::try_from(request.port) {
                    Ok(port) if port > 0 => port,
                    _ => {
                        return self
                            .send_error_response(
                                request_id,
                                400,
                                "SSH port must be between 1 and 65535".to_string(),
                            )
                            .await;
                    }
                };
                let reset = tauri::async_runtime::spawn_blocking(move || {
                    reset_ssh_known_host_everywhere(&host, port)
                })
                .await
                .unwrap_or_else(|e| Err(format!("reset SSH known host join failed: {e}")));
                match reset {
                    Ok(response) => {
                        let deleted = u32::try_from(response.deleted).unwrap_or(u32::MAX);
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::SettingsResetSshKnownHostResp(
                                    proto::SettingsResetSshKnownHostResponse { deleted },
                                ),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRoots(_request)) => {
                match gateway_bridge::handle_fs_roots().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRootsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::WorkspaceRootGrants(request)) => {
                match gateway_bridge::handle_workspace_root_grants(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::WorkspaceRootGrantsResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::Checkpoint(request)) => {
                match gateway_bridge::handle_checkpoint(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::CheckpointResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsListDirs(request)) => {
                match gateway_bridge::handle_fs_list_dirs(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListDirsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsCreateProjectFolder(request)) => {
                match gateway_bridge::handle_fs_create_project_folder(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::FsCreateProjectFolderResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsList(request)) => {
                match gateway_bridge::handle_fs_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsReadEditableText(request)) => {
                match gateway_bridge::handle_fs_read_editable_text(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsReadEditableTextResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsReadWorkspaceImage(request)) => {
                match gateway_bridge::handle_fs_read_workspace_image(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::FsReadWorkspaceImageResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::PermissionRules(_)) => {
                self.send_error_response(
                    request_id,
                    403,
                    "Remote permission-rule management is not available".into(),
                )
                .await
            }
            Some(proto::gateway_envelope::Payload::ChatFileOpen(request)) => {
                let sender = self.current_outbound_sender()?;
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let conversation_id = request.conversation_id.clone();
                    let lookup_id = format!("{request_id}:chat-file-workdir");
                    let result = if request.source == "attachment-preview" {
                        controller
                            .read_conversation_attachment(lookup_id, request)
                            .await
                    } else {
                        let current_workdir =
                            || controller.kbrain_conversation_workdir(lookup_id, conversation_id);
                        gateway_bridge::handle_chat_file_open(request, current_workdir).await
                    };
                    let envelope = match result {
                        Ok(response) => proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ChatFileOpenResp(
                                response,
                            )),
                        },
                        Err(error) => build_error_response_envelope(request_id, 500, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("send gateway chat file open response failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::FsWriteText(request)) => {
                match gateway_bridge::handle_fs_write_text(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsWriteTextResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsCreateDir(request)) => {
                match gateway_bridge::handle_fs_create_dir(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsCreateDirResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRename(request)) => {
                match gateway_bridge::handle_fs_rename(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRenameResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsDelete(request)) => {
                match gateway_bridge::handle_fs_delete(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsDeleteResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillFilesList(_request)) => {
                match gateway_bridge::handle_skill_files_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillFilesListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FileMentionList(request)) => {
                match gateway_bridge::handle_file_mention_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FileMentionListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::InstalledAppsList(_request)) => {
                let host_identifier = self.app_handle.config().identifier.clone();
                match gateway_bridge::handle_installed_apps_list(host_identifier).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::InstalledAppsListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::CuaDriver(request)) => {
                match gateway_bridge::handle_cua_driver(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::CuaDriverResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UsageStats(request)) => {
                // 设置 → 用量统计：只读；K-brain 聚合一年的用量可能要一会儿，放到阻塞线程。
                let this = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let app = this.app_handle.clone();
                    let outcome = tauri::async_runtime::spawn_blocking(move || {
                        super::kbrain_usage_stats::handle_usage_stats(&app, request)
                    })
                    .await
                    .unwrap_or_else(|error| Err(format!("usage stats task failed: {error}")));
                    let result = match outcome {
                        Ok(response) => {
                            this.send_agent_envelope(proto::AgentEnvelope {
                                request_id: request_id.clone(),
                                timestamp: now_unix_seconds(),
                                payload: Some(proto::agent_envelope::Payload::UsageStatsResp(
                                    response,
                                )),
                            })
                            .await
                        }
                        Err(error) => this.send_error_response(request_id, 400, error).await,
                    };
                    if let Err(error) = result {
                        eprintln!("handle usage stats failed: {error}");
                    }
                });
                Ok(())
            }
            #[cfg(desktop)]
            Some(proto::gateway_envelope::Payload::DevicePlugins(request)) => {
                let action = match request.action.as_str() {
                    "list" => DevicePluginAction::List,
                    "reload" => DevicePluginAction::Reload,
                    "enable" => DevicePluginAction::Enable,
                    "disable" => DevicePluginAction::Disable,
                    "remove" => DevicePluginAction::Remove,
                    "install" => DevicePluginAction::Install,
                    "trust" => DevicePluginAction::Trust,
                    "revokeTrust" => DevicePluginAction::RevokeTrust,
                    _ => {
                        return self
                            .send_error_response(
                                request_id,
                                400,
                                "invalid device plugin operation".into(),
                            )
                            .await
                    }
                };
                let sender = self.current_outbound_sender()?;
                let app = self.app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let result = remote_device_plugins_operation(
                        &app,
                        request.owner_id,
                        DevicePluginRequest {
                            action,
                            workdir: Some(request.workdir),
                            plugin_id: (!request.plugin_id.is_empty()).then_some(request.plugin_id),
                            source_path: (!request.source_path.is_empty())
                                .then_some(request.source_path),
                            since: None,
                        },
                    )
                    .await
                    .and_then(|snapshot| {
                        serde_json::to_string(&snapshot)
                            .map_err(|_| "DEVICE_PLUGIN_REQUEST_FAILED".to_owned())
                    });
                    let envelope = match result {
                        Ok(snapshot_json) => proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::DevicePluginsResp(
                                proto::DevicePluginsResponse { snapshot_json },
                            )),
                        },
                        Err(error) => build_error_response_envelope(request_id, 400, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("send device plugins response failed: {error}");
                    }
                });
                Ok(())
            }
            #[cfg(not(desktop))]
            Some(proto::gateway_envelope::Payload::DevicePlugins(_)) => {
                self.send_error_response(
                    request_id,
                    501,
                    "DEVICE_PLUGIN_BACKEND_UNAVAILABLE".into(),
                )
                .await
            }
            #[cfg(desktop)]
            Some(proto::gateway_envelope::Payload::DeviceUiSurface(request)) => {
                let sender = self.current_outbound_sender()?;
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let outcome = controller.read_device_ui_surface(&request_id, request).await;
                    let envelope = match outcome {
                        Ok(result_json) => proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::DeviceUiSurfaceResp(
                                proto::DeviceUiSurfaceResponse { result_json },
                            )),
                        },
                        Err(error) => build_error_response_envelope(request_id, 400, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("send device UI surface response failed: {error}");
                    }
                });
                Ok(())
            }
            #[cfg(not(desktop))]
            Some(proto::gateway_envelope::Payload::DeviceUiSurface(_)) => {
                self.send_error_response(
                    request_id,
                    501,
                    "DEVICE_UI_SURFACE_UNAVAILABLE".into(),
                )
                .await
            }
            Some(proto::gateway_envelope::Payload::ProxyDetect(request)) => {
                // 检测要等握手超时（约 1.5s），测速最长 10s；spawn 出去，别让 Ping、
                // 聊天探活（ChatPrepareTimeout 2s）在单线程调度循环里排队。
                let this = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_proxy_detect(request).await {
                        Ok(response) => {
                            this.send_agent_envelope(proto::AgentEnvelope {
                                request_id: request_id.clone(),
                                timestamp: now_unix_seconds(),
                                payload: Some(proto::agent_envelope::Payload::ProxyDetectResp(
                                    response,
                                )),
                            })
                            .await
                        }
                        Err(error) => this.send_error_response(request_id, 400, error).await,
                    };
                    if let Err(error) = result {
                        eprintln!("handle proxy detect failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::UploadReadableFiles(request)) => {
                match gateway_bridge::handle_upload_readable_files(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::UploadReadableFilesResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::WorkspaceHandoff(request)) => {
                match self.handle_workspace_handoff(request).await {
                    Ok(relative_path) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::WorkspaceHandoffResp(
                                proto::WorkspaceHandoffResponse {
                                    relative_path: relative_path.unwrap_or_default(),
                                },
                            )),
                        })
                        .await
                    }
                    Err(error) => {
                        let code = if error
                            == super::workspace_handoff::WORKSPACE_HANDOFF_TARGET_CHANGED
                        {
                            412
                        } else {
                            409
                        };
                        self.send_error_response(request_id, code, error).await
                    }
                }
            }
            Some(proto::gateway_envelope::Payload::ImportDirectory(request)) => {
                match gateway_bridge::handle_import_directory(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ImportDirectoryResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadedImagePreview(request)) => {
                self.spawn_uploaded_image_preview_response(request_id, request)
            }
            // 记忆命令要等 K-brain 回应（手动整理可达 2 分钟），spawn 出去，避免卡住分发循环。
            Some(proto::gateway_envelope::Payload::MemoryManage(request)) => {
                let response_sender = self.current_outbound_sender()?;
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let outcome =
                        match super::kbrain_history::history_memory_action(&request.command) {
                            Some(action) => {
                                controller
                                    .handle_history_memory_command(
                                        request_id.clone(),
                                        action,
                                        &request,
                                    )
                                    .await
                            }
                            None => {
                                gateway_bridge::handle_memory_manage(
                                    controller.app_handle.clone(),
                                    request,
                                )
                                .await
                            }
                        };
                    let result = match outcome {
                        Ok(response) => {
                            send_agent_envelope_to(
                                response_sender.clone(),
                                proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::MemoryManageResp(response),
                                    ),
                                },
                            )
                            .await
                        }
                        Err(error) => {
                            send_agent_envelope_to(
                                response_sender.clone(),
                                build_error_response_envelope(request_id, 500, error),
                            )
                            .await
                        }
                    };
                    if let Err(error) = result {
                        eprintln!("handle memory manage failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::SkillMetadataRead(request)) => {
                match gateway_bridge::handle_skill_metadata_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillMetadataReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillTextRead(request)) => {
                match gateway_bridge::handle_skill_text_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillTextReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillManage(request)) => {
                match gateway_bridge::handle_skill_manage(self.app_handle.clone(), request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::GitRequest(request)) => {
                match gateway_bridge::handle_git_request(
                    request,
                    Arc::clone(&self.git_clone_task_registry),
                )
                .await
                {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::GitResponse(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::TerminalRequest(request)) => {
                match self.handle_terminal_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::TerminalResponse(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }

            Some(proto::gateway_envelope::Payload::SftpRequest(request)) => {
                match self.handle_sftp_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SftpResponse(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::ManagedProcessRequest(request)) => {
                // A stop carries a bounded TERM grace; run it off the inbound
                // stream loop so tunnel frames and pings keep flowing.
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match controller.handle_managed_process_request(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::ManagedProcessResponse(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(error) = result {
                        eprintln!("send gateway managed process response failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryResync(_)) => {
                self.send_error_response(
                    request_id,
                    400,
                    "history resync is handled by the Gateway".to_string(),
                )
                .await
            }
            None => Ok(()),
        }
    }
}

impl GatewayController {
    pub(crate) async fn publish_planning_changed(&self, seq: u64) -> Result<(), String> {
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id: String::new(),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::PlanningChanged(
                proto::PlanningChanged { seq },
            )),
        })
        .await
    }
}
