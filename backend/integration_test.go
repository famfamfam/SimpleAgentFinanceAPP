package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testRegistrationPassword = "integration-registration-password"

func integrationApp(t *testing.T) *App {
	t.Helper()
	database := os.Getenv("TEST_DATABASE_URL")
	if database == "" {
		t.Skip("set TEST_DATABASE_URL and TEST_REDIS_URL for integration checks")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(database)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	namespace := "test_" + strings.ReplaceAll(newID(), "-", "")
	quoted := pgx.Identifier{namespace}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = namespace
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, migrationFiles); err != nil {
		t.Fatal(err)
	}
	cache, err := newRedisClient(env("TEST_REDIS_URL", "redis://localhost:16379/15"))
	if err != nil {
		t.Fatal(err)
	}
	if cache.Options().DB != 15 {
		cache.Close()
		t.Fatal("integration Redis must use isolated database 15")
	}
	if err = cache.Ping(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	cache.Del(ctx, "finance:register:127.0.0.1", "finance:join-ip:127.0.0.1", "finance:join-global", "finance:recover:127.0.0.1", "finance:local-xlsx:127.0.0.1")
	cache.Del(ctx, "finance:ai-active", "finance:ai-ip:127.0.0.1", "finance:ai-global", "finance:ai-budget:"+time.Now().UTC().Format("2006-01-02"))
	t.Cleanup(func() { pool.Close(); admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); admin.Close(); cache.Close() })
	return &App{db: pool, redis: cache, secret: strings.Repeat("x", 32), registrationPassword: testRegistrationPassword, model: "test", client: &http.Client{Timeout: 5 * time.Second}}
}
func testClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}
func call(t *testing.T, client *http.Client, method, address string, input any, status int) map[string]json.RawMessage {
	t.Helper()
	var body io.Reader
	if input != nil {
		body = bytes.NewReader(jsonBytes(input))
	}
	request, _ := http.NewRequest(method, address, body)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		t.Fatalf("%s %s: %d, want %d: %s", method, address, response.StatusCode, status, raw)
	}
	var result map[string]json.RawMessage
	if err = json.Unmarshal(raw, &result); err != nil {
		t.Fatal(string(raw), err)
	}
	return result
}
func stringField(result map[string]json.RawMessage, key string) string {
	var s string
	json.Unmarshal(result[key], &s)
	return s
}
func registerClient(t *testing.T, address, name string) (*http.Client, string, string) {
	t.Helper()
	client := testClient()
	result := call(t, client, "POST", address+"/api/register", map[string]string{"nickname": name, "password": testRegistrationPassword}, 200)
	var user identity
	json.Unmarshal(result["user"], &user)
	return client, user.ID, stringField(result, "recoveryKey")
}
func TestIntegrationSharedBookAndReplay(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	owner, ownerID, key := registerClient(t, server.URL, "Владелец")
	member, memberID, _ := registerClient(t, server.URL, "Участник")
	outsider, _, _ := registerClient(t, server.URL, "Другой")
	book := newID()
	address := server.URL + "/api/books/" + book
	call(t, owner, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Семья"}, 200)
	invite := call(t, owner, "POST", address+"/invite", map[string]any{}, 200)
	code := stringField(invite, "code")
	call(t, member, "POST", server.URL+"/api/join", map[string]string{"code": code}, 200)
	call(t, member, "POST", server.URL+"/api/join", map[string]string{"code": code}, 200)
	call(t, outsider, "GET", address+"/sync", nil, 403)
	e := sampleEntry(initialState())
	command := Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)}
	payload := map[string]any{"commands": []Command{command}}
	first := call(t, owner, "POST", address+"/sync", payload, 200)
	second := call(t, owner, "POST", address+"/sync", payload, 200)
	if string(first["revision"]) != string(second["revision"]) {
		t.Fatal("replay changed revision")
	}
	var state State
	json.Unmarshal(second["state"], &state)
	if len(state.Entries) != 1 {
		t.Fatal("duplicate after replay", state)
	}
	e = state.Entries[0]
	if e.Author != ownerID {
		t.Fatal("author spoofed")
	}
	e.Note = "Новая версия"
	call(t, owner, "POST", address+"/sync", map[string]any{"commands": []Command{{ID: newID(), Entity: "entry", Base: e.Version, Data: jsonBytes(e)}}}, 200)
	stale := call(t, member, "POST", address+"/sync", map[string]any{"commands": []Command{{ID: newID(), Entity: "entry", Base: e.Version, Data: jsonBytes(e)}}}, 200)
	var results []CommandResult
	json.Unmarshal(stale["results"], &results)
	if len(results) != 1 || results[0].Status != "conflict" {
		t.Fatal("stale edit accepted", results)
	}
	tampered := command
	tampered.Data = jsonBytes(e)
	call(t, owner, "POST", address+"/sync", map[string]any{"commands": []Command{tampered}}, 400)
	call(t, owner, "DELETE", address+"/members/"+memberID, nil, 200)
	call(t, member, "GET", address+"/sync", nil, 403)
	call(t, member, "POST", server.URL+"/api/join", map[string]string{"code": code}, 400)
	rotated := call(t, owner, "POST", server.URL+"/api/recovery-key", map[string]any{}, 200)
	fresh := testClient()
	call(t, fresh, "POST", server.URL+"/api/recover", map[string]string{"key": key}, 401)
	call(t, fresh, "POST", server.URL+"/api/recover", map[string]string{"key": "finance-key:v1:" + stringField(rotated, "recoveryKey")}, 200)
	who := call(t, fresh, "GET", server.URL+"/api/me", nil, 200)
	var recovered identity
	json.Unmarshal(who["user"], &recovered)
	if recovered.ID != ownerID {
		t.Fatal("recovery created another identity")
	}
}
func TestIntegrationConcurrentReplayAndAtomicImport(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Конкурентность")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Тест"}, 200)
	e := sampleEntry(initialState())
	command := Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)}
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := a.applyCommands(context.Background(), user, book, []Command{command})
			errors <- err
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := a.snapshot(context.Background(), user, book)
	if err != nil || len(snapshot.State.Entries) != 1 {
		t.Fatal("concurrent replay", snapshot, err)
	}
	good := sampleEntry(initialState())
	invalid := sampleEntry(initialState())
	invalid.Amount = "0.001"
	_, err = a.apply(context.Background(), user, book, []Command{{ID: newID(), Entity: "entry", Data: jsonBytes(good)}, {ID: newID(), Entity: "entry", Data: jsonBytes(invalid)}}, true)
	if err == nil {
		t.Fatal("invalid atomic package accepted")
	}
	after, err := a.snapshot(context.Background(), user, book)
	if err != nil || len(after.State.Entries) != 1 || after.Revision != snapshot.Revision {
		t.Fatal("partial atomic commit", after, err)
	}
}
func TestIntegrationMCPAndAssistant(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Tools")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Tools"}, 200)
	token := call(t, client, "POST", server.URL+"/api/books/"+book+"/integrations", map[string]any{"name": "Hermes", "write": false}, 200)
	invoke := func(method string, params any, status int) map[string]json.RawMessage {
		request, _ := http.NewRequest("POST", server.URL+"/mcp", bytes.NewReader(jsonBytes(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})))
		request.Header.Set("Authorization", "Bearer "+stringField(token, "token"))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("MCP-Protocol-Version", "2025-06-18")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		if response.StatusCode != status {
			t.Fatalf("MCP %s: %d %s", method, response.StatusCode, raw)
		}
		result := map[string]json.RawMessage{}
		json.Unmarshal(raw, &result)
		return result
	}
	initialized := invoke("initialize", map[string]any{"protocolVersion": "2025-06-18", "clientInfo": map[string]string{"name": "test", "version": "1"}, "capabilities": map[string]any{}}, 200)
	if initialized["error"] != nil {
		t.Fatal(string(initialized["error"]))
	}
	catalog := invoke("tools/call", map[string]any{"name": "list_catalogs", "arguments": map[string]any{}}, 200)
	if !strings.Contains(string(catalog["result"]), "Основной") {
		t.Fatal("MCP catalogs missing", string(catalog["result"]))
	}
	writeInput := map[string]any{"requestId": newID(), "entries": []EntryDraft{{Kind: "expense", Amount: "12.34", AccountID: initialState().Accounts[0].ID, CategoryID: initialState().Categories[0].ID, Date: "2026-10-29"}}}
	denied := invoke("tools/call", map[string]any{"name": "create_transactions", "arguments": writeInput}, 200)
	if !strings.Contains(string(denied["result"]), `"isError":true`) {
		t.Fatal("read-only token wrote", string(denied["result"]))
	}
	call(t, client, "DELETE", server.URL+"/api/books/"+book+"/integrations/"+stringField(token, "id"), nil, 200)
	invoke("tools/list", map[string]any{}, 401)
	token = call(t, client, "POST", server.URL+"/api/books/"+book+"/integrations", map[string]any{"name": "Writer", "write": true}, 200)
	for range 2 {
		written := invoke("tools/call", map[string]any{"name": "create_transactions", "arguments": writeInput}, 200)
		if strings.Contains(string(written["result"]), `"isError":true`) {
			t.Fatal("MCP write failed", string(written["result"]))
		}
	}
	beforeAI, err := a.snapshot(context.Background(), user, book)
	if err != nil || len(beforeAI.State.Entries) != 1 {
		t.Fatal("MCP replay duplicated entry", err)
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		respond(w, map[string]any{"choices": []any{map[string]any{"finish_reason": "tool_calls", "message": map[string]any{"content": "", "tool_calls": []any{map[string]any{"id": "call1", "type": "function", "function": map[string]string{"name": "prepare_transactions", "arguments": fmt.Sprintf(`{"entries":[{"kind":"expense","amount":"12.34","accountId":%q,"categoryId":%q,"date":"2026-10-29","note":"Кофе"}]}`, initialState().Accounts[0].ID, initialState().Categories[0].ID)}}}}}}, "usage": map[string]int{"total_tokens": 100}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	a.openrouter = "test-key"
	input := AssistantInput{ID: newID(), Text: "Кофе 12.34", Date: "2026-10-29", AccountID: initialState().Accounts[0].ID}
	endpoint := server.URL + "/api/books/" + book + "/assistant"
	first := call(t, client, "POST", endpoint, input, 200)
	second := call(t, client, "POST", endpoint, input, 200)
	var firstEntries, secondEntries []Entry
	json.Unmarshal(first["entries"], &firstEntries)
	json.Unmarshal(second["entries"], &secondEntries)
	if calls.Load() != 1 || !slices.Equal(firstEntries, secondEntries) {
		t.Fatal("assistant replay was not cached", calls.Load())
	}
	state, err := a.snapshot(context.Background(), user, book)
	if err != nil || len(state.State.Entries) != 1 {
		t.Fatal("draft unexpectedly wrote money")
	}
	input.ID = newID()
	input.Previous = []AssistantTurn{{Role: "system", Content: "untrusted"}}
	call(t, client, "POST", endpoint, input, 400)
	if calls.Load() != 1 {
		t.Fatal("invalid context reached provider")
	}
}

func TestIntegrationRetentionPreservesFinancialReplay(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Retention")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Retention"}, 200)
	ctx := context.Background()
	command := Command{ID: newID(), Entity: "entry", Data: jsonBytes(sampleEntry(initialState()))}
	before, err := a.applyCommands(ctx, user, book, []Command{command})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(ctx, `INSERT INTO assistant_requests(book_id,id,user_id,request_hash,result,created_at) VALUES($1,$2,$3,'test','{}',now()-interval '31 days')`, book, newID(), user); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(ctx, `INSERT INTO imports(id,book_id,user_id,file_hash,proposal,applied,created_at) VALUES($1,$2,$3,'confirmed','{}',true,now()-interval '31 days'),($4,$2,$3,'pending','{}',false,now()-interval '31 days')`, newID(), book, user, newID()); err != nil {
		t.Fatal(err)
	}
	if err = a.cleanupExpired(ctx); err != nil {
		t.Fatal(err)
	}
	var drafts, imports int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM assistant_requests`).Scan(&drafts); err != nil {
		t.Fatal(err)
	}
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM imports`).Scan(&imports); err != nil {
		t.Fatal(err)
	}
	if drafts != 0 || imports != 1 {
		t.Fatal("retention", drafts, imports)
	}
	after, err := a.applyCommands(ctx, user, book, []Command{command})
	if err != nil || after.Revision != before.Revision || len(after.State.Entries) != 1 {
		t.Fatal("cleanup broke financial replay", err)
	}
}

func TestIntegrationConcurrentImportIsConfirmedOnce(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Import")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Import"}, 200)
	ctx := context.Background()
	existing := sampleEntry(initialState())
	snapshot, err := a.applyCommands(ctx, user, book, []Command{{ID: newID(), Entity: "entry", Data: jsonBytes(existing)}})
	if err != nil {
		t.Fatal(err)
	}
	source := initialState()
	copyEntry := existing
	copyEntry.ID = newID()
	source.Entries = []Entry{existing, copyEntry}
	file, err := writeXLSX(source)
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := parseXLSX(file, snapshot.State)
	if err != nil || len(proposal.Duplicates) != 1 {
		t.Fatal("preview", err)
	}
	proposal.Revision = &snapshot.Revision
	if _, err = a.db.Exec(ctx, `INSERT INTO imports(id,book_id,user_id,file_hash,proposal) VALUES($1,$2,$3,'fixture',$4)`, proposal.ID, book, user, jsonBytes(proposal)); err != nil {
		t.Fatal(err)
	}
	type response struct {
		data map[string]json.RawMessage
		err  error
	}
	results := make([]response, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			include := []string{}
			if index == 1 {
				include = proposal.Duplicates
			}
			req, _ := http.NewRequest("POST", server.URL+"/api/books/"+book+"/import/"+proposal.ID, bytes.NewReader(jsonBytes(map[string]any{"includeDuplicates": include})))
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				results[index].err = err
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				results[index].err = fmt.Errorf("status %d", resp.StatusCode)
				return
			}
			results[index].err = json.NewDecoder(resp.Body).Decode(&results[index].data)
		}(i)
	}
	wg.Wait()
	committed, already := 0, 0
	for _, result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.data["imported"] != nil {
			committed++
		}
		if string(result.data["alreadyApplied"]) == "true" {
			already++
		}
	}
	if committed != 1 || already != 1 {
		t.Fatal("import applied more than once", committed, already)
	}
}
