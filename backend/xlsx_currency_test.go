package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xuri/excelize/v2"
)

func currencyWorkbook(t *testing.T, sheet string, row []string) []byte {
	t.Helper()
	data, err := writeXLSX(State{})
	if err != nil {
		t.Fatal(err)
	}
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for i, value := range row {
		cell, _ := excelize.CoordinatesToCellName(i+1, 3)
		if err := f.SetCellStr(sheet, cell, value); err != nil {
			t.Fatal(err)
		}
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestXLSXAccountColumnsAreSourceAndLegacyRUBIsDuplicate(t *testing.T) {
	s := initialState()
	e := sampleEntry(s)
	e.Amount = "10.25"
	e.Date = "2024-01-02"
	s.Entries = []Entry{e}
	data := currencyWorkbook(t, "Расходы", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "12.00", "USD", "10.25", "RUB", "10.25", "RUB", e.Tags, e.Note})
	p, err := parseXLSX(data, s)
	if err != nil || len(p.Errors) != 0 || len(p.Entries) != 1 || len(p.Duplicates) != 1 {
		t.Fatalf("legacy/account columns: %+v, %v", p, err)
	}
	if p.Entries[0].Amount != "10.25" || p.Entries[0].Currency != "RUB" {
		t.Fatalf("wrong account values: %+v", p.Entries[0])
	}
}

func TestXLSXMixedCurrencyRoundTripExactAmountsAndDuplicates(t *testing.T) {
	s := initialState()
	s.Accounts = append(s.Accounts, Account{ID: newID(), Name: "Dollar", Opening: "0.00", Currency: "USD"})
	expense := sampleEntry(s)
	expense.AccountID = s.Accounts[1].ID
	expense.Currency = "USD"
	expense.Amount = "999999999.99"
	expense.Date = "2024-01-02"
	expense.Original = true
	transfer := Entry{ID: newID(), Kind: "transfer", AccountID: s.Accounts[0].ID, ToAccountID: s.Accounts[1].ID, Amount: "9000.00", Currency: "RUB", ToAmount: "100.01", ToCurrency: "USD", Date: "2024-01-03"}
	s.Entries = []Entry{expense, transfer}
	data, err := writeXLSX(s)
	if err != nil {
		t.Fatal(err)
	}
	f, err := excelize.OpenReader(bytes.NewReader(data), excelize.Options{RawCellValue: true})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for cell, want := range map[string]string{"D3": "999999999.99", "E3": "USD", "F3": "999999999.99", "G3": "USD", "H3": "999999999.99", "I3": "USD"} {
		got, err := f.GetCellValue("Расходы", cell, excelize.Options{RawCellValue: true})
		if err != nil || got != want {
			t.Errorf("%s = %q, want %q (%v)", cell, got, want, err)
		}
	}
	p, err := parseXLSX(data, s)
	if err != nil || len(p.Errors) != 0 || len(p.Entries) != 2 || len(p.Duplicates) != 2 {
		t.Fatalf("round trip: %+v, %v", p, err)
	}
	got := p.Entries[1]
	if got.Amount != "9000.00" || got.Currency != "RUB" || got.ToAmount != "100.01" || got.ToCurrency != "USD" {
		t.Fatalf("transfer lost data: %+v", got)
	}
}

func TestXLSXAllSupportedCurrenciesRoundTripAsAccountCurrency(t *testing.T) {
	for _, code := range []string{"RUB", "USD", "EUR", "CNY", "GBP", "CHF", "GEL", "TRY", "AED", "KZT", "BYN", "UAH"} {
		t.Run(code, func(t *testing.T) {
			s := initialState()
			s.Accounts[0].Currency = code
			e := sampleEntry(s)
			e.Currency, e.Amount = code, "0.29"
			s.Entries = []Entry{e}
			data, err := writeXLSX(s)
			if err != nil {
				t.Fatal(err)
			}
			p, err := parseXLSX(data, s)
			if err != nil || len(p.Errors) != 0 || len(p.Duplicates) != 1 || len(p.Entries) != 1 || p.Entries[0].Amount != "0.29" || p.Entries[0].Currency != code {
				t.Fatalf("currency lost: %+v %v", p, err)
			}
		})
	}
}

func TestXLSXRejectsOriginalLossAndAccountCurrencyMismatch(t *testing.T) {
	s := initialState()
	for _, tc := range []struct {
		name string
		row  []string
	}{
		{"different original amount", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "10", "RUB", "11", "RUB"}},
		{"different original currency", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "10", "RUB", "10", "USD"}},
		{"partial original", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "10", "RUB", "", "RUB"}},
		{"existing account currency", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "USD", "10", "USD"}},
		{"unsupported currency", []string{"2024-01-02", s.Categories[0].Name, "New", "10", "XXX", "10", "XXX"}},
		{"empty account amount", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "", "RUB"}},
		{"zero account amount", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "0", "RUB"}},
		{"negative account amount", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "-1", "RUB"}},
		{"excess precision", []string{"2024-01-02", s.Categories[0].Name, s.Accounts[0].Name, "10", "RUB", "1.001", "RUB"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := parseXLSX(currencyWorkbook(t, "Расходы", tc.row), s)
			if err != nil || len(p.Errors) == 0 || len(p.Entries) != 0 {
				t.Fatalf("expected rejection: %+v %v", p, err)
			}
		})
	}
}

func TestXLSXCreatesCurrencyAccountsAndDefaultsEmptyCurrencyToRUB(t *testing.T) {
	for _, tc := range []struct{ currency, want string }{{"USD", "USD"}, {"", "RUB"}} {
		s := initialState()
		data := currencyWorkbook(t, "Расходы", []string{"2024-01-02", s.Categories[0].Name, "New", "2", tc.currency, "2", tc.currency})
		p, err := parseXLSX(data, s)
		if err != nil || len(p.Errors) != 0 || len(p.Entries) != 1 || p.NewAccounts != 1 || p.Entries[0].Currency != tc.want {
			t.Fatalf("%q: %+v %v", tc.currency, p, err)
		}
		var account Account
		if err := json.Unmarshal(p.Commands[0].Data, &account); err != nil || account.Currency != tc.want {
			t.Fatalf("created account: %+v %v", account, err)
		}
	}
}

func TestXLSXRejectsInvalidTransferDestination(t *testing.T) {
	s := initialState()
	s.Accounts = append(s.Accounts, Account{ID: newID(), Name: "Dollar", Opening: "0.00", Currency: "USD"})
	for _, tc := range []struct{ name, amount, currency string }{
		{"missing amount", "", "USD"},
		{"zero amount", "0", "USD"},
		{"negative amount", "-1", "USD"},
		{"account currency mismatch", "1", "EUR"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := currencyWorkbook(t, "Переводы", []string{"2024-01-02", s.Accounts[0].Name, "Dollar", "10", "RUB", tc.amount, tc.currency})
			p, err := parseXLSX(data, s)
			if err != nil || len(p.Errors) == 0 || len(p.Entries) != 0 {
				t.Fatalf("expected rejection: %+v %v", p, err)
			}
		})
	}
}

func TestXLSXExportRejectsMissingCrossCurrencyDestinationAmount(t *testing.T) {
	s := initialState()
	s.Accounts = append(s.Accounts, Account{ID: newID(), Name: "Dollar", Opening: "0.00", Currency: "USD"})
	s.Entries = []Entry{{ID: newID(), Kind: "transfer", Amount: "10", Currency: "RUB", AccountID: s.Accounts[0].ID, ToAccountID: s.Accounts[1].ID, ToCurrency: "USD", Date: "2024-01-02"}}
	if _, err := writeXLSX(s); err == nil {
		t.Fatal("export discarded missing destination amount")
	}
}

func TestXLSXSameCurrencyMissingDestinationAmountDefaultsToSource(t *testing.T) {
	s := initialState()
	s.Accounts = append(s.Accounts, Account{ID: newID(), Name: "Dollar 1", Opening: "0", Currency: "USD"}, Account{ID: newID(), Name: "Dollar 2", Opening: "0", Currency: "USD"})
	entry := Entry{ID: newID(), Kind: "transfer", Amount: "10.25", Currency: "USD", AccountID: s.Accounts[1].ID, ToAccountID: s.Accounts[2].ID, Date: "2024-01-02"}
	s.Entries = []Entry{entry}
	data := currencyWorkbook(t, "Переводы", []string{"2024-01-02", "Dollar 1", "Dollar 2", "10.25", "USD", "", "USD"})
	p, err := parseXLSX(data, s)
	if err != nil || len(p.Errors) != 0 || len(p.Entries) != 1 || len(p.Duplicates) != 1 || p.Entries[0].ToAmount != "10.25" {
		t.Fatalf("same-currency fallback: %+v %v", p, err)
	}
	data, err = writeXLSX(s)
	if err != nil {
		t.Fatal(err)
	}
	p, err = parseXLSX(data, s)
	if err != nil || len(p.Errors) != 0 || len(p.Duplicates) != 1 {
		t.Fatalf("same-currency export: %+v %v", p, err)
	}
}

func TestXLSXProposalVersionRejectsForeignEntriesAndAccountCommands(t *testing.T) {
	for _, p := range []ImportProposal{
		{Entries: []Entry{{Currency: "USD"}}},
		{Entries: []Entry{{Currency: "RUB", ToCurrency: "EUR"}}},
		{Commands: []Command{{Entity: "account", Data: jsonBytes(Account{Currency: "USD"})}}},
	} {
		if err := requireXLSXProposalVersion(p, 0); err == nil {
			t.Fatal("legacy client accepted foreign proposal", p)
		}
		if err := requireXLSXProposalVersion(p, 4); err != nil {
			t.Fatal("updated client rejected", err)
		}
	}
	if err := requireXLSXProposalVersion(ImportProposal{Entries: []Entry{{Currency: ""}}}, 0); err != nil {
		t.Fatal("legacy RUB proposal rejected", err)
	}
}

func TestXLSXRoutesRejectLegacyClientsForMixedStateAndProposal(t *testing.T) {
	a := integrationApp(t)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	client, userID, _ := registerClient(t, server.URL, "XLSX capability")
	book := newID()
	call(t, client, "POST", server.URL+"/api/books", map[string]string{"id": book, "name": "Import"}, http.StatusOK)

	mixed := initialState()
	mixed.Accounts = append(mixed.Accounts, Account{ID: newID(), Name: "Dollar", Opening: "0.00", Currency: "USD"})
	entry := sampleEntry(mixed)
	entry.AccountID, entry.Currency = mixed.Accounts[1].ID, "USD"
	mixed.Entries = []Entry{entry}
	file, err := writeXLSX(mixed)
	if err != nil {
		t.Fatal(err)
	}

	request := func(method, path, contentType, version string, body []byte, want int) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", contentType)
		if version != "" {
			req.Header.Set("X-Finance-Data-Version", version)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != want {
			t.Fatalf("%s version=%q: status %d, want %d: %s (%v)", path, version, resp.StatusCode, want, raw, err)
		}
		if want == http.StatusUpgradeRequired {
			var payload map[string]any
			if json.Unmarshal(raw, &payload) != nil || payload["code"] != "client_update_required" {
				t.Fatalf("bad update response: %s", raw)
			}
		}
	}
	localExport := "/api/local-files/export"
	request("POST", localExport, "application/json", "", jsonBytes(mixed), 426)
	request("POST", localExport, "application/json", "4", jsonBytes(mixed), 200)
	catalogs := initialState()
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	if err := writer.WriteField("state", string(jsonBytes(catalogs))); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("file", "mixed.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(file); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request("POST", "/api/local-files/preview", writer.FormDataContentType(), "", form.Bytes(), 426)
	request("POST", "/api/local-files/preview", writer.FormDataContentType(), "4", form.Bytes(), 200)
	preview := "/api/books/" + book + "/import"
	request("POST", preview, "application/octet-stream", "", file, 426)
	request("POST", preview, "application/octet-stream", "4", file, 200)
	request("POST", preview, "application/octet-stream", "", file, 426)
	if _, err := a.applyCommands(context.Background(), userID, book, []Command{{ID: newID(), Entity: "account", Data: jsonBytes(mixed.Accounts[1])}}); err != nil {
		t.Fatal(err)
	}
	export := "/api/books/" + book + "/export"
	request("GET", export, "", "", nil, 426)
	request("GET", export, "", "4", nil, 200)
	request("POST", preview, "application/octet-stream", "", file, 426)
}

func TestXLSXTransferDuplicateUsesDestinationAmountAndLegacyDefaults(t *testing.T) {
	old := Entry{Kind: "transfer", Amount: "10", AccountID: "a", ToAccountID: "b", Date: "2024-01-02"}
	modern := old
	modern.Amount, modern.Currency, modern.ToAmount, modern.ToCurrency = "10.00", "RUB", "10.00", "RUB"
	if entrySignature(old) != entrySignature(modern) {
		t.Fatal("legacy RUB transfer must match explicit RUB")
	}
	modern.ToAmount = "11.00"
	if entrySignature(old) == entrySignature(modern) {
		t.Fatal("different destination amounts must not match")
	}
	modern.ToAmount, modern.ToCurrency = "10.00", "USD"
	if entrySignature(old) == entrySignature(modern) {
		t.Fatal("different destination currencies must not match")
	}
}
