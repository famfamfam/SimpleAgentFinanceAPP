package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestMoney(t *testing.T) {
	for _, tt := range []struct {
		in   string
		want int64
	}{{"0", 0}, {"0.29", 29}, {"1234.5", 123450}, {"-50.01", -5001}, {"999999999.99", 99999999999}} {
		got, err := money(tt.in)
		if err != nil || got != tt.want {
			t.Fatalf("money(%q)=%d,%v", tt.in, got, err)
		}
		again, err := money(moneyString(got))
		if err != nil || again != got {
			t.Fatal("round trip", tt)
		}
	}
	for _, s := range []string{"NaN", "1e3", "1.001", "1000000000", "", "00.12", "1,20"} {
		if _, err := money(s); err == nil {
			t.Fatal("accepted invalid money", s)
		}
	}
}
func sampleEntry(s State) Entry {
	return Entry{ID: newID(), Kind: "expense", Amount: "123.45", AccountID: s.Accounts[0].ID, CategoryID: s.Categories[0].ID, Date: "2026-10-29", Note: "Проверка", Tags: ""}
}
func TestVersionsDeletionAndReferences(t *testing.T) {
	s := initialState()
	e := sampleEntry(s)
	command := Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)}
	result, err := s.apply(command, "alice", 2)
	if err != nil || result.Status != "ok" {
		t.Fatal(result, err)
	}
	e = s.Entries[0]
	if e.Author != "alice" || e.Version != 2 {
		t.Fatal(e)
	}
	e.Note = "Правка"
	result, err = s.apply(Command{ID: newID(), Entity: "entry", Base: 1, Data: jsonBytes(e)}, "bob", 3)
	if err != nil || result.Status != "conflict" || s.Entries[0].Note == "Правка" {
		t.Fatal("lost conflict", result, err)
	}
	e.Deleted = true
	result, err = s.apply(Command{ID: newID(), Entity: "entry", Base: 2, Data: jsonBytes(e)}, "bob", 3)
	if err != nil || !s.Entries[0].Deleted || s.Entries[0].Author != "alice" || s.Entries[0].Editor != "bob" {
		t.Fatal(result, err, s.Entries[0])
	}
	e.ID = newID()
	e.Deleted = false
	e.CategoryID = newID()
	if _, err = s.apply(Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)}, "bob", 4); err == nil {
		t.Fatal("accepted foreign category")
	}
}
func TestTransferAndSummary(t *testing.T) {
	s := initialState()
	s.Accounts = append(s.Accounts, Account{ID: newID(), Name: "Наличные", Opening: "1000.00", Version: 1})
	e := sampleEntry(s)
	e.Kind = "transfer"
	e.CategoryID = ""
	e.ToAccountID = s.Accounts[1].ID
	if err := s.validateEntry(e); err != nil {
		t.Fatal(err)
	}
	s.Entries = append(s.Entries, e)
	summary := summary(s, Filter{})
	if summary["expense"] != "0.00" || summary["income"] != "0.00" {
		t.Fatal(summary)
	}
	balances := summary["accountBalances"].(map[string]string)
	if balances[e.AccountID] != "-123.45" || balances[e.ToAccountID] != "1123.45" {
		t.Fatal(balances)
	}
	e.ToAccountID = e.AccountID
	if s.validateEntry(e) == nil {
		t.Fatal("self transfer accepted")
	}
}
func TestXLSXRoundTrip(t *testing.T) {
	s := initialState()
	expense := sampleEntry(s)
	expense.Amount = "0.29"
	expense.Time = "00:00"
	expense.Note = "=HYPERLINK(\"bad\")"
	income := sampleEntry(s)
	income.Kind = "income"
	income.CategoryID = s.Categories[8].ID
	income.Time = "13:42"
	income.Original = true
	s.Accounts = append(s.Accounts, Account{ID: newID(), Name: "Второй", Opening: "0.00"})
	transfer := sampleEntry(s)
	transfer.Kind = "transfer"
	transfer.CategoryID = ""
	transfer.ToAccountID = s.Accounts[1].ID
	s.Entries = []Entry{expense, income, transfer}
	data, err := writeXLSX(s)
	if err != nil {
		t.Fatal(err)
	}
	p, err := parseXLSX(data, initialState())
	if err != nil || len(p.Errors) > 0 || len(p.Entries) != 3 {
		t.Fatal(p.Errors, err, len(p.Entries))
	}
	for _, original := range s.Entries {
		if !slices.ContainsFunc(p.Entries, func(e Entry) bool {
			return e.Kind == original.Kind && e.Amount == original.Amount && e.Note == original.Note && e.Date == original.Date && e.Time == original.Time && e.Original == original.Original
		}) {
			encoded, _ := json.Marshal(p)
			t.Fatalf("round trip lost %+v: %s", original, encoded)
		}
	}
	again, err := parseXLSX(data, s)
	if err != nil || len(again.Duplicates) != 3 {
		t.Fatal("duplicate detection", again.Duplicates, err)
	}
}
func TestPrivateReferenceIfAvailable(t *testing.T) {
	path := filepath.Join("..", "docs", "references", "2026_10_28_18_01_55_401671.xlsx")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Skip("private reference is intentionally not committed")
	}
	if err != nil {
		t.Fatal(err)
	}
	p, err := parseXLSX(data, initialState())
	if err != nil || len(p.Errors) != 0 || len(p.Entries) != 7 {
		t.Fatal("reference", p.Errors, len(p.Entries), err)
	}
}
func TestDuplicateRowsAreNotRemoved(t *testing.T) {
	s := initialState()
	e := sampleEntry(s)
	other := e
	other.ID = newID()
	s.Entries = []Entry{e, other}
	data, err := writeXLSX(s)
	if err != nil {
		t.Fatal(err)
	}
	p, err := parseXLSX(data, initialState())
	if err != nil || len(p.Entries) != 2 || len(p.Duplicates) != 0 {
		t.Fatal("legitimate duplicates lost", p, err)
	}
}

func TestXLSXDuplicateAmountsUseMinorUnits(t *testing.T) {
	for _, amount := range []string{"100", "100.0", "100.00"} {
		t.Run(amount, func(t *testing.T) {
			state := initialState()
			entry := sampleEntry(state)
			entry.Amount = amount
			if _, err := state.apply(Command{ID: newID(), Entity: "entry", Data: jsonBytes(entry)}, "user", 2); err != nil {
				t.Fatal(err)
			}
			file, err := writeXLSX(state)
			if err != nil {
				t.Fatal(err)
			}
			proposal, err := parseXLSX(file, state)
			if err != nil || len(proposal.Duplicates) != 1 {
				t.Fatal("existing amount was not recognized", amount, proposal.Duplicates, err)
			}
		})
	}
}
func TestDerivedID(t *testing.T) {
	seed := newID()
	a, b := derivedID(seed, 0), derivedID(seed, 1)
	if a == b || a != derivedID(seed, 0) || !uuidPattern.MatchString(a) {
		t.Fatal(a, b)
	}
}
func TestOfflineCreateDeletedBeforeFirstUpload(t *testing.T) {
	s := initialState()
	e := sampleEntry(s)
	e.Deleted = true
	result, err := s.apply(Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)}, "user", 2)
	if err != nil || result.Status != "ok" || summary(s, Filter{})["expense"] != "0.00" {
		t.Fatal(result, err)
	}
	e.Deleted = false
	result, err = s.apply(Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)}, "user", 3)
	if err != nil || result.Status != "conflict" {
		t.Fatal("deleted entry resurrected", result, err)
	}
}

func TestLocalExportValidatesHistoryAndRejectsInvalidMoney(t *testing.T) {
	state := initialState()
	entry := sampleEntry(state)
	entry.Time = "00:00"
	state.Entries = []Entry{entry}
	state.Categories[0].Deleted = true
	replacement := state.Categories[0]
	replacement.ID = newID()
	replacement.Deleted = false
	state.Categories = append(state.Categories, replacement)
	if err := validateLocalState(state); err != nil {
		t.Fatal("valid archived history", err)
	}
	state.Entries[0].Amount = "NaN"
	if validateLocalState(state) == nil {
		t.Fatal("invalid money accepted")
	}
	state.Entries[0].Amount = "1.00"
	state.Entries[0].Time = "7:30"
	if validateLocalState(state) == nil {
		t.Fatal("noncanonical time accepted")
	}
}
