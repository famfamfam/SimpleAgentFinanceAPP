package main

import "testing"

func TestLegacyMCPRetryKeepsOriginalEntryPayload(t *testing.T) {
	e := Entry{ID: "id", Kind: "expense", Amount: "1", AccountID: "account", CategoryID: "category", Date: "2026-01-01"}
	want := `{"id":"id","kind":"expense","amount":"1","accountId":"account","categoryId":"category","date":"2026-01-01","note":"","tags":"","author":"","editor":"","version":0,"deleted":false}`
	if got := string(integrationEntryData(e, 0)); got != want {
		t.Fatalf("legacy payload changed: %s", got)
	}
	if got := string(integrationEntryData(e, 4)); got == want {
		t.Fatal("v4 payload omitted currency")
	}
}

func TestMCPDraftRejectsMissingCrossCurrencyAmount(t *testing.T) {
	s := initialState()
	usd := Account{ID: "00000000-0000-4000-8000-000000000101", Name: "Dollar", Opening: "0", Currency: "USD"}
	s.Accounts = append(s.Accounts, usd)
	e := Entry{ID: "00000000-0000-4000-8000-000000000102", Kind: "transfer", Amount: "9000", Currency: "RUB", AccountID: s.Accounts[0].ID, ToAccountID: usd.ID, ToCurrency: "USD", Date: "2026-01-01"}
	command := Command{ID: "00000000-0000-4000-8000-000000000103", Entity: "entry", Data: integrationEntryData(e, 4)}
	if _, err := s.apply(command, "user", 1); err == nil {
		t.Fatal("missing received amount accepted")
	}
	e.ToAmount = "100"
	command.Data = integrationEntryData(e, 4)
	if _, err := s.apply(command, "user", 1); err != nil {
		t.Fatal(err)
	}
}

func TestSummarySeparatesCurrenciesAndTransferAmounts(t *testing.T) {
	s := State{Accounts: []Account{{ID: "r", Opening: "10000", Currency: "RUB"}, {ID: "u", Opening: "0", Currency: "USD"}}, Entries: []Entry{
		{Kind: "transfer", AccountID: "r", ToAccountID: "u", Amount: "9000", Currency: "RUB", ToAmount: "100", ToCurrency: "USD"},
		{Kind: "expense", AccountID: "u", Amount: "10.25", Currency: "USD", CategoryID: "food"},
		{Kind: "expense", AccountID: "r", Amount: "20", Currency: "RUB", CategoryID: "food"},
	}}
	got := summary(s, Filter{})
	balances := got["accountBalances"].(map[string]string)
	if balances["r"] != "980.00" || balances["u"] != "89.75" {
		t.Fatalf("balances: %#v", balances)
	}
	totals := got["byCurrency"].(map[string]map[string]any)
	if totals["USD"]["expense"] != "10.25" || totals["RUB"]["expense"] != "20.00" {
		t.Fatalf("totals: %#v", totals)
	}
	if _, ok := got["expense"]; ok {
		t.Fatal("mixed currencies exposed as a single total")
	}
}
