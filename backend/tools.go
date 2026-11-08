package main

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	qrcode "github.com/skip2/go-qrcode"
)

type Filter struct {
	DataVersion int    `json:"dataVersion,omitempty" jsonschema:"Версия формата данных: 4 для мультивалютности; без версии доступна только RUB-книга"`
	From        string `json:"from,omitempty"`
	To          string `json:"to,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
	CategoryID  string `json:"categoryId,omitempty"`
	Query       string `json:"query,omitempty"`
	Kind        string `json:"kind,omitempty"`
}
type EntryDraft struct {
	Kind        string `json:"kind"`
	Amount      string `json:"amount" jsonschema:"Сумма списания или зачисления десятичной строкой"`
	Currency    string `json:"currency,omitempty" jsonschema:"Валюта исходного счета; пустая означает RUB"`
	ToAmount    string `json:"toAmount,omitempty" jsonschema:"Сумма зачисления для перевода"`
	ToCurrency  string `json:"toCurrency,omitempty" jsonschema:"Валюта счета получателя"`
	AccountID   string `json:"accountId"`
	CategoryID  string `json:"categoryId,omitempty"`
	ToAccountID string `json:"toAccountId,omitempty"`
	Date        string `json:"date"`
	Time        string `json:"time,omitempty" jsonschema:"Локальное время HH:mm, необязательно"`
	Note        string `json:"note,omitempty"`
	Tags        string `json:"tags,omitempty"`
}

func filtered(s State, f Filter) []Entry {
	out := []Entry{}
	for _, e := range s.Entries {
		if e.Deleted || (f.From != "" && e.Date < f.From) || (f.To != "" && e.Date > f.To) || (f.AccountID != "" && e.AccountID != f.AccountID && e.ToAccountID != f.AccountID) || (f.CategoryID != "" && e.CategoryID != f.CategoryID) || (f.Kind != "" && e.Kind != f.Kind) {
			continue
		}
		category := ""
		for _, c := range s.Categories {
			if c.ID == e.CategoryID {
				category = c.Name
				break
			}
		}
		if f.Query != "" && !strings.Contains(strings.ToLower(e.Note+" "+e.Tags+" "+category), strings.ToLower(f.Query)) {
			continue
		}
		out = append(out, e)
	}
	slices.SortStableFunc(out, func(a, b Entry) int {
		if date := strings.Compare(b.Date, a.Date); date != 0 {
			return date
		}
		if clock := strings.Compare(b.Time, a.Time); clock != 0 {
			return clock
		}
		return strings.Compare(b.ID, a.ID)
	})
	return out
}
func summary(s State, f Filter) map[string]any {
	type totals struct {
		income, expense int64
		categories      map[string]int64
	}
	byCurrency := map[string]*totals{}
	balances := map[string]int64{}
	accountCurrencies := map[string]string{}
	for _, a := range s.Accounts {
		balances[a.ID], _ = money(a.Opening)
		accountCurrencies[a.ID] = NormalizeCurrency(a.Currency)
	}
	for _, e := range s.Entries {
		if e.Deleted {
			continue
		}
		n, _ := money(e.Amount)
		switch e.Kind {
		case "income":
			balances[e.AccountID] += n
		case "expense":
			balances[e.AccountID] -= n
		case "transfer":
			balances[e.AccountID] -= n
			to := e.ToAmount
			if to == "" && NormalizeCurrency(e.Currency) == NormalizeCurrency(e.ToCurrency) {
				to = e.Amount
			}
			received, _ := money(to)
			balances[e.ToAccountID] += received
		}
	}
	entries := filtered(s, f)
	for _, e := range entries {
		if e.Kind != "expense" && e.Kind != "income" {
			continue
		}
		currency := NormalizeCurrency(e.Currency)
		if byCurrency[currency] == nil {
			byCurrency[currency] = &totals{categories: map[string]int64{}}
		}
		t := byCurrency[currency]
		n, _ := money(e.Amount)
		if e.Kind == "expense" {
			t.expense += n
			t.categories[e.CategoryID] += n
		} else {
			t.income += n
		}
	}
	groups := map[string]map[string]any{}
	for currency, t := range byCurrency {
		cats := map[string]string{}
		for id, n := range t.categories {
			cats[id] = moneyString(n)
		}
		groups[currency] = map[string]any{"income": moneyString(t.income), "expense": moneyString(t.expense), "categories": cats}
	}
	accounts := map[string]string{}
	for id, n := range balances {
		accounts[id] = moneyString(n)
	}
	result := map[string]any{"byCurrency": groups, "accountBalances": accounts, "accountCurrencies": accountCurrencies, "count": len(entries), "filter": f}
	// Preserve the legacy RUB summary only for RUB-only books.
	rubOnly := true
	for _, c := range accountCurrencies {
		if c != "RUB" {
			rubOnly = false
		}
	}
	for _, e := range s.Entries {
		if !e.Deleted && (NormalizeCurrency(e.Currency) != "RUB" || (e.Kind == "transfer" && NormalizeCurrency(e.ToCurrency) != "RUB")) {
			rubOnly = false
		}
	}
	for c := range groups {
		if c != "RUB" {
			rubOnly = false
		}
	}
	if rubOnly {
		rub := groups["RUB"]
		if rub == nil {
			rub = map[string]any{"income": "0.00", "expense": "0.00", "categories": map[string]string{}}
		}
		for k, v := range rub {
			result[k] = v
		}
		result["currency"] = "RUB"
	}
	return result
}

type integrationContext struct {
	user, book string
	write      bool
	request    context.Context
}
type integrationKey struct{}

func (a *App) mcpHandler() http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "finance", Version: buildVersion}, nil)
	// The SDK detaches legacy MCP calls from HTTP cancellation, even in stateless mode.
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			i := ctx.Value(integrationKey{}).(integrationContext)
			deadline, _ := i.request.Deadline() // endpoint always supplies the deadline.
			ctx, cancel := context.WithDeadline(ctx, deadline)
			stop := context.AfterFunc(i.request, cancel)
			defer stop()
			defer cancel()
			return next(ctx, method, req)
		}
	})
	type CatalogInput struct {
		DataVersion int `json:"dataVersion,omitempty" jsonschema:"Версия формата данных: 4 для мультивалютности; без версии доступна только RUB-книга"`
	}
	mcp.AddTool(server, &mcp.Tool{Name: "list_catalogs", Description: "Счета с валютами и категории доступной книги. Данные версии 4."}, func(ctx context.Context, _ *mcp.CallToolRequest, in CatalogInput) (*mcp.CallToolResult, any, error) {
		i := ctx.Value(integrationKey{}).(integrationContext)
		s, err := a.snapshot(ctx, i.user, i.book)
		if err != nil {
			return nil, nil, err
		}
		if err := requireDataVersion(s.State, in.DataVersion); err != nil {
			return nil, nil, err
		}
		for index := range s.State.Accounts {
			s.State.Accounts[index].Currency = NormalizeCurrency(s.State.Accounts[index].Currency)
		}
		return nil, map[string]any{"accounts": s.State.Accounts, "categories": s.State.Categories, "revision": s.Revision, "dataVersion": 4}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "get_summary", Description: "Точные итоги доходов, расходов и категорий. Даты YYYY-MM-DD включительно."}, func(ctx context.Context, _ *mcp.CallToolRequest, f Filter) (*mcp.CallToolResult, any, error) {
		i := ctx.Value(integrationKey{}).(integrationContext)
		s, err := a.snapshot(ctx, i.user, i.book)
		if err != nil {
			return nil, nil, err
		}
		if err := requireDataVersion(s.State, f.DataVersion); err != nil {
			return nil, nil, err
		}
		return nil, summary(s.State, f), nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "find_transactions", Description: "Найти операции по фильтрам; возвращает до 100 записей, для итогов используйте get_summary."}, func(ctx context.Context, _ *mcp.CallToolRequest, f Filter) (*mcp.CallToolResult, any, error) {
		i := ctx.Value(integrationKey{}).(integrationContext)
		s, err := a.snapshot(ctx, i.user, i.book)
		if err != nil {
			return nil, nil, err
		}
		if err := requireDataVersion(s.State, f.DataVersion); err != nil {
			return nil, nil, err
		}
		rows := filtered(s.State, f)
		return nil, map[string]any{"entries": rows[:min(100, len(rows))], "total": len(rows)}, nil
	})
	type CreateInput struct {
		DataVersion int          `json:"dataVersion,omitempty" jsonschema:"Версия формата данных: 4 для мультивалютности; без версии доступна только RUB-книга"`
		RequestID   string       `json:"requestId" jsonschema:"UUID v4, повторять тот же ID при повторе запроса"`
		Entries     []EntryDraft `json:"entries" jsonschema:"Операции: amount десятичной строкой, date YYYY-MM-DD, реальные ID счетов и категорий"`
	}
	mcp.AddTool(server, &mcp.Tool{Name: "create_transactions", Description: "Добавить операции. Нужен токен записи. Не удаляет и не изменяет существующие записи. Сначала уточните неоднозначные данные."}, func(ctx context.Context, _ *mcp.CallToolRequest, in CreateInput) (*mcp.CallToolResult, any, error) {
		i := ctx.Value(integrationKey{}).(integrationContext)
		if !i.write {
			return nil, nil, forbidden()
		}
		if !uuidPattern.MatchString(in.RequestID) || len(in.Entries) < 1 || len(in.Entries) > 50 {
			return nil, nil, bad("Укажите requestId UUID и 1–50 операций")
		}
		commands := []Command{}
		ids := []string{}
		for index, draft := range in.Entries {
			e := Entry{ID: derivedID(in.RequestID, index), Kind: draft.Kind, Amount: draft.Amount, Currency: draft.Currency, ToAmount: draft.ToAmount, ToCurrency: draft.ToCurrency, AccountID: draft.AccountID, CategoryID: draft.CategoryID, ToAccountID: draft.ToAccountID, Date: draft.Date, Time: draft.Time, Note: draft.Note, Tags: draft.Tags}
			ids = append(ids, e.ID)
			data := integrationEntryData(e, in.DataVersion)
			commands = append(commands, Command{ID: derivedID(in.RequestID, index+100), Entity: "entry", Data: data})
		}
		out, err := a.applyVersion(ctx, i.user, i.book, commands, true, in.DataVersion)
		return nil, map[string]any{"results": out.Results, "entryIds": ids, "revision": out.Revision}, err
	})
	handler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return endpoint(func(w http.ResponseWriter, r *http.Request) error {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(token) != 43 {
			return apiError{401, "Нужен Bearer-токен интеграции"}
		}
		var i integrationContext
		err := a.db.QueryRow(r.Context(), `SELECT t.user_id,t.book_id,t.can_write FROM integrations t JOIN members m ON m.book_id=t.book_id AND m.user_id=t.user_id WHERE t.token_hash=$1 AND t.expires_at>now()`, hash(token)).Scan(&i.user, &i.book, &i.write)
		if err != nil {
			return apiError{401, "Токен недействителен или доступ отозван"}
		}
		if err = a.limit(r, "mcp:"+hash(token), 120, time.Minute); err != nil {
			return err
		}
		i.request = r.Context()
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), integrationKey{}, i)))
		return nil
	})
}
func integrationEntryData(e Entry, version int) []byte {
	data := jsonBytes(e)
	if version < 4 && e.Currency == "" {
		// Legacy retries must retain the original command payload hash.
		data = []byte(strings.Replace(string(data), `,"currency":""`, "", 1))
	}
	return data
}

func derivedID(seed string, index int) string {
	h := hash(seed + ":" + string(rune(index)))
	b := []byte(h[:32])
	b[12] = '4'
	b[16] = '8'
	return string(b[:8]) + "-" + string(b[8:12]) + "-" + string(b[12:16]) + "-" + string(b[16:20]) + "-" + string(b[20:32])
}
func (a *App) qr(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.user(r); err != nil {
		return err
	}
	var in struct {
		Key string `json:"key"`
	}
	if err := body(r, &in); err != nil {
		return err
	}
	if len(in.Key) != 43 {
		return bad("Неверный ключ")
	}
	png, err := qrcode.Encode("finance-key:v1:"+in.Key, qrcode.Medium, 256)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "image/png")
	_, err = w.Write(png)
	return err
}
