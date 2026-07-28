package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadyReturnsOKWhenDependenciesAreAvailable(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	Ready(func(context.Context) error { return nil }).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"ok":true`) {
		t.Fatalf("response = %d %q, want ready", recorder.Code, recorder.Body.String())
	}
}

func TestReadyReturnsServiceUnavailableWithoutLeakingDependencyError(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	Ready(func(context.Context) error { return errors.New("postgres password secret") }).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	if strings.Contains(recorder.Body.String(), "password secret") {
		t.Fatalf("response leaked dependency error: %q", recorder.Body.String())
	}
}
