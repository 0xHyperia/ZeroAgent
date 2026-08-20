package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestSettingsSyncNeverBroadcastsPrivateSTTCredentials(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler func(context.Context, json.RawMessage) (any, error)
		wantSTT string
	}{
		{
			name: "handler unavailable",
			handler: func(context.Context, json.RawMessage) (any, error) {
				return nil, errors.New("store unavailable")
			},
			wantSTT: `{"enabled":false}`,
		},
		{
			name: "handler returns redacted state",
			handler: func(_ context.Context, raw json.RawMessage) (any, error) {
				if string(raw) != `{"apiKey":"private-stt-secret"}` {
					t.Fatalf("private payload = %s", raw)
				}
				return map[string]any{"enabled": true, "configured": true}, nil
			},
			wantSTT: `{"configured":true,"enabled":true}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager := NewManager()
			manager.SetSTTSettingsSyncHandler(tc.handler)
			events, unsubscribe := manager.SubscribeSettingsSync()
			defer unsubscribe()

			manager.broadcastSettingsSync("agent-a", &gatewayv2.SettingsSyncEvent{
				SettingsJson: `{"theme":"dark","stt":{"enabled":false},"sttSecretSync":{"apiKey":"private-stt-secret"}}`,
			})

			event := <-events
			var payload map[string]json.RawMessage
			if err := json.Unmarshal([]byte(event.Event.GetSettingsJson()), &payload); err != nil {
				t.Fatalf("decode public settings: %v", err)
			}
			if _, exists := payload[sttSecretSyncField]; exists {
				t.Fatal("private STT credentials reached a browser-visible event")
			}
			if got := string(payload["stt"]); got != tc.wantSTT {
				t.Fatalf("public stt = %s, want %s", got, tc.wantSTT)
			}
		})
	}
}
