package handler

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

func DeviceScheduleSummary(sm *session.Manager, timeout time.Duration) func(context.Context, string) ([]account.DeviceScheduleSummary, error) {
	active := make(chan struct{}, 8)
	return func(ctx context.Context, agentID string) ([]account.DeviceScheduleSummary, error) {
		if !sm.IsOnline(agentID) {
			return nil, errors.New("agent offline")
		}
		ctx, cancel := context.WithTimeout(ctx, min(timeout, 8*time.Second))
		defer cancel()
		select {
		case active <- struct{}{}:
			defer func() { <-active }()
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		read := func(action, args string, output any) error {
			id := newRequestID()
			request := &gatewayv2.GatewayEnvelope{
				RequestId: id, Timestamp: time.Now().Unix(),
				Payload: &gatewayv2.GatewayEnvelope_CronManage{CronManage: &gatewayv2.CronManageRequest{Action: action, TaskJson: args}},
			}
			ch, done, cleanup, err := sm.RegisterStreamAndSendContext(ctx, agentID, id, request)
			if err != nil {
				return err
			}
			defer cleanup()
			response, err := waitForEnvelope(ctx, ch, done)
			if err != nil {
				return err
			}
			result := response.GetCronManageResp()
			if result == nil || len(result.GetResultJson()) > 4<<20 {
				return errors.New("invalid cron response")
			}
			return json.Unmarshal([]byte(result.GetResultJson()), output)
		}
		var snapshot struct {
			Cron struct {
				Tasks []struct {
					ID                  string `json:"id"`
					Name                string `json:"name"`
					Enabled             bool   `json:"enabled"`
					RemainingExecutions *int   `json:"remainingExecutions"`
				} `json:"tasks"`
			} `json:"cron"`
		}
		if err := read("snapshot", "", &snapshot); err != nil {
			return nil, err
		}
		var dates struct {
			Now         int64 `json:"now"`
			Occurrences []struct {
				TaskID string `json:"taskId"`
				At     int64  `json:"at"`
			} `json:"occurrences"`
			Summaries []struct {
				TaskID  string `json:"taskId"`
				FirstAt int64  `json:"firstAt"`
				Planned int    `json:"planned"`
				Ran     int    `json:"ran"`
			} `json:"summaries"`
		}
		now := time.Now()
		args, _ := json.Marshal(map[string]int64{"from": now.UnixMilli(), "to": now.Add(35 * 24 * time.Hour).UnixMilli()})
		_ = read("occurrences", string(args), &dates)
		next := make(map[string]int64)
		cutoff := max(now.UnixMilli(), dates.Now)
		rememberNext := func(id string, at int64) {
			if at >= cutoff && (next[id] == 0 || at < next[id]) {
				next[id] = at
			}
		}
		for _, entry := range dates.Occurrences {
			rememberNext(entry.TaskID, entry.At)
		}
		for _, entry := range dates.Summaries {
			if entry.Planned > 0 && entry.Ran == 0 {
				rememberNext(entry.TaskID, entry.FirstAt)
			}
		}
		items := make([]account.DeviceScheduleSummary, 0, len(snapshot.Cron.Tasks))
		for _, task := range snapshot.Cron.Tasks {
			if task.ID == "" || task.Name == "" {
				continue
			}
			status := "paused"
			if task.RemainingExecutions != nil && *task.RemainingExecutions == 0 {
				status = "completed"
			} else if task.Enabled {
				status = "enabled"
			}
			items = append(items, account.DeviceScheduleSummary{ID: task.ID, Name: task.Name, Status: status, NextAt: next[task.ID]})
		}
		return items, nil
	}
}
