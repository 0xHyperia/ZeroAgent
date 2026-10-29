package account

import (
	"context"
	"strconv"
	"time"
)

func validCloudAllocation(userID int64, operationID, purpose string, seconds, limit int64) bool {
	return userID > 0 && cloudToolIdentifier.MatchString(operationID) && (purpose == "conversation" || purpose == "file_parser") && validCloudWorkspaceReservation(seconds, limit)
}
func sameCloudAllocation(prior CloudAllocationReservation, userID int64, purpose string, seconds int64) bool {
	return prior.UserID == userID && prior.Purpose == purpose && prior.Seconds == seconds
}

// Caller holds MemoryStore.mu; workspace and parser use the same daily counter.
func reserveCloudAllocationLocked(state *cloudToolMemoryState, userID int64, operationID, purpose string, seconds, limit int64, now time.Time) (*CloudAllocationReservation, bool, error) {
	if !validCloudAllocation(userID, operationID, purpose, seconds, limit) {
		return nil, false, ErrCloudToolInvalid
	}
	if state.allocations == nil {
		state.allocations = map[string]CloudAllocationReservation{}
	}
	if prior, ok := state.allocations[operationID]; ok {
		if !sameCloudAllocation(prior, userID, purpose, seconds) {
			return nil, false, ErrCloudToolConflict
		}
		copy := prior
		return &copy, false, nil
	}
	day := now.UTC().Format("2006-01-02")
	key := strconv.FormatInt(userID, 10) + ":" + day
	if state.budgets[key]+seconds > limit {
		return nil, false, ErrCloudToolQuota
	}
	state.budgets[key] += seconds
	reservation := CloudAllocationReservation{OperationID: operationID, UserID: userID, Purpose: purpose, Day: day, Seconds: seconds, CreatedAt: now.UTC()}
	state.allocations[operationID] = reservation
	return &reservation, true, nil
}
func (s *MemoryStore) ReserveCloudAllocation(ctx context.Context, userID int64, operationID, purpose string, seconds, limit int64) (*CloudAllocationReservation, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return reserveCloudAllocationLocked(s.cloudToolStateLocked(), userID, operationID, purpose, seconds, limit, s.now())
}
