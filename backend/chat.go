package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const chatAudioLimit = 100 << 20

type ChatMedia struct {
	MIME      string `json:"mime"`
	Size      int    `json:"size"`
	Available bool   `json:"available"`
}
type ChatMessage struct {
	ID          string           `json:"id"`
	TaskID      string           `json:"taskId"`
	Role        string           `json:"role"`
	Text        string           `json:"text"`
	Transcript  string           `json:"transcript,omitempty"`
	CreatedAt   time.Time        `json:"createdAt"`
	Seq         int64            `json:"seq"`
	Deleted     bool             `json:"deleted"`
	Expired     bool             `json:"expired,omitempty"`
	Audio       bool             `json:"audio,omitempty"`
	Media       *ChatMedia       `json:"media,omitempty"`
	ReplyTo     string           `json:"replyTo,omitempty"`
	Result      *AssistantOutput `json:"result,omitempty"`
	Status      string           `json:"status,omitempty"`
	AppliedIDs  []string         `json:"appliedIDs,omitempty"`
	RequestHash string           `json:"requestHash,omitempty"`
}
type chatContext struct {
	Original        string             `json:"original"`
	Entries         []Entry            `json:"entries,omitempty"`
	Question        *AssistantQuestion `json:"question,omitempty"`
	Category        *AssistantCategory `json:"category,omitempty"`
	AppliedVersions map[string]int64   `json:"appliedVersions,omitempty"`
}
type chatPage struct {
	Messages []ChatMessage `json:"messages"`
	Epoch    int64         `json:"epoch"`
	Cursor   int64         `json:"cursor"`
	More     bool          `json:"more"`
	Before   string        `json:"before,omitempty"`
}

// Every writer locks book, then the private head. The cursor therefore follows commit order.
func chatHead(ctx context.Context, tx pgx.Tx, user, book string) (epoch, seq int64, err error) {
	var member bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM members WHERE user_id=$1 AND book_id=$2) FROM books WHERE id=$2 FOR UPDATE`, user, book).Scan(&member)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !member) {
		return 0, 0, forbidden()
	}
	if err != nil {
		return
	}
	_, err = tx.Exec(ctx, `INSERT INTO chat_heads(user_id,book_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, user, book)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT epoch,seq FROM chat_heads WHERE user_id=$1 AND book_id=$2 FOR UPDATE`, user, book).Scan(&epoch, &seq)
	}
	return
}
func putChat(ctx context.Context, tx pgx.Tx, user, book string, m ChatMessage) error {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE chat_heads SET seq=seq+1 WHERE user_id=$1 AND book_id=$2 RETURNING seq`, user, book).Scan(&seq); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO chat_messages(user_id,book_id,id,task_id,role,text,transcript,body,created_at,seq,deleted)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT(user_id,book_id,id) DO UPDATE SET text=EXCLUDED.text,transcript=EXCLUDED.transcript,body=EXCLUDED.body,seq=EXCLUDED.seq,deleted=EXCLUDED.deleted`,
		user, book, m.ID, m.TaskID, m.Role, m.Text, m.Transcript, jsonBytes(m), m.CreatedAt, seq, m.Deleted)
	return err
}
func touchChatTask(ctx context.Context, tx pgx.Tx, user, book, task string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND task_id=$3 ORDER BY id`, user, book, task)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err = tx.Exec(ctx, `WITH n AS (UPDATE chat_heads SET seq=seq+1 WHERE user_id=$1 AND book_id=$2 RETURNING seq)
			UPDATE chat_messages SET seq=n.seq FROM n WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, id); err != nil {
			return err
		}
	}
	return nil
}

func requireChatDataVersion(m ChatMessage, version int) error {
	if m.Result == nil {
		return nil
	}
	return requireAssistantDataVersion(*m.Result, version)
}

func requireLockedBookDataVersion(ctx context.Context, tx pgx.Tx, book string) error {
	if dataVersionFromContext(ctx) >= 4 {
		return nil
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT state FROM books WHERE id=$1`, book).Scan(&raw); err != nil {
		return err
	}
	var state State
	if err := json.Unmarshal(raw, &state); err != nil {
		return err
	}
	return requireDataVersion(state, dataVersionFromContext(ctx))
}

func (a *App) chatHistory(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	book := r.PathValue("book")
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	epoch, seq, err := chatHead(r.Context(), tx, u.ID, book)
	if err != nil {
		return err
	}
	if err = requireLockedBookDataVersion(r.Context(), tx, book); err != nil {
		return err
	}
	page := chatPage{Messages: []ChatMessage{}, Epoch: epoch, Cursor: seq}
	args := []any{u.ID, book}
	filter := "NOT m.deleted AND m.created_at>now()-interval '90 days'"
	order := "m.created_at DESC,m.id DESC"
	changes := r.URL.Query().Has("after")
	if changes {
		after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		if err != nil || after < 0 || after > seq {
			return bad("Неверный курсор переписки")
		}
		args = append(args, after)
		filter, order = "m.seq>$3", "m.seq"
	} else if before := r.URL.Query().Get("before"); before != "" {
		parts := strings.Split(before, "|")
		if len(parts) != 2 || !uuidPattern.MatchString(parts[1]) {
			return bad("Неверная страница переписки")
		}
		date, err := time.Parse(time.RFC3339Nano, parts[0])
		if err != nil {
			return bad("Неверная дата страницы")
		}
		args = append(args, date, parts[1])
		filter += " AND (m.created_at,m.id)<($3,$4)"
	}
	rows, err := tx.Query(r.Context(), `SELECT m.id,m.task_id,m.role,m.text,m.transcript,m.created_at,m.seq,m.deleted,m.body,
		COALESCE(t.status,'cancelled'),COALESCE(t.applied_ids,'[]'::jsonb)
		FROM chat_messages m LEFT JOIN assistant_tasks t ON t.user_id=m.user_id AND t.book_id=m.book_id AND t.id=m.task_id
		WHERE m.user_id=$1 AND m.book_id=$2 AND `+filter+` ORDER BY `+order+` LIMIT 51`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var m ChatMessage
		var raw, ids []byte
		if err = rows.Scan(&m.ID, &m.TaskID, &m.Role, &m.Text, &m.Transcript, &m.CreatedAt, &m.Seq, &m.Deleted, &raw, &m.Status, &ids); err != nil {
			return err
		}
		var body ChatMessage
		if err = json.Unmarshal(raw, &body); err != nil {
			return err
		}
		m.Audio, m.Media, m.Result, m.ReplyTo = body.Audio, body.Media, body.Result, body.ReplyTo
		m.Expired = body.Expired
		if err = requireChatDataVersion(m, dataVersionFromContext(r.Context())); err != nil {
			return err
		}
		if err = json.Unmarshal(ids, &m.AppliedIDs); err != nil {
			return err
		}
		page.Messages = append(page.Messages, m)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	page.More = len(page.Messages) > 50
	if page.More {
		page.Messages = page.Messages[:50]
	}
	if len(page.Messages) > 0 {
		last := page.Messages[len(page.Messages)-1]
		if changes && page.More {
			page.Cursor = last.Seq
		} else if !changes {
			page.Before = last.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + last.ID
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, page)
	return nil
}

// This runs before the provider, without holding a task row during the network call.
func (a *App) startChat(ctx context.Context, user, book string, in AssistantInput) (chatContext, []AssistantTurn, error) {
	var pending chatContext
	quotes := []AssistantTurn{}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return pending, quotes, err
	}
	defer tx.Rollback(ctx)
	epoch, _, err := chatHead(ctx, tx, user, book)
	if err != nil {
		return pending, quotes, err
	}
	if epoch != in.ChatEpoch {
		return pending, quotes, apiError{410, "Переписка очищена на другом устройстве. Начните новый запрос"}
	}
	var deleted bool
	var requestHash string
	err = tx.QueryRow(ctx, `SELECT deleted,COALESCE(body->>'requestHash','') FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, in.ID).Scan(&deleted, &requestHash)
	if err == nil && deleted {
		return pending, quotes, apiError{410, "Сообщение удалено"}
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return pending, quotes, err
	}
	exists := err == nil
	if exists && requestHash != hash(string(jsonBytes(in))) {
		return pending, quotes, bad("ID сообщения уже использован с другими данными")
	}
	var status, requestID string
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT status,request_id,context FROM assistant_tasks WHERE user_id=$1 AND book_id=$2 AND id=$3 FOR UPDATE`, user, book, in.TaskID).Scan(&status, &requestID, &raw)
	if err == nil {
		if status == "cancelled" {
			return pending, quotes, apiError{410, "Задача отменена"}
		}
		if requestID != in.ID {
			if status == "applied" || in.PendingTaskID != in.TaskID {
				return pending, quotes, bad("Эта задача уже завершена. Начните новый запрос")
			}
			var previous AssistantOutput
			if err = tx.QueryRow(ctx, `SELECT body->'result' FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3 AND NOT deleted`, user, book, derivedID(requestID, 100)).Scan(&raw); err != nil {
				return pending, quotes, apiError{409, "Дождитесь ответа на предыдущее сообщение"}
			}
			if json.Unmarshal(raw, &previous) != nil || (previous.Action != "clarify" && previous.Action != "review" && previous.Action != "category") {
				return pending, quotes, bad("Нет незавершённого уточнения")
			}
			if err = tx.QueryRow(ctx, `SELECT context FROM assistant_tasks WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, in.TaskID).Scan(&raw); err != nil {
				return pending, quotes, err
			}
		}
		if in.PendingTaskID != "" && json.Unmarshal(raw, &pending) != nil {
			return pending, quotes, bad("Не удалось прочитать черновик")
		}
		if _, err = tx.Exec(ctx, `UPDATE assistant_tasks SET request_id=$4 WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, in.TaskID, in.ID); err != nil {
			return pending, quotes, err
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		if in.PendingTaskID != "" {
			return pending, quotes, bad("Черновик больше не доступен")
		}
		_, err = tx.Exec(ctx, `INSERT INTO assistant_tasks(user_id,book_id,id,epoch,request_id,context) VALUES($1,$2,$3,$4,$5,$6)`, user, book, in.TaskID, epoch, in.ID, jsonBytes(chatContext{Original: in.Text}))
		if err != nil {
			return pending, quotes, err
		}
	} else {
		return pending, quotes, err
	}
	if len(in.QuoteIDs) > 3 {
		return pending, quotes, bad("Можно выбрать до трёх цитат")
	}
	total, seen := 0, map[string]bool{}
	for _, id := range in.QuoteIDs {
		if !uuidPattern.MatchString(id) || seen[id] {
			return pending, quotes, bad("Неверная цитата")
		}
		seen[id] = true
		var role, text, transcript string
		err = tx.QueryRow(ctx, `SELECT role,text,transcript FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3 AND NOT deleted AND created_at>now()-interval '90 days'`, user, book, id).Scan(&role, &text, &transcript)
		if err != nil {
			return pending, quotes, bad("Цитата удалена или больше не доступна")
		}
		if strings.TrimSpace(transcript) != "" {
			text = strings.TrimSpace(text + "\n" + transcript)
		}
		total += len(text)
		if strings.TrimSpace(text) == "" || total > 8192 {
			return pending, quotes, bad("Для цитирования нужен текст, суммарно до 8 КБ")
		}
		quotes = append(quotes, AssistantTurn{Role: role, Content: text})
	}
	if !exists {
		text := in.Text
		if text == "" && in.Image != "" {
			text = "Фото чека"
		}
		if err = putChat(ctx, tx, user, book, ChatMessage{ID: in.ID, TaskID: in.TaskID, Role: "user", Text: text, Audio: in.Audio != "", CreatedAt: in.SentAt, RequestHash: hash(string(jsonBytes(in)))}); err != nil {
			return pending, quotes, err
		}
	}
	return pending, quotes, tx.Commit(ctx)
}

func finishChat(ctx context.Context, tx pgx.Tx, user, book string, in AssistantInput, out *AssistantOutput) error {
	epoch, _, err := chatHead(ctx, tx, user, book)
	if err != nil {
		return err
	}
	var status, current string
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT status,request_id,context FROM assistant_tasks WHERE user_id=$1 AND book_id=$2 AND id=$3 FOR UPDATE`, user, book, in.TaskID).Scan(&status, &current, &raw)
	if err != nil {
		return err
	}
	if epoch != in.ChatEpoch || status == "cancelled" || current != in.ID {
		return apiError{410, "Задача отменена или изменена на другом устройстве"}
	}
	var pending chatContext
	if err = json.Unmarshal(raw, &pending); err != nil {
		return err
	}
	if pending.Original == "" {
		pending.Original = out.Transcript
	} else if in.PendingTaskID == "" && in.Audio != "" && out.Transcript != "" {
		pending.Original = strings.TrimSpace(pending.Original + "\n" + out.Transcript)
	}
	pending.Entries, pending.Question, pending.Category = out.Entries, out.Question, out.Category
	if _, err = tx.Exec(ctx, `UPDATE assistant_tasks SET context=$4 WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, in.TaskID, jsonBytes(pending)); err != nil {
		return err
	}
	var userMessage ChatMessage
	if err = tx.QueryRow(ctx, `SELECT body FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, book, in.ID).Scan(&raw); err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &userMessage); err != nil {
		return err
	}
	userMessage.Transcript = out.Transcript
	if err = putChat(ctx, tx, user, book, userMessage); err != nil {
		return err
	}
	reply := *out
	reply.Transcript = ""
	return putChat(ctx, tx, user, book, ChatMessage{ID: out.MessageID, TaskID: in.TaskID, Role: "assistant", Text: out.Text, Result: &reply, ReplyTo: in.ID, CreatedAt: out.CompletedAt})
}

func (a *App) deleteChat(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		IDs   []string `json:"ids"`
		Clear bool     `json:"clear"`
		Epoch int64    `json:"epoch"`
		ID    string   `json:"id,omitempty"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	if (!in.Clear && len(in.IDs) == 0) || len(in.IDs) > 100 {
		return bad("Выберите до 100 сообщений")
	}
	for _, id := range in.IDs {
		if !uuidPattern.MatchString(id) {
			return bad("Неверное сообщение")
		}
	}
	if in.ID != "" && (!in.Clear || !uuidPattern.MatchString(in.ID)) {
		return bad("Неверный ID очистки")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	book := r.PathValue("book")
	epoch, _, err := chatHead(r.Context(), tx, u.ID, book)
	if err != nil {
		return err
	}
	if in.Clear && in.ID != "" {
		var kind string
		err = tx.QueryRow(r.Context(), `SELECT request_id FROM assistant_tasks WHERE user_id=$1 AND book_id=$2 AND id=$3`, u.ID, book, in.ID).Scan(&kind)
		if err == nil {
			if kind != "clear-chat" {
				return bad("ID очистки уже использован")
			}
			respond(w, map[string]any{"deleted": []string{}, "epoch": epoch})
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO assistant_tasks(user_id,book_id,id,epoch,request_id,status) VALUES($1,$2,$3,$4,'clear-chat','applied')`, u.ID, book, in.ID, epoch); err != nil {
			return err
		}
	}
	if in.Clear && in.ID == "" && in.Epoch != epoch {
		respond(w, map[string]any{"deleted": []string{}, "epoch": epoch})
		return nil
	}
	if in.Clear {
		if _, err = tx.Exec(r.Context(), `UPDATE chat_heads SET epoch=epoch+1 WHERE user_id=$1 AND book_id=$2`, u.ID, book); err != nil {
			return err
		}
		epoch++
	}
	rows, err := tx.Query(r.Context(), `SELECT id,task_id,COALESCE(NULLIF(body->>'replyTo',''),id) FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND (NOT deleted OR body->>'expired'='true') AND ($3 OR id=ANY($4)) ORDER BY id`, u.ID, book, in.Clear, in.IDs)
	if err != nil {
		return err
	}
	ids, cacheIDs, tasks := []string{}, []string{}, map[string]bool{}
	for rows.Next() {
		var id, task, cacheID string
		if err = rows.Scan(&id, &task, &cacheID); err != nil {
			break
		}
		ids, tasks[task] = append(ids, id), true
		cacheIDs = append(cacheIDs, cacheID)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if err = rows.Err(); err != nil {
		return err
	}
	taskIDs := []string{}
	for task := range tasks {
		taskIDs = append(taskIDs, task)
	}
	if _, err = tx.Exec(r.Context(), `UPDATE assistant_tasks SET status='cancelled',context='{}' WHERE user_id=$1 AND book_id=$2 AND id=ANY($3) AND status='open'`, u.ID, book, taskIDs); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `WITH targets AS MATERIALIZED(
		SELECT id,row_number() OVER(ORDER BY id) AS n FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND task_id=ANY($3)),
		head AS(UPDATE chat_heads SET seq=seq+(SELECT count(*) FROM targets) WHERE user_id=$1 AND book_id=$2 RETURNING seq)
		UPDATE chat_messages m SET seq=head.seq-(SELECT count(*) FROM targets)+targets.n,
		deleted=m.deleted OR m.id=ANY($4),text=CASE WHEN m.id=ANY($4) THEN '' ELSE m.text END,
		transcript=CASE WHEN m.id=ANY($4) THEN '' ELSE m.transcript END,body=CASE WHEN m.id=ANY($4) THEN '{}'::jsonb ELSE m.body END
		FROM head,targets WHERE m.user_id=$1 AND m.book_id=$2 AND m.id=targets.id`, u.ID, book, taskIDs, ids); err != nil {
		return err
	}
	for _, id := range in.IDs {
		found := false
		for _, existing := range ids {
			if existing == id {
				found = true
				break
			}
		}
		if !found {
			var exists bool
			if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3)`, u.ID, book, id).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				if err = putChat(r.Context(), tx, u.ID, book, ChatMessage{ID: id, TaskID: id, Role: "user", Deleted: true, CreatedAt: time.Now().UTC()}); err != nil {
					return err
				}
			}
		}
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM assistant_requests WHERE user_id=$1 AND book_id=$2 AND id=ANY($3)`, u.ID, book, cacheIDs); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM chat_media WHERE user_id=$1 AND book_id=$2 AND message_id=ANY($3)`, u.ID, book, ids); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]any{"deleted": ids, "epoch": epoch})
	return nil
}

func (a *App) applyAssistantTask(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		RequestID string    `json:"requestId"`
		Commands  []Command `json:"commands"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	book, task := r.PathValue("book"), r.PathValue("task")
	if !uuidPattern.MatchString(task) || !uuidPattern.MatchString(in.RequestID) || len(in.Commands) > 51 {
		return bad("Неверная группа команд помощника")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, _, err = chatHead(r.Context(), tx, u.ID, book); err != nil {
		return err
	}
	var status, requestID string
	var raw, applied []byte
	err = tx.QueryRow(r.Context(), `SELECT status,request_id,context,applied_ids FROM assistant_tasks WHERE user_id=$1 AND book_id=$2 AND id=$3 FOR UPDATE`, u.ID, book, task).Scan(&status, &requestID, &raw, &applied)
	if errors.Is(err, pgx.ErrNoRows) {
		return bad("Задача не найдена")
	}
	if err != nil {
		return err
	}
	if status == "cancelled" {
		return apiError{410, "Задача отменена. Операции не добавлены"}
	}
	if status == "applied" {
		var appliedContext chatContext
		if err = json.Unmarshal(raw, &appliedContext); err != nil {
			return err
		}
		out, err := a.applyInTx(r.Context(), tx, u.ID, book, nil, true)
		if err != nil {
			return err
		}
		for _, c := range in.Commands {
			var item struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(c.Data, &item) != nil || !uuidPattern.MatchString(c.ID) || appliedContext.AppliedVersions[c.Entity+":"+item.ID] == 0 {
				return bad("Запись не относится к выполненной задаче")
			}
			out.Results = append(out.Results, CommandResult{ID: c.ID, Status: "ok", Version: appliedContext.AppliedVersions[c.Entity+":"+item.ID]})
		}
		respond(w, out)
		return nil
	}
	if requestID != in.RequestID {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(409)
		respond(w, map[string]string{"error": "Черновик обновлён на другом устройстве", "code": "task_changed"})
		return nil
	}
	var pending chatContext
	if err = json.Unmarshal(raw, &pending); err != nil {
		return err
	}
	if len(in.Commands) == 0 && (pending.Category == nil || len(pending.Entries) > 0) {
		return bad("Нет записей для сохранения")
	}
	allowed := map[string]bool{}
	for _, e := range pending.Entries {
		allowed[e.ID] = true
	}
	ids, seen := []string{}, map[string]bool{}
	for _, c := range in.Commands {
		var item struct {
			ID      string `json:"id"`
			Deleted bool   `json:"deleted"`
		}
		if json.Unmarshal(c.Data, &item) != nil || item.Deleted || c.Base != 0 || seen[item.ID] {
			return bad("Помощник может только создавать подготовленные записи")
		}
		seen[item.ID] = true
		if (c.Entity == "entry" && !allowed[item.ID]) || (c.Entity == "category" && (pending.Category == nil || item.ID != pending.Category.ID)) || (c.Entity != "entry" && c.Entity != "category") {
			return bad("Запись не относится к задаче")
		}
		ids = append(ids, item.ID)
	}
	out, err := a.applyInTx(r.Context(), tx, u.ID, book, in.Commands, true)
	if err != nil {
		return err
	}
	versions := map[string]int64{}
	for i, c := range in.Commands {
		versions[c.Entity+":"+ids[i]] = out.Results[i].Version
	}
	if _, err = tx.Exec(r.Context(), `UPDATE assistant_tasks SET status='applied',context=$5,applied_ids=$4 WHERE user_id=$1 AND book_id=$2 AND id=$3`, u.ID, book, task, jsonBytes(ids), jsonBytes(chatContext{AppliedVersions: versions})); err != nil {
		return err
	}
	if err = touchChatTask(r.Context(), tx, u.ID, book, task); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, out)
	return nil
}

func (a *App) chatMedia(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	book, id := r.PathValue("book"), r.PathValue("message")
	if !uuidPattern.MatchString(id) {
		return bad("Неверная запись")
	}
	var member bool
	if err = a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM members WHERE user_id=$1 AND book_id=$2)`, u.ID, book).Scan(&member); err != nil {
		return err
	}
	if !member {
		return forbidden()
	}
	if r.Method == "GET" {
		var data []byte
		var mimeType string
		err = a.db.QueryRow(r.Context(), `SELECT a.data,a.mime FROM chat_media a JOIN chat_messages m ON m.user_id=a.user_id AND m.book_id=a.book_id AND m.id=a.message_id
			WHERE a.user_id=$1 AND a.book_id=$2 AND a.message_id=$3 AND NOT m.deleted AND a.created_at>now()-interval '30 days'`, u.ID, book, id).Scan(&data, &mimeType)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiError{404, "Срок хранения аудио истёк или запись ещё не загружена"}
		}
		if err != nil {
			return err
		}
		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Write(data)
		return nil
	}
	mimeType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (mimeType != "audio/webm" && mimeType != "audio/mp4" && mimeType != "audio/ogg" && mimeType != "audio/wav") {
		return bad("Неподдерживаемый формат аудио")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, (4<<20)+1))
	if err != nil || len(data) == 0 || len(data) > 4<<20 {
		return bad("Аудио: до 4 MiB")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "chat-media:"+u.ID); err != nil {
		return err
	}
	if _, _, err = chatHead(r.Context(), tx, u.ID, book); err != nil {
		return err
	}
	var raw []byte
	var created time.Time
	err = tx.QueryRow(r.Context(), `SELECT body,created_at FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3 AND role='user' AND NOT deleted`, u.ID, book, id).Scan(&raw, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiError{410, "Сообщение удалено"}
	}
	if err != nil {
		return err
	}
	var m ChatMessage
	if json.Unmarshal(raw, &m) != nil || !m.Audio || time.Since(created) > 30*24*time.Hour {
		return apiError{410, "Аудио больше не сохраняется"}
	}
	var completed bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND role='assistant' AND body->>'replyTo'=$3 AND NOT deleted)`, u.ID, book, id).Scan(&completed); err != nil {
		return err
	}
	if !completed {
		return bad("Сначала дождитесь обработки записи")
	}
	var existing []byte
	err = tx.QueryRow(r.Context(), `SELECT data FROM chat_media WHERE user_id=$1 AND book_id=$2 AND message_id=$3`, u.ID, book, id).Scan(&existing)
	if err == nil {
		if hash(string(existing)) != hash(string(data)) {
			return bad("Аудио с этим ID уже существует")
		}
		respond(w, map[string]bool{"ok": true})
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO chat_media(user_id,book_id,message_id,mime,data,created_at) VALUES($1,$2,$3,$4,$5,$6)`, u.ID, book, id, mimeType, data, created); err != nil {
		return err
	}
	m.Media = &ChatMedia{MIME: mimeType, Size: len(data), Available: true}
	if err = putChat(r.Context(), tx, u.ID, book, m); err != nil {
		return err
	}
	if err = trimChatMedia(r.Context(), tx, u.ID); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]bool{"ok": true})
	return nil
}

func trimChatMedia(ctx context.Context, tx pgx.Tx, user string) error {
	rows, err := tx.Query(ctx, `SELECT book_id,message_id FROM (
		SELECT book_id,message_id,created_at,sum(octet_length(data)) OVER(ORDER BY created_at DESC,book_id,message_id) AS used
		FROM chat_media WHERE user_id=$1) a WHERE used>$2 OR created_at<now()-interval '30 days' ORDER BY book_id,message_id`, user, chatAudioLimit)
	if err != nil {
		return err
	}
	type key struct{ book, id string }
	keys := []key{}
	for rows.Next() {
		var k key
		if err = rows.Scan(&k.book, &k.id); err != nil {
			break
		}
		keys = append(keys, k)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, k := range keys {
		// The quota lock serializes uploads across this user's books.
		if _, err = tx.Exec(ctx, `INSERT INTO chat_heads(user_id,book_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, user, k.book); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `WITH n AS (UPDATE chat_heads SET seq=seq+1 WHERE user_id=$1 AND book_id=$2 RETURNING seq)
			UPDATE chat_messages SET body=jsonb_set(body,'{media,available}','false'),seq=n.seq FROM n WHERE user_id=$1 AND book_id=$2 AND id=$3`, user, k.book, k.id); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM chat_media WHERE user_id=$1 AND book_id=$2 AND message_id=$3`, user, k.book, k.id); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) importChat(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		Epoch    int64         `json:"epoch"`
		Messages []ChatMessage `json:"messages"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	if len(in.Messages) == 0 || len(in.Messages) > 50 {
		return bad("Переносите до 50 сообщений за раз")
	}
	for _, m := range in.Messages {
		if !uuidPattern.MatchString(m.ID) || !uuidPattern.MatchString(m.TaskID) || (m.Role != "user" && m.Role != "assistant") || len(m.Text) > 16384 || len(m.Transcript) > 8192 || m.CreatedAt.IsZero() || m.CreatedAt.After(time.Now().Add(24*time.Hour)) || (m.ReplyTo != "" && !uuidPattern.MatchString(m.ReplyTo)) || len(jsonBytes(m)) > 256<<10 {
			return bad("Повреждённое сообщение прежней переписки")
		}
		if m.Result != nil && len(m.Result.Entries) > 50 {
			return bad("Слишком много строк в старом сообщении")
		}
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	book := r.PathValue("book")
	epoch, _, err := chatHead(r.Context(), tx, u.ID, book)
	if err != nil {
		return err
	}
	if err = requireLockedBookDataVersion(r.Context(), tx, book); err != nil {
		return err
	}
	for _, m := range in.Messages {
		if err = requireChatDataVersion(m, dataVersionFromContext(r.Context())); err != nil {
			return err
		}
	}
	if epoch != in.Epoch {
		return apiError{410, "Переписка была очищена. Обновите экран перед переносом"}
	}
	for _, m := range in.Messages {
		if m.CreatedAt.Before(time.Now().Add(-90 * 24 * time.Hour)) {
			continue
		}
		var exists bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND id=$3)`, u.ID, book, m.ID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		// Imported display history never replays old financial tasks.
		if _, err = tx.Exec(r.Context(), `INSERT INTO assistant_tasks(user_id,book_id,id,epoch,request_id,status) VALUES($1,$2,$3,$4,$5,'cancelled') ON CONFLICT DO NOTHING`, u.ID, book, m.TaskID, epoch, m.ReplyTo); err != nil {
			return err
		}
		m.Status = "cancelled"
		m.AppliedIDs = nil
		m.Media = nil
		m.Deleted = false
		if err = putChat(r.Context(), tx, u.ID, book, m); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]bool{"ok": true})
	return nil
}

func (a *App) cleanupChat(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `SELECT DISTINCT user_id,book_id FROM chat_messages WHERE NOT deleted AND created_at<now()-interval '90 days' ORDER BY user_id,book_id`)
	if err != nil {
		return err
	}
	type scope struct{ user, book string }
	scopes := []scope{}
	for rows.Next() {
		var s scope
		if err = rows.Scan(&s.user, &s.book); err != nil {
			break
		}
		scopes = append(scopes, s)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, s := range scopes {
		tx, err := a.db.Begin(ctx)
		if err != nil {
			return err
		}
		// Former members' history must expire too; cleanup uses the same head lock without access checks.
		_, err = tx.Exec(ctx, `SELECT id FROM books WHERE id=$1 FOR UPDATE`, s.book)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE chat_heads SET seq=seq+1 WHERE user_id=$1 AND book_id=$2`, s.user, s.book)
		}
		if err == nil {
			// Expiry removes chat text, not the right to submit an already prepared offline financial group.
			_, err = tx.Exec(ctx, `UPDATE assistant_tasks t SET context=jsonb_build_object(
			'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e->>'id')) FROM jsonb_array_elements(COALESCE(t.context->'entries','[]')) e),'[]'::jsonb),
			'category',CASE WHEN jsonb_typeof(t.context->'category')='object' THEN jsonb_build_object('id',t.context->'category'->>'id','existingId',t.context->'category'->>'existingId') ELSE 'null'::jsonb END)
			WHERE user_id=$1 AND book_id=$2 AND status='open' AND id IN(SELECT task_id FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND NOT deleted AND created_at<now()-interval '90 days')`, s.user, s.book)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM chat_media WHERE user_id=$1 AND book_id=$2 AND message_id IN(SELECT id FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND created_at<now()-interval '90 days')`, s.user, s.book)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `WITH doomed AS MATERIALIZED (
			SELECT id,row_number() OVER(ORDER BY id) AS n FROM chat_messages WHERE user_id=$1 AND book_id=$2 AND NOT deleted AND created_at<now()-interval '90 days'),
			head AS (UPDATE chat_heads SET seq=seq+(SELECT count(*) FROM doomed) WHERE user_id=$1 AND book_id=$2 RETURNING seq)
			UPDATE chat_messages m SET deleted=true,text='',transcript='',body='{"expired":true}',seq=head.seq-(SELECT count(*) FROM doomed)+doomed.n FROM head,doomed
			WHERE m.user_id=$1 AND m.book_id=$2 AND m.id=doomed.id`, s.user, s.book)
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			tx.Rollback(ctx)
		}
		if err != nil {
			return err
		}
	}
	rows, err = a.db.Query(ctx, `SELECT DISTINCT user_id FROM chat_media WHERE created_at<now()-interval '30 days' ORDER BY user_id`)
	if err != nil {
		return err
	}
	users := []string{}
	for rows.Next() {
		var user string
		if err = rows.Scan(&user); err != nil {
			break
		}
		users = append(users, user)
	}
	rows.Close()
	if err != nil {
		return err
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, user := range users {
		tx, err := a.db.Begin(ctx)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "chat-media:"+user)
		if err == nil {
			err = trimChatMedia(ctx, tx, user)
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			tx.Rollback(ctx)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
