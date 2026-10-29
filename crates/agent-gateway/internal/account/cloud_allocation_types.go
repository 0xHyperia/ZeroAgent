package account

import (
	"context"
	"time"
)

const CloudAllocationDefaultDailySeconds int64 = 3600

type CloudAllocationReservation struct {
	OperationID string    `json:"operation_id"`
	UserID      int64     `json:"-"`
	Purpose     string    `json:"purpose"`
	Day         string    `json:"allocation_day"`
	Seconds     int64     `json:"reserved_seconds"`
	CreatedAt   time.Time `json:"created_at"`
}
type CloudAllocationStore interface {
	ReserveCloudAllocation(context.Context, int64, string, string, int64, int64) (*CloudAllocationReservation, bool, error)
}
