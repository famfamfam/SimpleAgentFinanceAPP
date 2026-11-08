package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func chatInput(text string) AssistantInput {
	return AssistantInput{ID: newID(), TaskID: newID(), Mode: "auto", ContextMode: "explicit", SentAt: time.Now().UTC(), Text: text, Date: "2026-11-02", Time: "12:34", AccountID: initialState().Accounts[0].ID}
}
func chatFixture(t *testing.T, provider http.HandlerFunc) (*App, string, *http.Client, string, string) {
	t.Helper()
	a := integrationApp(t)
	a.openrouter = "mock"
	p := httptest.NewServer(provider)
	t.Cleanup(p.Close)
	t.Setenv("OPENROUTER_URL", p.URL)
	s := httptest.NewServer(a.routes())
	t.Cleanup(s.Close)
	client, user, _ := registerClient(t, s.URL, "Chat owner")
	book := newID()
	call(t, client, "POST", s.URL+"/api/books", map[string]string{"id": book, "name": "Chat"}, 200)
	return a, s.URL + "/api/books/" + book, client, user, book
}
func chatAnswer(w http.ResponseWriter, text string) {
	respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": text}}}, "usage": map[string]any{"cost": 0.0001}})
}
func chatTool(w http.ResponseWriter, name string, args any) {
	respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"tool_calls": []any{map[string]any{"id": "tool", "type": "function", "function": map[string]string{"name": name, "arguments": string(jsonBytes(args))}}}}}}, "usage": map[string]any{"cost": 0.0001}})
}
func readChat(t *testing.T, client *http.Client, address string) chatPage {
	t.Helper()
	out := call(t, client, "GET", address, nil, 200)
	var page chatPage
	if err := json.Unmarshal(jsonBytes(out), &page); err != nil {
		t.Fatal(err)
	}
	return page
}
func TestChatPrivateQuotesPaginationAndClear(t *testing.T) {
	var payload map[string]any
	a, address, client, user, book := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&payload)
		chatAnswer(w, "Ответ")
	})
	first := chatInput("Мой секретный текст")
	out := call(t, client, "POST", address+"/assistant", first, 200)
	if stringField(out, "messageId") == "" || stringField(out, "completedAt") == "" {
		t.Fatal("no reply identity or time")
	}
	page := readChat(t, client, address+"/chat")
	if len(page.Messages) != 2 || page.Messages[0].Role != "assistant" || page.Messages[1].Text != first.Text {
		t.Fatal(page)
	}
	other, _, _ := registerClient(t, strings.Split(address, "/api/")[0], "Other")
	invite := call(t, client, "POST", address+"/invite", nil, 200)
	call(t, other, "POST", strings.Split(address, "/api/")[0]+"/api/join", map[string]string{"code": stringField(invite, "code")}, 200)
	if p := readChat(t, other, address+"/chat"); len(p.Messages) != 0 {
		t.Fatal("private history leaked")
	}
	second := chatInput("Сравни с цитатой")
	second.QuoteIDs = []string{first.ID, stringField(out, "messageId")}
	call(t, client, "POST", address+"/assistant", second, 200)
	if !strings.Contains(string(jsonBytes(payload)), first.Text) {
		t.Fatal("quote omitted")
	}
	third := chatInput("Независимый вопрос")
	call(t, client, "POST", address+"/assistant", third, 200)
	if strings.Contains(string(jsonBytes(payload)), first.Text) {
		t.Fatal("unrelated history sent")
	}
	// Add old display messages without paying for model calls.
	messages := []ChatMessage{}
	for i := 0; i < 50; i++ {
		messages = append(messages, ChatMessage{ID: newID(), TaskID: newID(), Role: "user", Text: fmt.Sprint(i), CreatedAt: time.Now().Add(-time.Duration(i+1) * time.Hour)})
	}
	call(t, client, "POST", address+"/chat/import", map[string]any{"epoch": 0, "messages": messages}, 200)
	page = readChat(t, client, address+"/chat")
	if len(page.Messages) != 50 || !page.More {
		t.Fatal("not paginated", len(page.Messages))
	}
	next := readChat(t, client, address+"/chat?before="+url.QueryEscape(page.Before))
	if len(next.Messages) != 6 || next.More {
		t.Fatal("missing older page", len(next.Messages))
	}
	call(t, client, "POST", address+"/chat/delete", map[string]any{"ids": []string{first.ID}}, 200)
	badQuote := chatInput("Сравни")
	badQuote.QuoteIDs = []string{first.ID}
	call(t, client, "POST", address+"/assistant", badQuote, 400)
	call(t, client, "POST", address+"/assistant", first, 410)
	call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true}, 200)
	if p := readChat(t, client, address+"/chat"); p.Epoch != 1 || len(p.Messages) != 0 {
		t.Fatal("clear failed", p)
	}
	call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true, "epoch": 0}, 200)
	if p := readChat(t, client, address+"/chat"); p.Epoch != 1 {
		t.Fatal("retry cleared twice")
	}
	call(t, client, "POST", address+"/assistant", third, 410)
	call(t, client, "POST", address+"/chat/import", map[string]any{"epoch": 0, "messages": messages}, 410)
	var count int
	if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND deleted`, user, book).Scan(&count); err != nil || count != 56 {
		t.Fatal("tombstones lost", count, err)
	}
}

func TestChatDeletedBeforeStartAndExpiredCache(t *testing.T) {
	calls := 0
	a, address, client, user, book := chatFixture(t, func(w http.ResponseWriter, r *http.Request) { calls++; chatAnswer(w, "Ответ") })
	in := chatInput("Уже удалено")
	call(t, client, "POST", address+"/chat/delete", map[string]any{"ids": []string{in.ID}}, 200)
	call(t, client, "POST", address+"/assistant", in, 410)
	if calls != 0 {
		t.Fatal("deleted request reached provider")
	}
	in = chatInput("Сохранённый ответ")
	out := call(t, client, "POST", address+"/assistant", in, 200)
	if _, err := a.db.Exec(context.Background(), `DELETE FROM assistant_requests WHERE user_id=$1 AND book_id=$2`, user, book); err != nil {
		t.Fatal(err)
	}
	retry := call(t, client, "POST", address+"/assistant", in, 200)
	if calls != 1 || stringField(out, "completedAt") != stringField(retry, "completedAt") {
		t.Fatal("archive replay called model again")
	}
	in.Text = "Подменённый запрос"
	call(t, client, "POST", address+"/assistant", in, 400)
	tooBig, voice := ChatMessage{ID: newID(), TaskID: newID(), Role: "user", Text: strings.Repeat("я", 4097), CreatedAt: time.Now()}, ChatMessage{ID: newID(), TaskID: newID(), Role: "user", Audio: true, CreatedAt: time.Now()}
	call(t, client, "POST", address+"/chat/import", map[string]any{"messages": []ChatMessage{tooBig, voice}}, 200)
	for _, id := range []string{tooBig.ID, voice.ID} {
		q := chatInput("Цитата")
		q.QuoteIDs = []string{id}
		call(t, client, "POST", address+"/assistant", q, 400)
	}
}

func TestChatApplyIsAtomicAndReplaySurvivesDeletion(t *testing.T) {
	entry := Entry{Kind: "expense", Amount: "200.00", Date: "2026-11-02", AccountID: initialState().Accounts[0].ID, CategoryID: initialState().Categories[0].ID}
	a, address, client, _, _ := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		chatTool(w, "prepare_transactions", map[string]any{"entries": []Entry{entry}})
	})
	in := chatInput("Свинина 200")
	out := call(t, client, "POST", address+"/assistant", in, 200)
	var entries []Entry
	json.Unmarshal(out["entries"], &entries)
	cmd := Command{ID: newID(), Entity: "entry", Data: jsonBytes(entries[0])}
	path := address + "/assistant-tasks/" + in.TaskID + "/apply"
	call(t, client, "POST", path, map[string]any{"requestId": in.ID, "commands": []Command{cmd}}, 200)
	entries[0].Amount = "999.00"
	cmd.ID = newID()
	cmd.Data = jsonBytes(entries[0])
	call(t, client, "POST", path, map[string]any{"requestId": in.ID, "commands": []Command{cmd}}, 200)
	call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true}, 200)
	state := call(t, client, "GET", address+"/sync", nil, 200)
	var snapshot State
	json.Unmarshal(state["state"], &snapshot)
	if len(snapshot.Entries) != 1 || snapshot.Entries[0].Amount != "200.00" {
		t.Fatal("replay changed finance", snapshot.Entries)
	}
	call(t, client, "POST", path, map[string]any{"requestId": in.ID, "commands": []Command{cmd}}, 200)
	if err := a.cleanupExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestChatCancelDuringProviderDoesNotResurrect(t *testing.T) {
	started, finish := make(chan struct{}), make(chan struct{})
	_, address, client, _, _ := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-finish
		chatAnswer(w, "Поздний ответ")
	})
	in := chatInput("Долгий запрос")
	done := make(chan int, 1)
	go func() {
		r, err := client.Post(address+"/assistant", "application/json", bytes.NewReader(jsonBytes(in)))
		if err != nil {
			done <- 0
			return
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		done <- r.StatusCode
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider never started")
	}
	call(t, client, "POST", address+"/chat/delete", map[string]any{"ids": []string{in.ID}}, 200)
	close(finish)
	if status := <-done; status != 410 {
		t.Fatal("late response accepted", status)
	}
	if p := readChat(t, client, address+"/chat"); len(p.Messages) != 0 {
		t.Fatal("message resurrected", p)
	}
	call(t, client, "POST", address+"/assistant", in, 410)
}

func TestChatCategoryAndExplicitPendingContext(t *testing.T) {
	step := 0
	var payload map[string]any
	_, address, client, _, _ := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&payload)
		if step == 0 {
			chatTool(w, "ask_clarification", map[string]any{"question": map[string]any{"text": "Сколько?", "categoryIds": []string{}}})
			return
		}
		chatTool(w, "prepare_category", map[string]any{"name": "Музыка", "kind": "expense", "entries": []Entry{{Kind: "expense", Amount: "250.00", Date: "2026-11-02", AccountID: initialState().Accounts[0].ID}}})
	})
	in := chatInput("Купил ноты, нужна категория Музыка")
	call(t, client, "POST", address+"/assistant", in, 200)
	step = 1
	second := chatInput("250 рублей")
	second.TaskID = in.TaskID
	second.PendingTaskID = in.TaskID
	out := call(t, client, "POST", address+"/assistant", second, 200)
	if !strings.Contains(string(jsonBytes(payload)), in.Text) {
		t.Fatal("unfinished original missing")
	}
	var cat AssistantCategory
	var entries []Entry
	json.Unmarshal(out["category"], &cat)
	json.Unmarshal(out["entries"], &entries)
	if cat.ID != derivedID(in.TaskID, 99) || entries[0].CategoryID != cat.ID || stringField(out, "action") != "category" {
		t.Fatal("wrong category proposal", string(jsonBytes(out)))
	}
	c := Category{ID: cat.ID, Name: cat.Name, Kind: cat.Kind, Color: "#58b8a2", Icon: "music"}
	commands := []Command{{ID: newID(), Entity: "category", Data: jsonBytes(c)}, {ID: newID(), Entity: "entry", Data: jsonBytes(entries[0])}}
	path := address + "/assistant-tasks/" + in.TaskID + "/apply"
	broken := append([]Command{}, commands...)
	badEntry := entries[0]
	badEntry.Amount = "0"
	broken[1].Data = jsonBytes(badEntry)
	call(t, client, "POST", path, map[string]any{"requestId": second.ID, "commands": broken}, 400)
	state := call(t, client, "GET", address+"/sync", nil, 200)
	var s State
	json.Unmarshal(state["state"], &s)
	if len(s.Categories) != len(initialState().Categories) {
		t.Fatal("partial category applied")
	}
	call(t, client, "POST", path, map[string]any{"requestId": second.ID, "commands": commands}, 200)
	third := chatInput("Добавь категорию Музыка")
	out = call(t, client, "POST", address+"/assistant", third, 200)
	json.Unmarshal(out["category"], &cat)
	if cat.ExistingID == "" {
		t.Fatal("existing category not recognized")
	}
}

func TestChatRetentionAndMediaQuota(t *testing.T) {
	a, address, client, user, book := chatFixture(t, func(w http.ResponseWriter, r *http.Request) { chatAnswer(w, "Ответ") })
	ctx := context.Background()
	in := chatInput("Голос")
	call(t, client, "POST", address+"/assistant", in, 200)
	// Compact repeated bytea values exercise the real 100 MiB cap without bloating the test database.
	for i := 0; i < 26; i++ {
		id := newID()
		created := time.Now().Add(-time.Duration(i+1) * time.Hour)
		m := ChatMessage{ID: id, TaskID: in.TaskID, Role: "user", Audio: true, CreatedAt: created, Media: &ChatMedia{MIME: "audio/webm", Size: 4 << 20, Available: true}}
		tx, err := a.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = chatHead(ctx, tx, user, book); err == nil {
			err = putChat(ctx, tx, user, book, m)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO chat_media(user_id,book_id,message_id,mime,data,created_at) VALUES($1,$2,$3,'audio/webm',decode(repeat('ab',4194304),'hex'),$4)`, user, book, id, created)
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			tx.Rollback(ctx)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = trimChatMedia(ctx, tx, user); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	var size int64
	if err = a.db.QueryRow(ctx, `SELECT count(*),sum(octet_length(data)) FROM chat_media WHERE user_id=$1`, user).Scan(&count, &size); err != nil || count != 25 || size != chatAudioLimit {
		t.Fatal("quota", count, size, err)
	}
	if _, err = a.db.Exec(ctx, `UPDATE chat_media SET created_at=now()-interval '31 days' WHERE user_id=$1`, user); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(ctx, `UPDATE chat_messages SET created_at=now()-interval '91 days' WHERE user_id=$1`, user); err != nil {
		t.Fatal(err)
	}
	if err = a.cleanupExpired(ctx); err != nil {
		t.Fatal(err)
	}
	if p := readChat(t, client, address+"/chat?after=0"); len(p.Messages) != 28 || !p.Messages[0].Deleted {
		t.Fatal("retention tombstones", len(p.Messages))
	}
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM chat_media WHERE user_id=$1`, user).Scan(&count); err != nil || count != 0 {
		t.Fatal("expired audio retained", count, err)
	}
}

func TestChatAudioTranscriptUploadAndExpiry(t *testing.T) {
	a, address, client, user, book := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		chatTool(w, "ask_clarification", map[string]any{"question": map[string]any{"text": "Какая сумма?", "categoryIds": []string{}}, "transcript": "Купил продукты"})
	})
	raw := make([]byte, 44+32000)
	copy(raw, "RIFF")
	copy(raw[8:], "WAVEfmt ")
	copy(raw[36:], "data")
	for offset, value := range map[int]uint32{4: uint32(len(raw) - 8), 16: 16, 24: 16000, 28: 32000, 40: 32000} {
		binary.LittleEndian.PutUint32(raw[offset:], value)
	}
	for offset, value := range map[int]uint16{20: 1, 22: 1, 32: 2, 34: 16} {
		binary.LittleEndian.PutUint16(raw[offset:], value)
	}
	in := chatInput("")
	in.Audio = base64.StdEncoding.EncodeToString(raw)
	call(t, client, "POST", address+"/assistant", in, 200)
	page := readChat(t, client, address+"/chat")
	if page.Messages[1].Transcript != "Купил продукты" || !page.Messages[1].Audio || page.Messages[0].Result.Transcript != "" {
		t.Fatal("transcript not associated with user audio", page)
	}
	mediaURL := address + "/chat/media/" + in.ID
	upload := func(data []byte, status int) {
		req, _ := http.NewRequest("PUT", mediaURL, bytes.NewReader(data))
		req.Header.Set("Content-Type", "audio/webm;codecs=opus")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != status {
			t.Fatal("upload", res.StatusCode, string(body))
		}
	}
	original := []byte{0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4}
	upload(original, 200)
	upload(original, 200)
	upload([]byte("changed"), 400)
	res, err := client.Get(mediaURL)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(data, original) || res.Header.Get("Content-Type") != "audio/webm" {
		t.Fatal("media read", res.StatusCode)
	}
	if _, err = a.db.Exec(context.Background(), `UPDATE chat_media SET created_at=now()-interval '31 days' WHERE user_id=$1 AND book_id=$2`, user, book); err != nil {
		t.Fatal(err)
	}
	if err = a.cleanupExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	page = readChat(t, client, address+"/chat")
	if len(page.Messages) != 2 || page.Messages[1].Media.Available || page.Messages[1].Transcript == "" {
		t.Fatal("audio expiry removed transcript", page)
	}
	res, err = client.Get(mediaURL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatal("expired audio readable")
	}
	call(t, client, "POST", address+"/chat/delete", map[string]any{"ids": []string{in.ID}}, 200)
	upload(original, 410)
}

func TestChatClearUUIDIsIdempotentAndIdentityIsBound(t *testing.T) {
	_, address, client, _, _ := chatFixture(t, func(w http.ResponseWriter, r *http.Request) { chatAnswer(w, "Ответ") })
	in := chatInput("Первое")
	call(t, client, "POST", address+"/assistant", in, 200)
	id := newID()
	first := call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true, "id": id}, 200)
	if string(first["epoch"]) != "1" {
		t.Fatal("wrong epoch", first)
	}
	in = chatInput("После очистки")
	in.ChatEpoch = 1
	call(t, client, "POST", address+"/assistant", in, 200)
	call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true, "id": id}, 200)
	if page := readChat(t, client, address+"/chat"); len(page.Messages) != 2 || page.Epoch != 1 {
		t.Fatal("clear retry removed new messages", page)
	}
	call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true, "id": newID()}, 200)
	if page := readChat(t, client, address+"/chat"); len(page.Messages) != 0 || page.Epoch != 2 {
		t.Fatal("second clear did not advance", page)
	}
	req, _ := http.NewRequest("GET", address+"/chat", nil)
	req.Header.Set("X-Finance-User", newID())
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatal("changed identity accepted", res.StatusCode)
	}
}

func TestChatExpiryKeepsPreparedFinancialGroup(t *testing.T) {
	entry := Entry{Kind: "expense", Amount: "200.00", Date: "2026-11-02", AccountID: initialState().Accounts[0].ID, CategoryID: initialState().Categories[0].ID, Note: "Финансовый комментарий"}
	a, address, client, user, book := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		chatTool(w, "prepare_transactions", map[string]any{"entries": []Entry{entry}})
	})
	in := chatInput("Личный исходный запрос")
	out := call(t, client, "POST", address+"/assistant", in, 200)
	var entries []Entry
	json.Unmarshal(out["entries"], &entries)
	ctx := context.Background()
	for _, table := range []string{"chat_messages", "assistant_requests"} {
		if _, err := a.db.Exec(ctx, `UPDATE `+table+` SET created_at=now()-interval '91 days' WHERE user_id=$1 AND book_id=$2`, user, book); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.cleanupExpired(ctx); err != nil {
		t.Fatal(err)
	}
	page := readChat(t, client, address+"/chat?after=0")
	if len(page.Messages) != 2 || !page.Messages[0].Expired || page.Messages[0].Status != "open" {
		t.Fatal("expiry cancelled finance", page)
	}
	var taskContext string
	if err := a.db.QueryRow(ctx, `SELECT context::text FROM assistant_tasks WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, in.TaskID).Scan(&taskContext); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(taskContext, in.Text) || strings.Contains(taskContext, entry.Note) {
		t.Fatal("expired text retained in context", taskContext)
	}
	command := Command{ID: newID(), Entity: "entry", Data: jsonBytes(entries[0])}
	call(t, client, "POST", address+"/assistant-tasks/"+in.TaskID+"/apply", map[string]any{"requestId": in.ID, "commands": []Command{command}}, 200)
	state := call(t, client, "GET", address+"/sync", nil, 200)
	var s State
	json.Unmarshal(state["state"], &s)
	if len(s.Entries) != 1 || s.Entries[0].Amount != "200.00" {
		t.Fatal("offline finance lost", s.Entries)
	}
	second := chatInput("Ещё одна подготовленная операция")
	out = call(t, client, "POST", address+"/assistant", second, 200)
	json.Unmarshal(out["entries"], &entries)
	if _, err := a.db.Exec(ctx, `UPDATE chat_messages SET created_at=now()-interval '91 days' WHERE user_id=$1 AND book_id=$2`, user, book); err != nil {
		t.Fatal(err)
	}
	if err := a.cleanupExpired(ctx); err != nil {
		t.Fatal(err)
	}
	call(t, client, "POST", address+"/chat/delete", map[string]any{"clear": true, "id": newID()}, 200)
	command = Command{ID: newID(), Entity: "entry", Data: jsonBytes(entries[0])}
	call(t, client, "POST", address+"/assistant-tasks/"+second.TaskID+"/apply", map[string]any{"requestId": second.ID, "commands": []Command{command}}, 410)
}

func TestChatCategoryReceiptTotal(t *testing.T) {
	for _, total := range []string{"250.0", "invalid"} {
		t.Run(total, func(t *testing.T) {
			_, address, client, _, _ := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
				chatTool(w, "prepare_category", map[string]any{"name": "Музыка", "kind": "expense", "receiptTotal": total, "entries": []Entry{{Kind: "expense", Amount: "250.00", Date: "2026-11-02", AccountID: initialState().Accounts[0].ID}}})
			})
			in := chatInput("Чек, создай категорию Музыка")
			in.Image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
			status := 200
			if total == "invalid" {
				status = 502
			}
			out := call(t, client, "POST", address+"/assistant", in, status)
			if status == 200 && (stringField(out, "total") != "250.00" || stringField(out, "action") != "category" || string(out["receipt"]) != "true") {
				t.Fatal("receipt lost total or review requirement", string(jsonBytes(out)))
			}
		})
	}
}

func TestChatToolRoundTripPreservesProviderSignatures(t *testing.T) {
	var calls atomic.Int32
	details := json.RawMessage(`[{"type":"reasoning.encrypted","data":"opaque-state","format":"google-gemini-v1","index":0}]`)
	extra := json.RawMessage(`{"google":{"thought_signature":"opaque-signature"}}`)
	a, address, client, _, _ := chatFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "", "reasoning_details": details, "tool_calls": []any{map[string]any{"id": "summary", "type": "function", "extra_content": extra, "function": map[string]string{"name": "get_summary", "arguments": "{}"}}}}}}, "usage": map[string]any{"cost": 0.0001}})
			return
		}
		var payload struct {
			Messages []map[string]json.RawMessage `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		previous := payload.Messages[len(payload.Messages)-2]
		var tools []map[string]json.RawMessage
		json.Unmarshal(previous["tool_calls"], &tools)
		if string(previous["reasoning_details"]) != string(details) || len(tools) != 1 || string(tools[0]["extra_content"]) != string(extra) {
			t.Error("tool continuation lost provider signatures")
		}
		chatAnswer(w, "Расходов нет")
	})
	a.model = "google/gemini-3.1-flash-lite"
	out := call(t, client, "POST", address+"/assistant", chatInput("Сколько потратил?"), 200)
	if calls.Load() != 2 || strings.Contains(string(jsonBytes(out)), "opaque-") {
		t.Fatal("wrong tool result or exposed provider state")
	}
}
