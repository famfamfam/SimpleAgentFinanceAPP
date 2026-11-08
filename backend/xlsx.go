package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/xuri/excelize/v2"
)

var expenseHeaders = []string{"Дата и время", "Категория", "Счет", "Сумма в валюте учета", "Валюта учета", "Сумма в валюте счета", "Валюта счета", "Сумма операции в валюте операции", "Валюта операции", "Теги", "Комментарий"}
var transferHeaders = []string{"Дата и время", "Исходящий счет", "Входящий счет", "Сумма в исходящей валюте счета", "Валюта исходящего счета", "Сумма во входящей валюте счета", "Валюта входящего счета", "Комментарий"}

type ImportProposal struct {
	Revision      *int64    `json:"revision,omitempty"`
	FileHash      string    `json:"fileHash,omitempty"`
	ID            string    `json:"id"`
	Commands      []Command `json:"commands"`
	Entries       []Entry   `json:"entries"`
	Duplicates    []string  `json:"duplicates"`
	Errors        []string  `json:"errors"`
	Applied       bool      `json:"applied"`
	NewAccounts   int       `json:"newAccounts"`
	NewCategories int       `json:"newCategories"`
}

func decimalCell(s string) (string, error) {
	r, ok := new(big.Rat).SetString(strings.TrimSpace(s))
	if !ok {
		return "", fmt.Errorf("неверная сумма")
	}
	r.Mul(r, big.NewRat(100, 1))
	if !r.IsInt() || !r.Num().IsInt64() {
		return "", fmt.Errorf("сумма должна иметь не больше двух знаков")
	}
	value := moneyString(r.Num().Int64())
	if _, err := money(value); err != nil {
		return "", err
	}
	return value, nil
}
func importDate(s string, date1904 bool) (string, string, error) {
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		t, err := excelize.ExcelDateToTime(n, date1904)
		if err != nil {
			return "", "", err
		}
		clock := ""
		if t.Hour() != 0 || t.Minute() != 0 {
			clock = t.Format("15:04")
		}
		return t.Format("2006-01-02"), clock, nil
	}
	for _, format := range []string{"2006-01-02", "2006-01-02 15:04:05", "2006-01-02 15:04", "02.01.2006", "02.01.2006 15:04", "02.01.2006 15:04:05"} {
		if t, err := time.Parse(format, s); err == nil {
			clock := ""
			if strings.Contains(format, "15:04") {
				clock = t.Format("15:04")
			}
			return t.Format("2006-01-02"), clock, nil
		}
	}
	return "", "", fmt.Errorf("неверная дата")
}
func entrySignature(e Entry) string {
	if amount, err := money(e.Amount); err == nil {
		e.Amount = moneyString(amount)
	}
	e.Currency = NormalizeCurrency(e.Currency)
	if e.Kind == "transfer" {
		if e.ToCurrency == "" {
			e.ToCurrency = e.Currency
		} else {
			e.ToCurrency = NormalizeCurrency(e.ToCurrency)
		}
		if e.ToAmount == "" && e.Currency == e.ToCurrency {
			e.ToAmount = e.Amount
		}
		if amount, err := money(e.ToAmount); err == nil {
			e.ToAmount = moneyString(amount)
		}
	}
	return strings.Join([]string{e.Kind, e.Amount, e.Currency, e.AccountID, e.ToAccountID, e.ToCurrency, e.ToAmount, e.CategoryID, e.Date, e.Time, e.Note, e.Tags}, "\x00")
}
func parseXLSX(data []byte, state State) (ImportProposal, error) {
	p := ImportProposal{ID: newID(), Commands: []Command{}, Entries: []Entry{}, Duplicates: []string{}, Errors: []string{}}
	f, err := excelize.OpenReader(bytes.NewReader(data), excelize.Options{UnzipSizeLimit: 100 << 20, UnzipXMLSizeLimit: 10 << 20, RawCellValue: true})
	if err != nil {
		return p, bad("Не удалось открыть XLSX. Проверьте формат и размер файла")
	}
	defer f.Close()
	props, err := f.GetWorkbookProps()
	if err != nil {
		return p, err
	}
	date1904 := props.Date1904 != nil && *props.Date1904
	names := f.GetSheetList()
	if len(names) != 3 || !slices.Contains(names, "Расходы") || !slices.Contains(names, "Доходы") || !slices.Contains(names, "Переводы") {
		return p, bad("Ожидаются листы Расходы, Доходы, Переводы")
	}
	existing := map[string]int{}
	for _, e := range state.Entries {
		if !e.Deleted {
			existing[entrySignature(e)]++
		}
	}
	account := func(name, currency string) (string, error) {
		name = strings.TrimSpace(name)
		if !validName(name) {
			return "", fmt.Errorf("не указан счет")
		}
		if !ValidCurrency(currency) {
			return "", fmt.Errorf("неизвестная валюта счета: %s", currency)
		}
		currency = NormalizeCurrency(currency)
		for _, x := range state.Accounts {
			if !x.Deleted && strings.EqualFold(strings.TrimSpace(x.Name), name) {
				if NormalizeCurrency(x.Currency) != currency {
					return "", fmt.Errorf("валюта счета %s не совпадает: %s и %s", name, NormalizeCurrency(x.Currency), currency)
				}
				return x.ID, nil
			}
		}
		x := Account{ID: newID(), Name: name, Opening: "0.00", Currency: currency}
		state.Accounts = append(state.Accounts, x)
		p.Commands = append(p.Commands, Command{ID: newID(), Entity: "account", Data: jsonBytes(x)})
		p.NewAccounts++
		return x.ID, nil
	}
	category := func(name, kind string) (string, error) {
		name = strings.TrimSpace(name)
		if !validName(name) {
			return "", fmt.Errorf("не указана категория")
		}
		for _, x := range state.Categories {
			if !x.Deleted && x.Kind == kind && strings.EqualFold(strings.TrimSpace(x.Name), name) {
				return x.ID, nil
			}
		}
		x := Category{ID: newID(), Name: name, Kind: kind, Color: "#5b8b67", Icon: "dots"}
		state.Categories = append(state.Categories, x)
		p.Commands = append(p.Commands, Command{ID: newID(), Entity: "category", Data: jsonBytes(x)})
		p.NewCategories++
		return x.ID, nil
	}
	total := 0
	for _, sheet := range []string{"Расходы", "Доходы", "Переводы"} {
		rows, err := f.GetRows(sheet, excelize.Options{RawCellValue: true})
		if err != nil {
			return p, err
		}
		headers := expenseHeaders
		if sheet == "Переводы" {
			headers = transferHeaders
		}
		if len(rows) < 2 || len(rows[1]) != len(headers) || !slices.Equal(rows[1], headers) {
			return p, bad("Не совпадают заголовки листа " + sheet)
		}
		for index, row := range rows[2:] {
			total++
			if total > 50000 {
				return p, bad("Не больше 50 тысяч строк")
			}
			if strings.TrimSpace(strings.Join(row, "")) == "" {
				continue
			}
			rowNumber := index + 3
			rowError := func(e error) {
				if len(p.Errors) < 100 {
					p.Errors = append(p.Errors, fmt.Sprintf("%s, строка %d: %s", sheet, rowNumber, e))
				}
			}
			values := make([]string, len(headers))
			copy(values, row)
			hasFormula := false
			for col := range headers {
				cell, _ := excelize.CoordinatesToCellName(col+1, rowNumber)
				formula, err := f.GetCellFormula(sheet, cell)
				if err != nil {
					return p, err
				}
				if formula != "" {
					hasFormula = true
					break
				}
			}
			if hasFormula {
				rowError(fmt.Errorf("формулы не поддерживаются"))
				continue
			}
			e := Entry{ID: newID(), Kind: "expense"}
			if sheet == "Доходы" {
				e.Kind = "income"
			}
			if sheet == "Переводы" {
				e.Kind = "transfer"
			}
			e.Date, e.Time, err = importDate(values[0], date1904)
			if err != nil {
				rowError(err)
				continue
			}
			if _, numeric := strconv.ParseFloat(values[0], 64); numeric == nil && e.Time == "" {
				styleID, _ := f.GetCellStyle(sheet, "A"+strconv.Itoa(rowNumber))
				style, _ := f.GetStyle(styleID)
				if style != nil && (style.NumFmt == 22 || (style.CustomNumFmt != nil && strings.Contains(strings.ToLower(*style.CustomNumFmt), "h"))) {
					e.Time = "00:00"
				}
			}
			if e.Kind == "transfer" {
				e.Amount, err = decimalCell(values[3])
				e.Currency = NormalizeCurrency(values[4])
				e.ToCurrency = NormalizeCurrency(values[6])
				if err == nil {
					if strings.TrimSpace(values[5]) == "" && e.Currency == e.ToCurrency {
						e.ToAmount = e.Amount
					} else {
						e.ToAmount, err = decimalCell(values[5])
					}
				}
				if err == nil {
					e.AccountID, err = account(values[1], e.Currency)
				}
				if err == nil {
					e.ToAccountID, err = account(values[2], e.ToCurrency)
				}
				e.Note = values[7]
			} else {
				e.Amount, err = decimalCell(values[5])
				e.Currency = NormalizeCurrency(values[6])
				if err == nil && (values[7] != "" || values[8] != "") {
					original, parseErr := decimalCell(values[7])
					if parseErr != nil || NormalizeCurrency(values[8]) != e.Currency || original != e.Amount {
						err = fmt.Errorf("исходная валюта или сумма операции отличается от суммы счета и не может быть сохранена")
					} else {
						e.Original = true
					}
				}
				if err == nil {
					e.AccountID, err = account(values[2], e.Currency)
				}
				if err == nil {
					e.CategoryID, err = category(values[1], e.Kind)
				}
				e.Note = values[10]
				e.Tags = values[9]
			}
			if err != nil {
				rowError(err)
				continue
			}
			if err = state.validateEntry(e); err != nil {
				rowError(err)
				continue
			}
			sig := entrySignature(e)
			if existing[sig] > 0 {
				p.Duplicates = append(p.Duplicates, e.ID)
				existing[sig]--
			}
			p.Entries = append(p.Entries, e)
		}
	}
	for _, e := range p.Entries {
		p.Commands = append(p.Commands, Command{ID: newID(), Entity: "entry", Data: jsonBytes(e)})
	}
	return p, nil
}
func requireXLSXProposalVersion(p ImportProposal, version int) error {
	if err := requireDataVersion(State{Entries: p.Entries}, version); err != nil {
		return err
	}
	for _, command := range p.Commands {
		if err := requireCommandDataVersion(command, version); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) importPreview(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	book := r.PathValue("book")
	s, err := a.snapshot(r.Context(), u.ID, book)
	if err != nil {
		return err
	}
	version := dataVersionFromContext(r.Context())
	if err := requireDataVersion(s.State, version); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, (10<<20)+1))
	if err != nil || len(data) > 10<<20 {
		return bad("Файл должен быть не больше 10 MiB")
	}
	fingerprint := hash(string(data))
	var existing []byte
	var applied bool
	err = a.db.QueryRow(r.Context(), `SELECT proposal,applied FROM imports WHERE book_id=$1 AND file_hash=$2`, book, fingerprint).Scan(&existing, &applied)
	if err == nil {
		var p ImportProposal
		if err = json.Unmarshal(existing, &p); err != nil {
			return err
		}
		if applied || (p.Revision != nil && *p.Revision == s.Revision) {
			if err := requireXLSXProposalVersion(p, version); err != nil {
				return err
			}
			p.Applied = applied
			respond(w, p)
			return nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	p, err := parseXLSX(data, s.State)
	if err != nil {
		return err
	}
	if err := requireXLSXProposalVersion(p, version); err != nil {
		return err
	}
	p.Revision = &s.Revision
	err = a.db.QueryRow(r.Context(), `INSERT INTO imports(id,book_id,user_id,file_hash,proposal) VALUES($1,$2,$3,$4,$5)
ON CONFLICT(book_id,file_hash) DO UPDATE SET id=EXCLUDED.id,user_id=EXCLUDED.user_id,proposal=EXCLUDED.proposal,created_at=now()
WHERE NOT imports.applied RETURNING proposal,applied`, p.ID, book, u.ID, fingerprint, jsonBytes(p)).Scan(&existing, &applied)
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent confirmation won the row lock; preserve its completed import.
		err = a.db.QueryRow(r.Context(), `SELECT proposal,applied FROM imports WHERE book_id=$1 AND file_hash=$2`, book, fingerprint).Scan(&existing, &applied)
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(existing, &p); err != nil {
		return err
	}
	if err := requireXLSXProposalVersion(p, version); err != nil {
		return err
	}
	p.Applied = applied
	respond(w, p)
	return nil
}
func (a *App) importApply(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	book := r.PathValue("book")
	if _, err = a.access(r.Context(), u.ID, book); err != nil {
		return err
	}
	var in struct {
		IncludeDuplicates []string `json:"includeDuplicates"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var raw []byte
	var applied bool
	if err = tx.QueryRow(r.Context(), `SELECT proposal,applied FROM imports WHERE id=$1 AND book_id=$2 FOR UPDATE`, r.PathValue("id"), book).Scan(&raw, &applied); err != nil {
		return bad("Предпросмотр не найден")
	}
	if applied {
		respond(w, map[string]bool{"alreadyApplied": true})
		return nil
	}
	var p ImportProposal
	if err = json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if err := requireXLSXProposalVersion(p, dataVersionFromContext(r.Context())); err != nil {
		return err
	}
	if len(p.Errors) > 0 {
		return bad("Сначала исправьте ошибки файла")
	}
	var revision int64
	if err = tx.QueryRow(r.Context(), `SELECT revision FROM books WHERE id=$1 FOR UPDATE`, book).Scan(&revision); err != nil {
		return err
	}
	if p.Revision == nil || *p.Revision != revision {
		return apiError{409, "Учет изменился после предпросмотра. Откройте файл заново"}
	}
	commands := []Command{}
	for _, c := range p.Commands {
		if c.Entity == "entry" {
			var e Entry
			json.Unmarshal(c.Data, &e)
			if slices.Contains(p.Duplicates, e.ID) && !slices.Contains(in.IncludeDuplicates, e.ID) {
				continue
			}
		}
		commands = append(commands, c)
	}
	out, err := a.applyInTx(r.Context(), tx, u.ID, book, commands, true)
	if err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), `UPDATE imports SET applied=true WHERE id=$1`, p.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]any{"imported": len(commands) - p.NewAccounts - p.NewCategories, "revision": out.Revision})
	return nil
}
func writeXLSX(state State) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()
	f.SetSheetName("Sheet1", "Расходы")
	f.NewSheet("Доходы")
	f.NewSheet("Переводы")
	dateStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 14})
	timeStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 22})
	moneyStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 2})
	headStyle, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	rows := map[string]int{"Расходы": 3, "Доходы": 3, "Переводы": 3}
	for _, sheet := range []string{"Расходы", "Доходы", "Переводы"} {
		headers := expenseHeaders
		end := "J"
		if sheet == "Переводы" {
			headers = transferHeaders
			end = "H"
		}
		title := "Список " + map[string]string{"Расходы": "расходов", "Доходы": "доходов", "Переводы": "переводов"}[sheet]
		f.SetCellStr(sheet, "A1", title)
		f.MergeCell(sheet, "A1", end+"1")
		for i, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(i+1, 2)
			f.SetCellStr(sheet, cell, h)
		}
		f.SetCellStyle(sheet, "A1", "K2", headStyle)
		f.SetColWidth(sheet, "A", "K", 23)
		f.SetPanes(sheet, &excelize.Panes{Freeze: true, YSplit: 2, TopLeftCell: "A3"})
	}
	nameAccount := func(id string) string {
		for _, x := range state.Accounts {
			if x.ID == id {
				return x.Name
			}
		}
		return ""
	}
	accountCurrency := func(id string) (string, error) {
		for _, x := range state.Accounts {
			if x.ID == id && ValidCurrency(x.Currency) {
				return NormalizeCurrency(x.Currency), nil
			}
		}
		return "", fmt.Errorf("счет операции не найден или имеет неизвестную валюту")
	}
	nameCategory := func(id string) string {
		for _, x := range state.Categories {
			if x.ID == id {
				return x.Name
			}
		}
		return ""
	}
	for _, e := range state.Entries {
		if e.Deleted {
			continue
		}
		sheet := "Расходы"
		if e.Kind == "income" {
			sheet = "Доходы"
		}
		if e.Kind == "transfer" {
			sheet = "Переводы"
		}
		row := rows[sheet]
		rows[sheet]++
		date, _ := time.Parse("2006-01-02", e.Date)
		style := dateStyle
		if e.Time != "" {
			date, _ = time.Parse("2006-01-02 15:04", e.Date+" "+e.Time)
			style = timeStyle
		}
		cell := "A" + strconv.Itoa(row)
		if err := f.SetCellValue(sheet, cell, date); err != nil {
			return nil, err
		}
		f.SetCellStyle(sheet, cell, cell, style)
		n, err := money(e.Amount)
		currency, currencyErr := accountCurrency(e.AccountID)
		if err != nil || n <= 0 || currencyErr != nil || NormalizeCurrency(e.Currency) != currency {
			return nil, fmt.Errorf("неверная сумма или валюта операции")
		}
		type number string
		amount := number(moneyString(n))
		values := []any{nameCategory(e.CategoryID), nameAccount(e.AccountID), amount, currency, amount, currency, "", "", e.Tags, e.Note}
		if e.Original {
			values[6] = amount
			values[7] = currency
		}
		if e.Kind == "transfer" {
			toCurrency, toErr := accountCurrency(e.ToAccountID)
			toAmount := e.ToAmount
			if toAmount == "" && currency == toCurrency {
				toAmount = e.Amount
			}
			entryToCurrency := e.ToCurrency
			if entryToCurrency == "" {
				entryToCurrency = currency
			}
			to, err := money(toAmount)
			if toErr != nil || entryToCurrency != toCurrency || err != nil || to <= 0 || (currency == toCurrency && n != to) {
				return nil, fmt.Errorf("неверная сумма или валюта получателя перевода")
			}
			values = []any{nameAccount(e.AccountID), nameAccount(e.ToAccountID), amount, currency, number(moneyString(to)), toCurrency, e.Note}
		}
		for col, value := range values {
			cell, _ := excelize.CoordinatesToCellName(col+2, row)
			if n, ok := value.(number); ok {
				if err := f.SetCellDefault(sheet, cell, string(n)); err != nil {
					return nil, err
				}
				f.SetCellStyle(sheet, cell, cell, moneyStyle)
			} else if err := f.SetCellStr(sheet, cell, value.(string)); err != nil {
				return nil, err
			}
		}
	}
	f.SetActiveSheet(0)
	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
func (a *App) exportXLSX(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	s, err := a.snapshot(r.Context(), u.ID, r.PathValue("book"))
	if err != nil {
		return err
	}
	if err := requireDataVersion(s.State, dataVersionFromContext(r.Context())); err != nil {
		return err
	}
	data, err := writeXLSX(s.State)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="finance.xlsx"`)
	_, err = w.Write(data)
	return err
}

var localXLSXSlot = make(chan struct{}, 1)

// These conversions only use the supplied data and never read or change a server book.
func (a *App) localXLSX(w http.ResponseWriter, r *http.Request) error {
	action := r.PathValue("action")
	if action != "preview" && action != "export" {
		return apiError{404, "Функция не найдена"}
	}
	if err := a.limit(r, "local-xlsx:"+clientIP(r), 30, time.Minute); err != nil {
		return err
	}
	select {
	case localXLSXSlot <- struct{}{}:
		defer func() { <-localXLSXSlot }()
	default:
		return apiError{429, "Сейчас обрабатывается другой файл. Попробуйте чуть позже"}
	}
	var state State
	if action == "preview" {
		if err := r.ParseMultipartForm(12 << 20); err != nil {
			return bad("Не удалось прочитать файл. Максимальный размер — 10 MiB")
		}
		defer r.MultipartForm.RemoveAll()
		catalogs := r.FormValue("state")
		if len(catalogs) > 512<<10 {
			return bad("Слишком большой список счетов и категорий")
		}
		decoder := json.NewDecoder(strings.NewReader(catalogs))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&state); err != nil {
			return bad("Неверный список счетов и категорий")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return bad("Ожидался один список счетов и категорий")
		}
		if len(state.Entries) > 0 {
			return bad("Для предпросмотра нужны только счета и категории")
		}
		if err := validateLocalState(state); err != nil {
			return err
		}
		if err := requireDataVersion(state, dataVersionFromContext(r.Context())); err != nil {
			return err
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			return bad("Выберите XLSX-файл")
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, (10<<20)+1))
		if err != nil || len(data) > 10<<20 {
			return bad("Файл должен быть не больше 10 MiB")
		}
		proposal, err := parseXLSX(data, state)
		if err != nil {
			return err
		}
		if err := requireXLSXProposalVersion(proposal, dataVersionFromContext(r.Context())); err != nil {
			return err
		}
		proposal.FileHash = hash(string(data))
		respond(w, proposal)
		return nil
	}
	if err := localExportState(r, &state); err != nil {
		return err
	}
	if err := validateLocalState(state); err != nil {
		return err
	}
	if err := requireDataVersion(state, dataVersionFromContext(r.Context())); err != nil {
		return err
	}
	data, err := writeXLSX(state)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="finance.xlsx"`)
	_, err = w.Write(data)
	return err
}

const maxLocalExportBytes = 64 << 20

func localExportState(r *http.Request, state *State) error {
	switch r.Header.Get("Content-Encoding") {
	case "", "identity":
		return body(r, state)
	case "gzip":
		reader, err := gzip.NewReader(r.Body)
		if err != nil {
			return bad("Не удалось прочитать сжатые данные книги")
		}
		defer reader.Close()
		data, err := io.ReadAll(io.LimitReader(reader, maxLocalExportBytes+1))
		if err != nil {
			return bad("Не удалось прочитать сжатые данные книги")
		}
		if len(data) > maxLocalExportBytes {
			return apiError{413, "Книга для XLSX должна быть не больше 64 MiB. Сохраните локальную копию JSON"}
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		return body(r, state)
	default:
		return apiError{415, "Неподдерживаемое сжатие книги"}
	}
}

func validateLocalState(state State) error {
	if len(state.Accounts) > 100 || len(state.Categories) > 500 || len(state.Entries) > 50000 {
		return bad("Лимит книги: 100 счетов, 500 категорий, 50 000 операций")
	}
	checked := State{Accounts: []Account{}, Categories: []Category{}, Entries: []Entry{}}
	for _, account := range state.Accounts {
		result, err := checked.apply(Command{ID: newID(), Entity: "account", Data: jsonBytes(account)}, "local", 1)
		if err != nil {
			return bad(err.Error())
		}
		if result.Status != "ok" {
			return bad("Счета с одинаковыми идентификаторами")
		}
	}
	for _, category := range state.Categories {
		result, err := checked.apply(Command{ID: newID(), Entity: "category", Data: jsonBytes(category)}, "local", 1)
		if err != nil {
			return bad(err.Error())
		}
		if result.Status != "ok" {
			return bad("Категории с одинаковыми идентификаторами")
		}
	}
	// Historical operations may reference archived catalogs.
	for i := range checked.Accounts {
		checked.Accounts[i].Deleted = false
	}
	for i := range checked.Categories {
		checked.Categories[i].Deleted = false
	}
	seen := map[string]bool{}
	for _, entry := range state.Entries {
		if !uuidPattern.MatchString(entry.ID) || seen[entry.ID] {
			return bad("Неверный или повторяющийся идентификатор операции")
		}
		seen[entry.ID] = true
		if err := checked.validateEntry(entry); err != nil {
			return bad(err.Error())
		}
	}
	return nil
}
