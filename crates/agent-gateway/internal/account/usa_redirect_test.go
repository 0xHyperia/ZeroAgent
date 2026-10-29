package account

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestUSAClientNeverRedirectsAccountCredentialsOrPassword(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(500) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "platform-session", Value: "synthetic-platform-cookie"})
		http.Redirect(w, r, destination.URL+"/must-not-receive", http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	shared := source.Client()
	shared.Jar = jar
	configured, err := NewUSAClient(source.URL, source.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for name, client := range map[string]*USAClient{"configured": configured, "injected": NewUSAClientWithHTTPClient(source.URL, shared)} {
		t.Run(name, func(t *testing.T) {
			if _, err := client.Login(context.Background(), "synthetic@example.invalid", "synthetic-password"); err == nil {
				t.Fatal("redirected login succeeded")
			}
			if _, err := client.Me(context.Background(), "synthetic-access"); err == nil {
				t.Fatal("redirected account read succeeded")
			}
			if client.client.Jar != nil {
				t.Fatal("account client retained shared cookie jar")
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("platform redirect received a private request")
	}
	if shared.Jar != jar || shared.CheckRedirect != nil {
		t.Fatal("caller HTTP client was mutated")
	}
}
