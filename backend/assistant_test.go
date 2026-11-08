package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestParallelDraftToolCallsKeepEveryEntryWithDistinctStableIDs(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tools := []any{}
		for i, amount := range []string{"250.00", "850.00"} {
			tools = append(tools, map[string]any{"id": fmt.Sprint("call", i), "type": "function", "function": map[string]string{"name": "prepare_transactions", "arguments": fmt.Sprintf(`{"entries":[{"kind":"expense","amount":%q,"accountId":%q,"categoryId":%q,"date":"2026-10-30"}]}`, amount, initialState().Accounts[0].ID, initialState().Categories[0].ID)}})
		}
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"tool_calls": tools}}}, "usage": map[string]any{"cost": 0.0001}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "Parallel drafts")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "AI"}, 200)
	in := AssistantInput{ID: newID(), Text: "Кофе 250 и продукты 850", Date: "2026-10-30", AccountID: initialState().Accounts[0].ID}
	response := call(t, client, "POST", server.URL+"/api/books/"+book+"/assistant", in, 200)
	var entries []Entry
	json.Unmarshal(response["entries"], &entries)
	if len(entries) != 2 || entries[0].Amount != "250.00" || entries[1].Amount != "850.00" || entries[0].ID == entries[1].ID {
		t.Fatal("drafts lost or IDs collided", entries)
	}
	if entries[0].ID != derivedID(in.ID, 0) || entries[1].ID != derivedID(in.ID, 1) {
		t.Fatal("draft IDs are not stable")
	}
}

func TestAssistantUsageIncludesEveryProviderStep(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index := calls.Add(1)
		message := map[string]any{"content": "За период расходов нет"}
		if index == 1 {
			message = map[string]any{"tool_calls": []any{map[string]any{"id": "summary", "type": "function", "function": map[string]string{"name": "get_summary", "arguments": "{}"}}}}
		}
		respond(w, map[string]any{"choices": []any{map[string]any{"message": message}}, "usage": map[string]any{"cost": float64(index) * 0.0001, "total_tokens": 120, "prompt_tokens": 100, "completion_tokens": 20}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "AI usage")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "AI"}, 200)
	response := call(t, client, "POST", server.URL+"/api/books/"+book+"/assistant", AssistantInput{ID: newID(), Text: "Сколько расходов?", Date: "2026-10-30"}, 200)
	var usage struct {
		Total int     `json:"total_tokens"`
		Cost  float64 `json:"cost"`
	}
	json.Unmarshal(response["usage"], &usage)
	if calls.Load() != 2 || usage.Total != 240 || math.Abs(usage.Cost-0.0003) > 1e-9 {
		t.Fatal("provider usage omitted", usage)
	}
}

func TestAssistantAutoActionsAndStableTaskIDs(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	category := initialState().Categories[0].ID
	name, args := "prepare_transactions", ""
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"tool_calls": []any{map[string]any{"function": map[string]string{"name": name, "arguments": args}}}}}}, "usage": map[string]any{"cost": 0.0001}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "Auto")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Auto"}, 200)
	input := AssistantInput{ID: newID(), TaskID: newID(), Mode: "auto", Text: "Свинина 200", Date: "2026-11-02", Time: "17:45", AccountID: initialState().Accounts[0].ID}
	entry := Entry{Kind: "expense", Amount: "200.00", Date: input.Date, AccountID: input.AccountID, CategoryID: category}
	args = string(jsonBytes(map[string]any{"entries": []Entry{entry}, "transcript": "Свинина 200"}))
	url := server.URL + "/api/books/" + book + "/assistant"
	out := call(t, client, "POST", url, input, 200)
	var action string
	json.Unmarshal(out["action"], &action)
	if action != "add" {
		t.Fatal("not automatic", action)
	}
	var entries []Entry
	json.Unmarshal(out["entries"], &entries)
	if entries[0].ID != derivedID(input.TaskID, 0) || entries[0].Time != input.Time {
		t.Fatal("ID must use task, not attempt")
	}
	// A missing amount cannot enter the automatic save path.
	entry.Amount = ""
	args = string(jsonBytes(map[string]any{"entries": []Entry{entry}}))
	input.ID = newID()
	out = call(t, client, "POST", url, input, 200)
	json.Unmarshal(out["action"], &action)
	if action != "clarify" {
		t.Fatal("missing amount was accepted")
	}
	// Buttons are allowed only for real categories and a fully prepared entry.
	entry.Amount = "100.00"
	entry.CategoryID = ""
	name = "ask_clarification"
	second := initialState().Categories[1].ID
	args = string(jsonBytes(map[string]any{"entries": []Entry{entry}, "question": map[string]any{"text": "Какая категория?", "categoryIds": []string{category, second}}}))
	input.ID = newID()
	out = call(t, client, "POST", url, input, 200)
	json.Unmarshal(out["action"], &action)
	if action != "clarify" {
		t.Fatal("missing question")
	}
	var question AssistantQuestion
	json.Unmarshal(out["question"], &question)
	if len(question.Choices) != 2 {
		t.Fatal("missing category choices")
	}
	args = string(jsonBytes(map[string]any{"entries": []Entry{entry}, "question": map[string]any{"text": "Выберите", "categoryIds": []string{category, newID()}}}))
	input.ID = newID()
	call(t, client, "POST", url, input, 502)
	// Legacy callers keep the review contract even for valid drafts.
	entry.CategoryID = category
	name = "prepare_transactions"
	args = string(jsonBytes(map[string]any{"entries": []Entry{entry}}))
	input.ID = newID()
	input.Mode = ""
	input.TaskID = ""
	out = call(t, client, "POST", url, input, 200)
	if string(out["action"]) == `"add"` {
		t.Fatal("legacy caller changed behavior")
	}
	input.ID = newID()
	input.Mode = "auto"
	input.TaskID = newID()
	input.Image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
	out = call(t, client, "POST", url, input, 200)
	json.Unmarshal(out["action"], &action)
	if action != "review" {
		t.Fatal("receipt bypassed review", action)
	}
}

func TestAssistantUsesInputTimeWithoutChangingExplicitOrLegacyTime(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	var modelTime atomic.Value
	modelTime.Store("")
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		entry := Entry{Kind: "expense", Amount: "200.00", Date: "2026-11-02", Time: modelTime.Load().(string), AccountID: initialState().Accounts[0].ID, CategoryID: initialState().Categories[0].ID}
		tool := map[string]any{"function": map[string]string{"name": "prepare_transactions", "arguments": string(jsonBytes(map[string]any{"entries": []Entry{entry}}))}}
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"tool_calls": []any{tool}}}}, "usage": map[string]any{"cost": 0.0001}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, _, _ := registerClient(t, server.URL, "Time")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Time"}, 200)
	url := server.URL + "/api/books/" + book + "/assistant"
	for _, tc := range []struct{ input, explicit, want string }{{"09:07", "", "09:07"}, {"09:07", "00:00", "00:00"}, {"", "", ""}} {
		modelTime.Store(tc.explicit)
		input := AssistantInput{ID: newID(), TaskID: newID(), Mode: "auto", Text: "Продукты 200", Date: "2026-11-02", Time: tc.input, AccountID: initialState().Accounts[0].ID}
		out := call(t, client, "POST", url, input, 200)
		var entries []Entry
		if err := json.Unmarshal(out["entries"], &entries); err != nil || len(entries) != 1 || entries[0].Time != tc.want {
			t.Fatal("wrong transaction time", entries, err)
		}
		call(t, client, "POST", url, input, 200)
	}
	before := calls.Load()
	for _, invalid := range []string{"9:07", "24:00", "12:60", "12:00:00"} {
		call(t, client, "POST", url, AssistantInput{ID: newID(), Text: "Продукты 200", Date: "2026-11-02", Time: invalid}, 400)
	}
	if before != 3 || calls.Load() != before {
		t.Fatal("cache or invalid input called provider", calls.Load())
	}
}
