package main

import (
	"bytes"
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCanceledMCPToolReleasesDatabaseConnection(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "MCP cancellation")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "MCP"}, 200)
	token := call(t, client, "POST", server.URL+"/api/books/"+book+"/integrations", map[string]any{"name": "Test", "write": false}, 200)
	lock, err := a.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	if _, err = lock.Exec(context.Background(), `LOCK TABLE books IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest("POST", "/mcp", bytes.NewReader(jsonBytes(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "list_catalogs", "arguments": map[string]any{}},
	}))).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+stringField(token, "token"))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-06-18")
	done := make(chan struct{})
	go func() { defer close(done); a.mcpHandler().ServeHTTP(httptest.NewRecorder(), r) }()
	defer func() {
		lock.Rollback(context.Background())
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("MCP handler did not exit after releasing test lock")
		}
	}()
	deadline := time.Now().Add(time.Second)
	for {
		var waiting bool
		err = a.db.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='books'::regclass AND NOT granted)`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("MCP tool did not reach the locked table")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("canceled MCP tool kept waiting for SQL lock")
	}
	deadline = time.Now().Add(time.Second)
	for a.db.Stat().AcquiredConns() > 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if acquired := a.db.Stat().AcquiredConns(); acquired != 1 {
		t.Fatal("MCP connection was not released; only test lock should remain", acquired)
	}
}

func TestCanceledMutationRollsBackAndCanBeRetried(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Cancellation test")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Cancel"}, 200)
	ctx := context.Background()
	baseline, err := a.snapshot(ctx, user, book)
	if err != nil {
		t.Fatal(err)
	}
	// Cancel while the mutation is already recorded but the final book update is pending.
	_, err = a.db.Exec(ctx, `CREATE FUNCTION pause_book_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$;
CREATE TRIGGER pause_book_update BEFORE UPDATE ON books FOR EACH ROW EXECUTE FUNCTION pause_book_update()`)
	if err != nil {
		t.Fatal(err)
	}
	command := Command{ID: newID(), Entity: "entry", Data: jsonBytes(sampleEntry(initialState()))}
	request, cancel := context.WithTimeout(ctx, 75*time.Millisecond)
	defer cancel()
	if _, err := a.applyCommands(request, user, book, []Command{command}); err == nil {
		t.Fatal("canceled write succeeded")
	}
	if _, err := a.db.Exec(ctx, `DROP TRIGGER pause_book_update ON books`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := a.snapshot(ctx, user, book)
	if err != nil || snapshot.Revision != baseline.Revision || len(snapshot.State.Entries) != 0 {
		t.Fatal("cancellation left partial financial data", snapshot, err)
	}
	var recorded int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM mutations WHERE book_id=$1`, book).Scan(&recorded); err != nil || recorded != 0 {
		t.Fatal("canceled mutation remained recorded", recorded, err)
	}
	for range 2 {
		if _, err := a.applyCommands(ctx, user, book, []Command{command}); err != nil {
			t.Fatal("retry failed", err)
		}
	}
	snapshot, err = a.snapshot(ctx, user, book)
	if err != nil || len(snapshot.State.Entries) != 1 || snapshot.Revision != baseline.Revision+1 {
		t.Fatal("retry lost or duplicated the transaction", snapshot, err)
	}
	deadline := time.Now().Add(time.Second)
	for a.db.Stat().AcquiredConns() != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if acquired := a.db.Stat().AcquiredConns(); acquired != 0 {
		t.Fatal("transaction connection not released", acquired)
	}
}

func TestCanceledMaintenanceReleasesDatabaseConnection(t *testing.T) {
	a := integrationApp(t)
	ctx := context.Background()
	lock, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(ctx)
	if _, err := lock.Exec(ctx, `LOCK TABLE assistant_requests IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	worker, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); a.cleanup(worker) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(2 * time.Second)
	for a.db.Stat().AcquiredConns() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if a.db.Stat().AcquiredConns() != 2 {
		t.Fatal("maintenance did not reach the blocked query")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("maintenance did not stop")
	}
	// pgx destroys canceled connections asynchronously after releasing the query.
	deadline = time.Now().Add(time.Second)
	for a.db.Stat().AcquiredConns() != 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if acquired := a.db.Stat().AcquiredConns(); acquired != 1 {
		t.Fatal("maintenance kept its connection", acquired)
	}
}
