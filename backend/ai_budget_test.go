package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestAIBudgetReservesAtomicallyAndSettlesKnownCosts(t *testing.T) {
	a := integrationApp(t)
	t.Setenv("AI_DAILY_BUDGET_USD", "0.50")
	ctx := context.Background()
	var group sync.WaitGroup
	keys := make(chan string, 3)
	for range 3 {
		group.Go(func() {
			key, err := a.reserveAICall(ctx)
			if err == nil {
				keys <- key
			}
		})
	}
	group.Wait()
	close(keys)
	if len(keys) != 2 {
		t.Fatal("parallel reservations exceeded budget", len(keys))
	}
	key := <-keys
	a.settleAICall(key, json.RawMessage(`{"cost":0.0001231}`))
	a.settleAICall(key, json.RawMessage(`{}`))
	spent, err := a.redis.Get(ctx, key).Int64()
	if err != nil || spent != aiCallReserveMicros+124 {
		t.Fatal("wrong conservative billing", spent, err)
	}
	if _, err := a.reserveAICall(ctx); err == nil {
		t.Fatal("budget overrun accepted")
	}
}

func TestCanceledAIRequestReleasesProviderTransactionAndSlot(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	entered, providerStopped := make(chan struct{}), make(chan struct{})
	abortProvider := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
			close(providerStopped)
		case <-abortProvider:
		}
	}))
	defer provider.Close()
	defer close(abortProvider)
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "Canceled AI")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Cancel AI"}, 200)
	input := AssistantInput{ID: newID(), Text: "Hello", Date: "2026-10-30", AccountID: initialState().Accounts[0].ID}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/books/"+book+"/assistant", bytes.NewReader(jsonBytes(input)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	done := make(chan struct{})
	go func() {
		defer close(done)
		if response, err := client.Do(request); err == nil {
			response.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider not reached")
	}
	cancel()
	<-done
	select {
	case <-providerStopped:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request continued after cancellation")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		slots, err := a.redis.ZCard(context.Background(), "finance:ai-active").Result()
		if err != nil {
			t.Fatal(err)
		}
		if slots == 0 && a.db.Stat().AcquiredConns() == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("canceled AI retained its slot or transaction", slots, a.db.Stat())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAISlotsAreBoundedAndReleased(t *testing.T) {
	a := integrationApp(t)
	ctx := context.Background()
	first, err := a.acquireAISlot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	second, err := a.acquireAISlot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second()
	if release, err := a.acquireAISlot(ctx); err == nil {
		release()
		t.Fatal("unbounded concurrent AI calls")
	}
	first()
	third, err := a.acquireAISlot(ctx)
	if err != nil {
		t.Fatal("slot not released", err)
	}
	third()
	if err := a.redis.Do(ctx, "ZADD", "finance:ai-active", time.Now().UnixMilli()-1, "crashed-request").Err(); err != nil {
		t.Fatal(err)
	}
	recovered, err := a.acquireAISlot(ctx)
	if err != nil {
		t.Fatal("expired lease from a crashed process was not reclaimed", err)
	}
	recovered()
}

func TestAIReplaySkipsQuotaAndConcurrentDuplicateNeverCallsProvider(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	entered, finish := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(finish) })
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-finish
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "Готово"}}}, "usage": map[string]any{"cost": 0.0001}})
	}))
	defer provider.Close()
	defer unblock()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "AI replay test")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "AI"}, 200)
	in := AssistantInput{ID: newID(), Text: "Привет", Date: "2026-10-30", AccountID: initialState().Accounts[0].ID}
	endpoint := fmt.Sprintf("%s/api/books/%s/assistant", server.URL, book)
	done := make(chan struct{})
	go func() { defer close(done); call(t, client, "POST", endpoint, in, 200) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider not reached")
	}
	call(t, client, "POST", endpoint, in, 429)
	unblock()
	<-done
	call(t, client, "POST", endpoint, in, 200)
	count, err := a.redis.Get(context.Background(), "finance:ai-user:"+user).Int()
	if err != nil || count != 1 {
		t.Fatal("replay consumed request quota", count, err)
	}
}
