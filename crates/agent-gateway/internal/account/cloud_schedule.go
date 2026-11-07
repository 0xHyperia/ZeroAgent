package account

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	_ "time/tzdata"
)

const cloudScheduleGrace = 5 * time.Minute

var errCloudScheduleInvalid = errors.New("invalid scheduled task")

type CloudScheduleRule struct {
	Frequency       string         `json:"frequency"`
	TimeZone        string         `json:"time_zone"`
	Start           string         `json:"start"`
	IntervalMinutes int            `json:"interval_minutes,omitempty"`
	Weekdays        []time.Weekday `json:"weekdays,omitempty"`
	EndDate         string         `json:"end_date,omitempty"`
	Count           int            `json:"count,omitempty"`
}

type CloudScheduleInput struct {
	Name            string              `json:"name"`
	Rule            CloudScheduleRule   `json:"rule"`
	Run             CreateCloudRunInput `json:"run"`
	NewConversation bool                `json:"new_conversation"`
	ProjectID       string              `json:"project_id,omitempty"`
	ArchiveSuccess  bool                `json:"archive_successful_runs,omitempty"`
	Notification    string              `json:"notification,omitempty"`
	RequireApproval bool                `json:"require_approval,omitempty"`
}

type CloudSchedule struct {
	ID          string     `json:"id"`
	Revision    int64      `json:"revision"`
	Enabled     bool       `json:"enabled"`
	NextAt      *time.Time `json:"next_at"`
	Admitted    int        `json:"admitted"`
	Blocked     string     `json:"blocked,omitempty"`
	LatestState string     `json:"latest_state,omitempty"`
	CloudScheduleInput
}

type CloudScheduleRun struct {
	ID             string              `json:"id"`
	TriggerAt      time.Time           `json:"trigger_at"`
	Manual         bool                `json:"manual"`
	State          string              `json:"state"`
	ConversationID string              `json:"conversation_id,omitempty"`
	RunID          string              `json:"run_id,omitempty"`
	Output         string              `json:"output,omitempty"`
	ErrorCode      string              `json:"error_code,omitempty"`
	Archived       bool                `json:"archived,omitempty"`
	Approval       *CloudScheduleInput `json:"approval,omitempty"`
}

const cloudScheduleWall = "2006-01-02T15:04"

func (r CloudScheduleRule) validate() error {
	if r.TimeZone == "" || r.TimeZone == "Local" || len(r.TimeZone) > 100 || r.Count < 0 || (r.Count > 0 && r.EndDate != "") {
		return errCloudScheduleInvalid
	}
	if _, err := time.LoadLocation(r.TimeZone); err != nil {
		return errCloudScheduleInvalid
	}
	start, err := time.Parse(cloudScheduleWall, r.Start)
	if err != nil || start.Year() < 2000 || start.Year() > 9998 {
		return errCloudScheduleInvalid
	}
	if r.EndDate != "" {
		end, err := time.Parse(time.DateOnly, r.EndDate)
		if err != nil || end.Format(time.DateOnly) < start.Format(time.DateOnly) {
			return errCloudScheduleInvalid
		}
	}
	switch r.Frequency {
	case "once", "daily", "monthly":
		if len(r.Weekdays) > 0 || r.IntervalMinutes != 0 {
			return errCloudScheduleInvalid
		}
	case "weekly":
		if len(r.Weekdays) == 0 || len(r.Weekdays) > 7 || r.IntervalMinutes != 0 {
			return errCloudScheduleInvalid
		}
		for _, day := range r.Weekdays {
			if day < time.Sunday || day > time.Saturday {
				return errCloudScheduleInvalid
			}
		}
	case "interval":
		if r.IntervalMinutes < 1 || r.IntervalMinutes > 365*24*60 || len(r.Weekdays) > 0 {
			return errCloudScheduleInvalid
		}
	default:
		return errCloudScheduleInvalid
	}
	return nil
}

// wallInstant resolves the earlier instant on a fold and rejects nonexistent wall times.
func wallInstant(wall time.Time, loc *time.Location) time.Time {
	var earliest time.Time
	for _, probe := range []time.Time{wall.Add(-24 * time.Hour), wall, wall.Add(24 * time.Hour)} {
		_, offset := probe.In(loc).Zone()
		candidate := wall.Add(-time.Duration(offset) * time.Second)
		if candidate.In(loc).Format(cloudScheduleWall) == wall.Format(cloudScheduleWall) && (earliest.IsZero() || candidate.Before(earliest)) {
			earliest = candidate
		}
	}
	return earliest
}

func (r CloudScheduleRule) next(after time.Time, admitted int) *time.Time {
	if r.Count > 0 && admitted >= r.Count {
		return nil
	}
	loc, err := time.LoadLocation(r.TimeZone)
	if err != nil {
		return nil
	}
	start, err := time.Parse(cloudScheduleWall, r.Start)
	if err != nil {
		return nil
	}
	valid := func(at time.Time) *time.Time {
		if at.IsZero() || !at.After(after) || (r.EndDate != "" && at.In(loc).Format(time.DateOnly) > r.EndDate) {
			return nil
		}
		at = at.UTC()
		return &at
	}
	if r.Frequency == "once" {
		return valid(wallInstant(start, loc))
	}
	if r.Frequency == "interval" {
		base := wallInstant(start, loc)
		if base.IsZero() {
			return nil
		}
		step := time.Duration(r.IntervalMinutes) * time.Minute
		if !base.After(after) {
			base = base.Add((after.Sub(base)/step + 1) * step)
		}
		return valid(base)
	}
	local := after.In(loc)
	wall := time.Date(local.Year(), local.Month(), local.Day(), start.Hour(), start.Minute(), 0, 0, time.UTC)
	if wall.Before(start) {
		wall = start
	}
	for i := 0; i < 93; i, wall = i+1, wall.AddDate(0, 0, 1) {
		if r.EndDate != "" && wall.Format(time.DateOnly) > r.EndDate {
			break
		}
		if r.Frequency == "monthly" && wall.Day() != start.Day() {
			continue
		}
		if r.Frequency == "weekly" {
			matched := false
			for _, day := range r.Weekdays {
				matched = matched || wall.Weekday() == day
			}
			if !matched {
				continue
			}
		}
		if at := valid(wallInstant(wall, loc)); at != nil {
			return at
		}
	}
	return nil
}

func normalizeCloudSchedule(input CloudScheduleInput) (CloudScheduleInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Run.Model = strings.TrimSpace(input.Run.Model)
	if input.ProjectID != "" {
		project, err := cloudProjectID(input.ProjectID)
		if err != nil {
			return input, errCloudScheduleInvalid
		}
		input.ProjectID = project
	}
	if input.ArchiveSuccess && !input.NewConversation {
		return input, errCloudScheduleInvalid
	}
	switch input.Notification {
	case "", "attention":
		input.Notification = "attention"
	case "all", "none":
	default:
		return input, errCloudScheduleInvalid
	}
	if input.Name == "" || len(input.Name) > 240 || input.Run.Model == "" || len(input.Run.Model) > 200 || input.Run.ProviderKeyID < 0 || input.Run.Edit != nil || input.Run.ConversationID != "" || input.Run.ClientRequestID != "" || !validCloudReasoningEffort(input.Run.ReasoningEffort) {
		return input, errCloudScheduleInvalid
	}
	if err := input.Rule.validate(); err != nil {
		return input, err
	}
	var err error
	input.Run.ModelParameters, err = normalizeCloudModelParameters(input.Run.ModelParameters)
	if err != nil {
		return input, err
	}
	input.Run.PublicResearch, err = normalizeCloudPublicResearch(input.Run.PublicResearch)
	if err != nil {
		return input, err
	}
	content, err := validateCloudContent(input.Run.Content)
	if err != nil {
		return input, err
	}
	input.Run.Content, err = logicalCloudRunContent(content)
	return input, err
}

func encodeCloudSchedule(input CloudScheduleInput) ([]byte, error) {
	return json.Marshal(input)
}

func (input CloudScheduleInput) resultConversation(taskID, occurrenceID string) string {
	id := taskID
	if input.NewConversation {
		id = occurrenceID
	}
	suffix := "conversation"
	if input.ProjectID != "" {
		suffix += ":" + input.ProjectID
	}
	return cloudScheduleID(id, suffix)
}
