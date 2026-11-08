package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLegacyChatRejectsForeignProposal(t *testing.T) {
	m := ChatMessage{Result: &AssistantOutput{Entries: []Entry{{Currency: "USD"}}}}
	if err := requireChatDataVersion(m, 0); err == nil {
		t.Fatal("legacy client accepted foreign chat proposal")
	}
	if err := requireChatDataVersion(m, 4); err != nil {
		t.Fatal(err)
	}
	if err := requireChatDataVersion(ChatMessage{}, 0); err != nil {
		t.Fatal(err)
	}
	foreignTotal := ChatMessage{Result: &AssistantOutput{Total: "10.00", ReceiptCurrency: "USD"}}
	if err := requireChatDataVersion(foreignTotal, 0); err == nil {
		t.Fatal("legacy client accepted a foreign receipt total without foreign entries")
	}
}

func TestLegacyBatchCannotCreateFirstForeignAccountAndReplaySurvives(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Compatibility")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Book"}, 200)
	ctx := context.Background()
	legacy := Command{ID: newID(), Entity: "account", Data: json.RawMessage(`{"id":"00000000-0000-4000-8000-000000000099","name":"Cash","opening":"0.00"}`)}
	foreign := Command{ID: newID(), Entity: "account", Data: jsonBytes(Account{ID: newID(), Name: "USD", Opening: "0.00", Currency: "USD"})}
	if _, err := a.applyVersion(ctx, user, book, []Command{legacy, foreign}, false, 0); err == nil {
		t.Fatal("legacy batch created foreign account")
	}
	snapshot, err := a.snapshot(ctx, user, book)
	if err != nil || len(snapshot.State.Accounts) != 1 {
		t.Fatalf("rejected batch changed state: %+v %v", snapshot.State, err)
	}
	first, err := a.applyVersion(ctx, user, book, []Command{legacy}, false, 0)
	if err != nil || first.Results[0].Status != "ok" {
		t.Fatalf("legacy command: %+v %v", first, err)
	}
	replay, err := a.applyVersion(ctx, user, book, []Command{legacy}, false, 0)
	if err != nil || replay.Revision != first.Revision {
		t.Fatalf("raw replay changed: %+v %v", replay, err)
	}
	if _, err = a.applyVersion(ctx, user, book, []Command{foreign}, false, 4); err != nil {
		t.Fatal(err)
	}
	call(t, client, "GET", server.URL+"/api/books/"+book+"/sync", nil, 426)
	if _, err = a.applyVersion(ctx, user, book, []Command{legacy}, false, 0); err == nil {
		t.Fatal("legacy replay returned foreign snapshot")
	}
}

func TestLegacyChatCannotReadOrImportForeignProposals(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Chat compatibility")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Book"}, 200)
	ctx := context.Background()
	var now time.Time
	if err := a.db.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	m := ChatMessage{ID: newID(), TaskID: newID(), Role: "assistant", CreatedAt: now, Result: &AssistantOutput{Entries: []Entry{{Currency: "USD"}}}}
	address := server.URL + "/api/books/" + book + "/chat"
	call(t, client, "POST", address+"/import", map[string]any{"epoch": 0, "messages": []ChatMessage{m}}, 426)
	page := call(t, client, "GET", address, nil, 200)
	if string(page["messages"]) != "[]" {
		t.Fatalf("rejected import changed history: %s", page["messages"])
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, _, err = chatHead(ctx, tx, user, book); err != nil {
		t.Fatal(err)
	}
	if err = putChat(ctx, tx, user, book, m); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	call(t, client, "GET", address, nil, 426)
	outsider, _, _ := registerClient(t, server.URL, "Outsider")
	call(t, outsider, "GET", address, nil, 403)
}

func TestClientCapability(t *testing.T) {
	rub := State{Accounts: []Account{{Currency: ""}}, Entries: []Entry{{Currency: "RUB"}}}
	mixed := State{Accounts: []Account{{Currency: "USD", Deleted: true}}}
	if err := requireDataVersion(rub, 0); err != nil {
		t.Fatal(err)
	}
	if err := requireDataVersion(mixed, 0); err == nil {
		t.Fatal("legacy client received mixed state")
	}
	if err := requireDataVersion(mixed, 4); err != nil {
		t.Fatal(err)
	}
	if err := requireCommandDataVersion(Command{Entity: "account", Data: json.RawMessage(`{"currency":"USD"}`)}, 0); err == nil {
		t.Fatal("legacy client submitted foreign currency")
	}
	if err := requireCommandDataVersion(Command{Entity: "entry", Data: json.RawMessage(`{"currency":"RUB","toCurrency":"EUR"}`)}, 0); err == nil {
		t.Fatal("legacy client submitted foreign transfer")
	}
	if err := requireCommandDataVersion(Command{Entity: "account", Data: json.RawMessage(`{"currency":"USD"}`)}, 4); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	endpoint(func(http.ResponseWriter, *http.Request) error { return requireDataVersion(mixed, 0) })(w, httptest.NewRequest("GET", "/", nil))
	var response map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 426 || response["code"] != "client_update_required" {
		t.Fatalf("unexpected response %d %s", w.Code, w.Body.String())
	}
}
