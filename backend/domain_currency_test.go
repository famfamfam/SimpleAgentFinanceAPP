package main

import (
	"encoding/json"
	"testing"
)

const currencyAccountID = "10000000-0000-4000-8000-000000000001"
const currencyEntryID = "20000000-0000-4000-8000-000000000001"
const currencyCommandID = "30000000-0000-4000-8000-000000000001"

func currencyCommand(entity string, base int64, data map[string]any) Command {
	raw, _ := json.Marshal(data)
	return Command{ID: currencyCommandID, Entity: entity, Base: base, Data: raw}
}

func currencyAccount(code string) map[string]any {
	return map[string]any{"id": currencyAccountID, "name": "Dollar", "opening": "-10.25", "currency": code}
}

func currencyEntry(s State) map[string]any {
	return map[string]any{"id": currencyEntryID, "kind": "transfer", "amount": "9000", "currency": "RUB", "accountId": s.Accounts[0].ID, "toAccountId": currencyAccountID, "toAmount": "100.00", "toCurrency": "USD", "date": "2026-01-01"}
}

func TestCurrencyAccountRulesAndConflict(t *testing.T) {
	for _, code := range []string{"RUB", "USD", "EUR", "CNY", "GBP", "CHF", "GEL", "TRY", "AED", "KZT", "BYN", "UAH", ""} {
		t.Run("accepted_"+code, func(t *testing.T) {
			s := initialState()
			if r, err := s.apply(currencyCommand("account", 0, currencyAccount(code)), "user", 2); err != nil || r.Status != "ok" {
				t.Fatalf("%+v %v", r, err)
			}
		})
	}
	for _, code := range []string{"usd", "XXX", " RUB "} {
		s := initialState()
		if _, err := s.apply(currencyCommand("account", 0, currencyAccount(code)), "user", 2); err == nil {
			t.Fatalf("accepted %q", code)
		}
	}
	s := initialState()
	a := currencyAccount("USD")
	if _, err := s.apply(currencyCommand("account", 0, a), "user", 2); err != nil {
		t.Fatal(err)
	}
	a["currency"] = "EUR"
	if r, err := s.apply(currencyCommand("account", 1, a), "user", 3); err != nil || r.Status != "conflict" {
		t.Fatalf("stale change: %+v %v", r, err)
	}
	if _, err := s.apply(currencyCommand("account", 2, a), "user", 3); err == nil {
		t.Fatal("changed currency")
	}
	a["currency"] = "USD"
	a["deleted"] = true
	if _, err := s.apply(currencyCommand("account", 2, a), "user", 3); err != nil {
		t.Fatal(err)
	}
	a["currency"] = "EUR"
	if _, err := s.apply(currencyCommand("account", 3, a), "user", 4); err == nil {
		t.Fatal("changed archived currency")
	}
}

func TestCurrencyTransferValidationAndLegacy(t *testing.T) {
	s := initialState()
	if _, err := s.apply(currencyCommand("account", 0, currencyAccount("USD")), "user", 2); err != nil {
		t.Fatal(err)
	}
	valid := currencyEntry(s)
	if _, err := s.apply(currencyCommand("entry", 0, valid), "user", 3); err != nil {
		t.Fatal(err)
	}
	if got := s.Entries[0]; got.Currency != "RUB" || got.ToCurrency != "USD" || got.ToAmount != "100.00" {
		t.Fatalf("transfer lost currency data: %+v", got)
	}
	for _, tc := range []struct {
		name, key string
		value     any
	}{
		{"missing destination amount", "toAmount", ""}, {"missing destination currency", "toCurrency", ""},
		{"wrong destination currency", "toCurrency", "EUR"}, {"wrong source currency", "currency", "USD"},
		{"unknown currency", "currency", "XXX"}, {"zero amount", "amount", "0"}, {"negative amount", "amount", "-1"},
		{"zero destination", "toAmount", "0"}, {"negative destination", "toAmount", "-1"}, {"fractional destination", "toAmount", "1.001"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := currencyEntry(s)
			e[tc.key] = tc.value
			if _, err := s.apply(currencyCommand("entry", 3, e), "user", 4); err == nil {
				t.Fatal("invalid transfer accepted")
			}
		})
	}
	e := currencyEntry(s)
	e["accountId"] = currencyAccountID
	e["currency"] = "USD"
	e["toAccountId"] = s.Accounts[0].ID
	e["toCurrency"] = "RUB"
	if _, err := s.apply(currencyCommand("entry", 3, e), "user", 4); err == nil {
		t.Fatal("changed historical source currency")
	}
	if r, err := s.apply(currencyCommand("entry", 1, e), "user", 4); err != nil || r.Status != "conflict" {
		t.Fatalf("stale entry: %+v %v", r, err)
	}

	legacy := initialState()
	account := currencyAccount("")
	delete(account, "currency")
	if _, err := legacy.apply(currencyCommand("account", 0, account), "user", 2); err != nil {
		t.Fatal(err)
	}
	old := currencyEntry(legacy)
	delete(old, "currency")
	delete(old, "toCurrency")
	delete(old, "toAmount")
	cmd := currencyCommand("entry", 0, old)
	raw := string(cmd.Data)
	if _, err := legacy.apply(cmd, "user", 3); err != nil {
		t.Fatal(err)
	}
	if string(cmd.Data) != raw {
		t.Fatal("mutated queued payload")
	}
	if got := legacy.Entries[0]; got.Currency != "RUB" || got.ToCurrency != "RUB" || got.ToAmount != "9000" {
		t.Fatalf("legacy transfer not normalized: %+v", got)
	}
	old["toCurrency"] = "RUB"
	old["toAmount"] = "9000.01"
	if _, err := legacy.apply(currencyCommand("entry", 3, old), "user", 4); err == nil {
		t.Fatal("unequal same-currency transfer")
	}
	old["toAmount"] = "9000.00"
	if _, err := legacy.apply(currencyCommand("entry", 3, old), "user", 4); err != nil {
		t.Fatal(err)
	}
	old["kind"] = "expense"
	old["categoryId"] = legacy.Categories[0].ID
	delete(old, "toAccountId")
	if _, err := legacy.apply(currencyCommand("entry", 4, old), "user", 5); err == nil {
		t.Fatal("expense accepted transfer fields")
	}
}

func TestCurrencyDeletionPreservesArchivedHistory(t *testing.T) {
	s := initialState()
	a := currencyAccount("USD")
	if _, err := s.apply(currencyCommand("account", 0, a), "user", 2); err != nil {
		t.Fatal(err)
	}
	e := currencyEntry(s)
	if _, err := s.apply(currencyCommand("entry", 0, e), "alice", 3); err != nil {
		t.Fatal(err)
	}
	a["deleted"] = true
	if _, err := s.apply(currencyCommand("account", 2, a), "user", 4); err != nil {
		t.Fatal(err)
	}
	if _, err := s.apply(currencyCommand("entry", 3, e), "user", 5); err == nil {
		t.Fatal("editing an entry against an archived account succeeded")
	}
	deleteCommand := currencyCommand("entry", 3, map[string]any{"id": currencyEntryID, "deleted": true})
	if _, err := s.apply(deleteCommand, "bob", 5); err != nil {
		t.Fatal(err)
	}
	got := s.Entries[0]
	if !got.Deleted || got.Currency != "RUB" || got.ToCurrency != "USD" || got.ToAmount != "100.00" || got.Author != "alice" || got.Editor != "bob" {
		t.Fatalf("deletion changed history: %+v", got)
	}
}

func TestCurrencyLegacyCannotImpersonateNonRUB(t *testing.T) {
	s := initialState()
	if _, err := s.apply(currencyCommand("account", 0, currencyAccount("USD")), "user", 2); err != nil {
		t.Fatal(err)
	}
	e := map[string]any{"id": currencyEntryID, "kind": "expense", "amount": "1", "accountId": currencyAccountID, "categoryId": s.Categories[0].ID, "date": "2026-01-01"}
	if _, err := s.apply(currencyCommand("entry", 0, e), "user", 3); err == nil {
		t.Fatal("missing currency interpreted as USD")
	}
	e["currency"] = "USD"
	if _, err := s.apply(currencyCommand("entry", 0, e), "user", 3); err != nil {
		t.Fatal(err)
	}
	delete(e, "currency")
	if _, err := s.apply(currencyCommand("entry", 3, e), "user", 4); err == nil {
		t.Fatal("legacy edit reinterpreted USD as RUB")
	}
}
