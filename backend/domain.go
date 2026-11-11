package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type Account struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Opening  string `json:"opening"`
	Currency string `json:"currency"`
	Version  int64  `json:"version"`
	Deleted  bool   `json:"deleted"`
}
type Category struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Color   string `json:"color"`
	Icon    string `json:"icon"`
	Version int64  `json:"version"`
	Deleted bool   `json:"deleted"`
}
type Entry struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Amount      string `json:"amount"`
	Currency    string `json:"currency"`
	ToAmount    string `json:"toAmount,omitempty"`
	ToCurrency  string `json:"toCurrency,omitempty"`
	AccountID   string `json:"accountId"`
	ToAccountID string `json:"toAccountId,omitempty"`
	CategoryID  string `json:"categoryId,omitempty"`
	Date        string `json:"date"`
	Time        string `json:"time,omitempty"`
	Note        string `json:"note"`
	Tags        string `json:"tags"`
	Original    bool   `json:"original,omitempty"`
	Author      string `json:"author"`
	Editor      string `json:"editor"`
	Version     int64  `json:"version"`
	Deleted     bool   `json:"deleted"`
}
type State struct {
	Accounts   []Account  `json:"accounts"`
	Categories []Category `json:"categories"`
	Entries    []Entry    `json:"entries"`
}
type Command struct {
	ID     string          `json:"id"`
	Entity string          `json:"entity"`
	Base   int64           `json:"base"`
	Data   json.RawMessage `json:"data"`
}
type CommandResult struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Version int64  `json:"version,omitempty"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var amountPattern = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$`)

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func newToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func hash(s string) string { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
func money(s string) (int64, error) {
	if !amountPattern.MatchString(s) {
		return 0, errors.New("Сумма: до 999 999 999,99 и не больше двух знаков после точки")
	}
	negative := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	parts := strings.Split(s, ".")
	rub, _ := strconv.ParseInt(parts[0], 10, 64)
	kop := int64(0)
	if len(parts) == 2 {
		kop, _ = strconv.ParseInt((parts[1] + "0")[:2], 10, 64)
	}
	value := rub*100 + kop
	if negative {
		value = -value
	}
	return value, nil
}
func moneyString(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	return fmt.Sprintf("%s%d.%02d", sign, n/100, n%100)
}

// NormalizeCurrency interprets a missing legacy currency as RUB.
func NormalizeCurrency(code string) string {
	if code == "" {
		return "RUB"
	}
	return code
}

// ValidCurrency accepts the supported codes and the legacy empty value.
func ValidCurrency(code string) bool {
	switch NormalizeCurrency(code) {
	case "RUB", "USD", "EUR", "CNY", "GBP", "CHF", "GEL", "TRY", "AED", "KZT", "BYN", "UAH":
		return true
	}
	return false
}

func validName(s string) bool { return strings.TrimSpace(s) != "" && len([]rune(s)) <= 80 }
func initialState() State     { return initialStateForLanguage("ru") }
func initialStateForLanguage(language string) State {
	s := State{Accounts: []Account{{ID: "00000000-0000-4000-8000-000000000001", Name: "Основной", Opening: "0.00", Currency: "RUB", Version: 1}}, Categories: []Category{}, Entries: []Entry{}}
	names := []string{"Продукты", "Кафе", "Транспорт", "Дом", "Здоровье", "Покупки", "Досуг", "Другое", "Зарплата", "Другие доходы", "Образование", "ЖКХ", "Жилье", "Маркетплейсы", "Одежда", "Животина"}
	if language == "en" {
		s.Accounts[0].Name = "Main"
		names = []string{"Groceries", "Cafes", "Transport", "Home", "Health", "Shopping", "Leisure", "Other", "Salary", "Other income", "Education", "Utilities", "Housing", "Marketplaces", "Clothing", "Pets"}
	}
	icons := []string{"basket", "cup", "bus", "home", "heart", "bag", "wallet", "dots", "wallet", "plus", "book", "tent", "tag", "parcel", "shirt", "paw"}
	colors := []string{"#7dad43", "#b08bc0", "#6598c5", "#ff8b36", "#ff3e36", "#ffbd1c", "#58b8a2", "#8e9782", "#7dad43", "#58b8a2", "#6598c5", "#7dad43", "#ff4550", "#ffbd1c", "#ffbd1c", "#ffbd1c"}
	for i, n := range names {
		kind := "expense"
		if i == 8 || i == 9 {
			kind = "income"
		}
		s.Categories = append(s.Categories, Category{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i+2), Name: n, Kind: kind, Color: colors[i], Icon: icons[i], Version: 1})
	}
	return s
}
func decodeItem(data json.RawMessage, v any) error {
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return errors.New("Неверные поля операции")
	}
	return nil
}
func (s *State) apply(c Command, user string, revision int64) (CommandResult, error) {
	result := CommandResult{ID: c.ID, Status: "ok", Version: revision}
	if !uuidPattern.MatchString(c.ID) || c.Base < 0 {
		return result, errors.New("Неверный идентификатор команды")
	}
	conflict := func(version int64) bool { return c.Base != version }
	switch c.Entity {
	case "account":
		var x Account
		if err := decodeItem(c.Data, &x); err != nil {
			return result, err
		}
		if !uuidPattern.MatchString(x.ID) || !validName(x.Name) {
			return result, errors.New("Укажите название счета")
		}
		if _, err := money(x.Opening); err != nil {
			return result, err
		}
		i := slices.IndexFunc(s.Accounts, func(v Account) bool { return v.ID == x.ID })
		v := int64(0)
		if i >= 0 {
			v = s.Accounts[i].Version
		}
		if conflict(v) {
			result.Status = "conflict"
			return result, nil
		}
		if !ValidCurrency(x.Currency) {
			return result, errors.New("Неизвестная валюта")
		}
		x.Currency = NormalizeCurrency(x.Currency)
		if i >= 0 && x.Currency != NormalizeCurrency(s.Accounts[i].Currency) {
			return result, errors.New("Валюту существующего счета изменить нельзя")
		}
		for _, a := range s.Accounts {
			if a.ID != x.ID && !a.Deleted && !x.Deleted && strings.EqualFold(strings.TrimSpace(a.Name), strings.TrimSpace(x.Name)) {
				return result, errors.New("Счет с таким названием уже существует")
			}
		}
		x.Name = strings.TrimSpace(x.Name)
		x.Version = revision
		if i < 0 {
			s.Accounts = append(s.Accounts, x)
		} else {
			s.Accounts[i] = x
		}
	case "category":
		var x Category
		if err := decodeItem(c.Data, &x); err != nil {
			return result, err
		}
		if !uuidPattern.MatchString(x.ID) || !validName(x.Name) || (x.Kind != "expense" && x.Kind != "income") || !regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(x.Color) || len(x.Icon) > 30 {
			return result, errors.New("Проверьте категорию и цвет")
		}
		i := slices.IndexFunc(s.Categories, func(v Category) bool { return v.ID == x.ID })
		v := int64(0)
		if i >= 0 {
			v = s.Categories[i].Version
			if s.Categories[i].Kind != x.Kind {
				return result, errors.New("Тип существующей категории изменить нельзя")
			}
		}
		if conflict(v) {
			result.Status = "conflict"
			return result, nil
		}
		for _, a := range s.Categories {
			if a.ID != x.ID && !a.Deleted && !x.Deleted && a.Kind == x.Kind && strings.EqualFold(strings.TrimSpace(a.Name), strings.TrimSpace(x.Name)) {
				return result, errors.New("Категория с таким названием уже существует")
			}
		}
		x.Name = strings.TrimSpace(x.Name)
		x.Version = revision
		if i < 0 {
			s.Categories = append(s.Categories, x)
		} else {
			s.Categories[i] = x
		}
	case "entry":
		var x Entry
		if err := decodeItem(c.Data, &x); err != nil {
			return result, err
		}
		if !uuidPattern.MatchString(x.ID) {
			return result, errors.New("Неверный идентификатор записи")
		}
		i := slices.IndexFunc(s.Entries, func(v Entry) bool { return v.ID == x.ID })
		v := int64(0)
		if i >= 0 {
			v = s.Entries[i].Version
		}
		if conflict(v) {
			result.Status = "conflict"
			return result, nil
		}
		if i >= 0 && x.Deleted {
			x = s.Entries[i]
			x.Deleted = true
		} else {
			if err := s.validateEntry(x); err != nil {
				return result, err
			}
			x.Currency = NormalizeCurrency(x.Currency)
			if i >= 0 && x.Currency != NormalizeCurrency(s.Entries[i].Currency) {
				return result, errors.New("Валюту существующей операции изменить нельзя")
			}
			if x.Kind == "transfer" {
				if x.ToCurrency == "" {
					x.ToCurrency = x.Currency
				}
				if x.ToAmount == "" {
					x.ToAmount = x.Amount
				}
			}
		}
		x.Author = user
		if i >= 0 {
			x.Author = s.Entries[i].Author
		}
		x.Editor = user
		x.Version = revision
		if i < 0 {
			// A create deleted before its first upload still needs a tombstone against stale retries.
			s.Entries = append(s.Entries, x)
		} else {
			s.Entries[i] = x
		}
	default:
		return result, errors.New("Неизвестный тип изменения")
	}
	return result, nil
}
func (s State) validateEntry(x Entry) error {
	n, err := money(x.Amount)
	if err != nil || n <= 0 {
		return errors.New("Сумма должна быть положительной, не больше двух знаков после точки")
	}
	if x.Kind != "expense" && x.Kind != "income" && x.Kind != "transfer" {
		return errors.New("Неверный тип операции")
	}
	if _, err := time.Parse("2006-01-02", x.Date); err != nil {
		return errors.New("Укажите действительную дату")
	}
	if x.Time != "" {
		if parsed, err := time.Parse("15:04", x.Time); err != nil || parsed.Format("15:04") != x.Time {
			return errors.New("Неверное время")
		}
	}
	if len([]rune(x.Note)) > 4096 || len([]rune(x.Tags)) > 512 {
		return errors.New("Слишком длинный комментарий или теги")
	}
	account := func(id string) (Account, bool) {
		i := slices.IndexFunc(s.Accounts, func(a Account) bool { return a.ID == id && !a.Deleted })
		if i < 0 {
			return Account{}, false
		}
		return s.Accounts[i], true
	}
	source, ok := account(x.AccountID)
	if !ok {
		return errors.New("Счет недоступен")
	}
	if !ValidCurrency(x.Currency) || !ValidCurrency(source.Currency) || NormalizeCurrency(x.Currency) != NormalizeCurrency(source.Currency) {
		return errors.New("Валюта операции не соответствует счету")
	}
	if x.Kind == "transfer" {
		destination, ok := account(x.ToAccountID)
		if x.ToAccountID == x.AccountID || !ok {
			return errors.New("Выберите другой счет перевода")
		}
		if x.CategoryID != "" {
			return errors.New("У перевода нет категории")
		}
		if !ValidCurrency(destination.Currency) || !ValidCurrency(x.ToCurrency) {
			return errors.New("Неизвестная валюта перевода")
		}
		sourceCurrency := NormalizeCurrency(x.Currency)
		destinationCurrency := NormalizeCurrency(destination.Currency)
		if x.ToCurrency == "" {
			if sourceCurrency != destinationCurrency {
				return errors.New("Укажите валюту счета получателя")
			}
		} else if x.ToCurrency != destinationCurrency {
			return errors.New("Валюта зачисления не соответствует счету")
		}
		if x.ToAmount == "" {
			if sourceCurrency != destinationCurrency {
				return errors.New("Укажите сумму зачисления")
			}
		} else {
			to, err := money(x.ToAmount)
			if err != nil || to <= 0 || (sourceCurrency == destinationCurrency && to != n) {
				return errors.New("Неверная сумма зачисления")
			}
		}
	} else {
		if x.ToAccountID != "" || x.ToCurrency != "" || x.ToAmount != "" {
			return errors.New("Второй счет допустим только у перевода")
		}
		if !slices.ContainsFunc(s.Categories, func(c Category) bool { return c.ID == x.CategoryID && c.Kind == x.Kind && !c.Deleted }) {
			return errors.New("Выберите категорию нужного типа")
		}
	}
	return nil
}
