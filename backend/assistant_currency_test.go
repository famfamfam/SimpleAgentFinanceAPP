package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMockAssistantCrossCurrencyDraftRequiresReview(t *testing.T) {
	a := integrationApp(t)
	a.openrouter = "mock"
	usd := Account{ID: "00000000-0000-4000-8000-000000000101", Name: "USD", Opening: "0.00", Currency: "USD"}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry := Entry{Kind: "transfer", Amount: "9000", Currency: "RUB", AccountID: initialState().Accounts[0].ID, ToAccountID: usd.ID, ToAmount: "100", ToCurrency: "USD", Date: "2026-01-01"}
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"tool_calls": []any{map[string]any{"function": map[string]string{"name": "prepare_transactions", "arguments": string(jsonBytes(map[string]any{"entries": []Entry{entry}}))}}}}}}, "usage": map[string]any{"cost": 0}})
	}))
	defer provider.Close()
	t.Setenv("OPENROUTER_URL", provider.URL)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, user, _ := registerClient(t, server.URL, "Currency mock")
	book := "00000000-0000-4000-8000-000000000201"
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Currency"}, 200)
	_, err := a.applyVersion(context.Background(), user, book, []Command{{ID: "00000000-0000-4000-8000-000000000202", Entity: "account", Data: jsonBytes(usd)}}, true, 4)
	if err != nil {
		t.Fatal(err)
	}
	input := AssistantInput{ID: "00000000-0000-4000-8000-000000000203", TaskID: "00000000-0000-4000-8000-000000000204", Mode: "auto", Text: "transfer", Date: "2026-01-01"}
	request, _ := http.NewRequest("POST", server.URL+"/api/books/"+book+"/assistant", bytes.NewReader(jsonBytes(input)))
	request.Header.Set("X-Finance-Data-Version", "4")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var output AssistantOutput
	if err := json.NewDecoder(response.Body).Decode(&output); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || output.Action != "review" || len(output.Entries) != 1 || output.Entries[0].ToAmount != "100" {
		t.Fatalf("unsafe draft response: status %d %#v", response.StatusCode, output)
	}
}

func TestLegacyAssistantCannotReturnForeignDrafts(t *testing.T) {
	out := AssistantOutput{Entries: []Entry{{Currency: "USD"}}}
	if requireAssistantDataVersion(out, 0) == nil {
		t.Fatal("foreign draft exposed to legacy client")
	}
	if err := requireAssistantDataVersion(out, 4); err != nil {
		t.Fatal(err)
	}
	out = AssistantOutput{ReceiptCurrency: "EUR"}
	if requireAssistantDataVersion(out, 0) == nil {
		t.Fatal("foreign receipt total exposed to legacy client")
	}
	if err := requireAssistantDataVersion(AssistantOutput{Entries: []Entry{{}}}, 0); err != nil {
		t.Fatal(err)
	}
}

func TestAssistantCurrencyReviewProtectsNonRUBBooks(t *testing.T) {
	if assistantNeedsCurrencyReview(State{Accounts: []Account{{Currency: ""}, {Currency: "RUB"}}}) {
		t.Fatal("legacy RUB auto mode was disabled")
	}
	if !assistantNeedsCurrencyReview(State{Accounts: []Account{{Currency: "USD", Deleted: true}}}) {
		t.Fatal("non-RUB book bypassed review")
	}
}

func TestReceiptCurrencyRejectsMixedAndMismatchedEntries(t *testing.T) {
	cases := []struct {
		currency string
		entries  []Entry
		want     bool
	}{
		{"", []Entry{{Currency: ""}}, true},
		{"USD", []Entry{{Currency: "USD"}, {Currency: "USD"}}, true},
		{"USD", []Entry{{Currency: "USD"}, {Currency: "RUB"}}, false},
		{"", []Entry{{Currency: "USD"}}, false},
		{"XYZ", []Entry{{Currency: "XYZ"}}, false},
	}
	for _, tc := range cases {
		if got := receiptCurrencyMatches(tc.currency, tc.entries); got != tc.want {
			t.Fatalf("currency %q entries %#v: got %v", tc.currency, tc.entries, got)
		}
	}
}
