package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStartupRequiresRegistrationPassword(t *testing.T) {
	t.Setenv("APP_SECRET", strings.Repeat("x", 32))
	t.Setenv("REGISTRATION_PASSWORD", "")
	if err := run(context.Background()); err == nil || !strings.Contains(err.Error(), "REGISTRATION_PASSWORD") {
		t.Fatal("missing registration password did not stop startup", err)
	}
}

func TestRegistrationRequiresPasswordBeforeCreatingAccount(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	for _, password := range []string{"", "wrong-password", strings.Repeat("x", 1025)} {
		client := testClient()
		call(t, client, "POST", server.URL+"/api/register", map[string]string{"nickname": "No access", "password": password}, 401)
		call(t, client, "GET", server.URL+"/api/me", nil, 401)
	}
	var count int
	if err := a.db.QueryRow(context.Background(), "SELECT count(*) FROM users").Scan(&count); err != nil || count != 0 {
		t.Fatal("rejected registration created an account", count, err)
	}
	client, _, key := registerClient(t, server.URL, "Allowed")
	call(t, client, "GET", server.URL+"/api/me", nil, 200)
	// The shared registration password is not needed again for a personal recovery key.
	recovered := testClient()
	call(t, recovered, "POST", server.URL+"/api/recover", map[string]string{"key": key}, 200)
	call(t, recovered, "GET", server.URL+"/api/me", nil, 200)

	a.registrationPassword = ""
	call(t, testClient(), "POST", server.URL+"/api/register", map[string]string{"nickname": "No config", "password": ""}, 503)
}

func TestRegistrationBruteForceLimitIsSharedAcrossServers(t *testing.T) {
	a := integrationApp(t)
	b := *a
	first := httptest.NewServer(a.routes())
	defer first.Close()
	second := httptest.NewServer(b.routes())
	defer second.Close()
	client := testClient()
	for i := range 10 {
		address := first.URL
		if i%2 == 1 {
			address = second.URL
		}
		call(t, client, "POST", address+"/api/register", map[string]string{"nickname": "Guess", "password": "wrong"}, 401)
	}
	call(t, client, "POST", second.URL+"/api/register", map[string]string{"nickname": "Blocked", "password": testRegistrationPassword}, 429)
	ttl, err := a.redis.TTL(context.Background(), "finance:register:127.0.0.1").Result()
	if err != nil || ttl <= 0 || ttl > time.Hour {
		t.Fatal("registration limit has no bounded expiry", ttl, err)
	}
}
