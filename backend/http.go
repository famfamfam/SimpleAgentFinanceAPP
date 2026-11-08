package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type apiError struct {
	status  int
	message string
}

type dataVersionKey struct{}

func requestDataVersion(r *http.Request) int {
	if r.Header.Get("X-Finance-Data-Version") == "4" {
		return 4
	}
	return 0
}

func dataVersionFromContext(ctx context.Context) int {
	if version, ok := ctx.Value(dataVersionKey{}).(int); ok {
		return version
	}
	return 4
}

func clientUpdateRequired() error {
	return apiError{http.StatusUpgradeRequired, "Обновите приложение для работы с валютами"}
}

func requireDataVersion(state State, version int) error {
	if version >= 4 {
		return nil
	}
	for _, a := range state.Accounts {
		if NormalizeCurrency(a.Currency) != "RUB" {
			return clientUpdateRequired()
		}
	}
	for _, e := range state.Entries {
		if NormalizeCurrency(e.Currency) != "RUB" || NormalizeCurrency(e.ToCurrency) != "RUB" {
			return clientUpdateRequired()
		}
	}
	return nil
}

func requireCommandDataVersion(c Command, version int) error {
	if version >= 4 || (c.Entity != "account" && c.Entity != "entry") {
		return nil
	}
	var currencies struct {
		Currency   string `json:"currency"`
		ToCurrency string `json:"toCurrency"`
	}
	if json.Unmarshal(c.Data, &currencies) == nil && (NormalizeCurrency(currencies.Currency) != "RUB" || NormalizeCurrency(currencies.ToCurrency) != "RUB") {
		return clientUpdateRequired()
	}
	return nil
}

const requestTimeout = 75 * time.Second

func (e apiError) Error() string { return e.message }
func bad(s string) error         { return apiError{400, s} }
func forbidden() error           { return apiError{403, "Нет доступа к этой книге"} }
func respond(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}
func body(r *http.Request, v any) error {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return bad("Неверные данные запроса")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return bad("Ожидался один JSON-объект")
	}
	return nil
}
func endpoint(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		r = r.WithContext(ctx)
		if err := fn(w, r); err != nil {
			status, message := 500, "Ошибка сервера. Изменения на устройстве сохранены"
			var e apiError
			if errors.As(err, &e) {
				status, message = e.status, e.message
			} else {
				slog.Error("request failed", "path", r.URL.Path, "error", err)
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(status)
			response := map[string]any{"error": message}
			if status == http.StatusUpgradeRequired {
				response["code"] = "client_update_required"
			}
			json.NewEncoder(w).Encode(response)
		}
	}
}
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]any{"version": buildVersion, "assets": assetVersion, "api": 1})
	})
	mux.HandleFunc("GET /api/health", endpoint(func(w http.ResponseWriter, r *http.Request) error {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := a.db.Ping(ctx); err != nil {
			return apiError{503, "База недоступна"}
		}
		if err := a.redis.Ping(ctx).Err(); err != nil {
			return apiError{503, "Защита входа недоступна"}
		}
		respond(w, map[string]bool{"ok": true})
		return nil
	}))
	mux.HandleFunc("POST /api/register", endpoint(a.register))
	mux.HandleFunc("POST /api/recover", endpoint(a.recover))
	mux.HandleFunc("GET /api/me", endpoint(a.me))
	mux.HandleFunc("PATCH /api/me", endpoint(a.nickname))
	mux.HandleFunc("POST /api/logout", endpoint(a.logout))
	mux.HandleFunc("POST /api/recovery-key", endpoint(a.rotateKey))
	mux.HandleFunc("GET /api/sessions", endpoint(a.sessions))
	mux.HandleFunc("DELETE /api/sessions/{id}", endpoint(a.revokeSession))
	mux.HandleFunc("POST /api/books", endpoint(a.createBook))
	mux.HandleFunc("POST /api/join", endpoint(a.join))
	mux.HandleFunc("GET /api/books/{book}/sync", endpoint(a.getState))
	mux.HandleFunc("POST /api/books/{book}/sync", endpoint(a.push))
	mux.HandleFunc("GET /api/books/{book}/members", endpoint(a.members))
	mux.HandleFunc("DELETE /api/books/{book}/members/{user}", endpoint(a.removeMember))
	mux.HandleFunc("POST /api/books/{book}/invite", endpoint(a.invite))
	mux.HandleFunc("GET /api/books/{book}/integrations", endpoint(a.integrations))
	mux.HandleFunc("POST /api/books/{book}/integrations", endpoint(a.createIntegration))
	mux.HandleFunc("DELETE /api/books/{book}/integrations/{id}", endpoint(a.removeIntegration))
	mux.HandleFunc("POST /api/books/{book}/assistant", endpoint(a.assistant))
	mux.HandleFunc("POST /api/books/{book}/category-style", endpoint(a.categoryStyle))
	mux.HandleFunc("GET /api/books/{book}/chat", endpoint(a.chatHistory))
	mux.HandleFunc("POST /api/books/{book}/chat/delete", endpoint(a.deleteChat))
	mux.HandleFunc("POST /api/books/{book}/chat/import", endpoint(a.importChat))
	mux.HandleFunc("PUT /api/books/{book}/chat/media/{message}", endpoint(a.chatMedia))
	mux.HandleFunc("GET /api/books/{book}/chat/media/{message}", endpoint(a.chatMedia))
	mux.HandleFunc("POST /api/books/{book}/assistant-tasks/{task}/apply", endpoint(a.applyAssistantTask))
	mux.HandleFunc("POST /api/books/{book}/import", endpoint(a.importPreview))
	mux.HandleFunc("POST /api/books/{book}/import/{id}", endpoint(a.importApply))
	mux.HandleFunc("GET /api/books/{book}/export", endpoint(a.exportXLSX))
	mux.HandleFunc("POST /api/local-files/{action}", endpoint(a.localXLSX))
	mux.HandleFunc("POST /api/qr", endpoint(a.qr))
	mux.Handle("/mcp", a.mcpHandler())
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "Not found", 404) })
	files := staticFiles()
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".html") || r.URL.Path == "/" || r.URL.Path == "/sw.js" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		files.ServeHTTP(w, r)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" {
			w.Header().Set("Cache-Control", "no-store")
			r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || (a.origin != "" && origin != a.origin) {
				http.Error(w, "Origin denied", 403)
				return
			}
		}
		defer func() {
			if recover() != nil {
				slog.Error("request panic", "path", r.URL.Path)
				http.Error(w, "Internal error", 500)
			}
		}()
		if strings.HasPrefix(r.URL.Path, "/api/") {
			r = r.WithContext(context.WithValue(r.Context(), dataVersionKey{}, requestDataVersion(r)))
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *App) codeHash(code string) string {
	mac := hmac.New(sha256.New, []byte(a.secret))
	mac.Write([]byte(code))
	return hex.EncodeToString(mac.Sum(nil))
}
func clientIP(r *http.Request) string {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if os.Getenv("TRUST_PROXY") == "true" && net.ParseIP(ip).IsPrivate() {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		last := strings.TrimSpace(parts[len(parts)-1])
		if net.ParseIP(last) != nil {
			return last
		}
	}
	return ip
}
func (a *App) limit(r *http.Request, key string, max int, window time.Duration) error {
	script := `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`
	n, err := a.redis.Eval(r.Context(), script, []string{"finance:" + key}, int(window.Seconds())).Int()
	if err != nil {
		return apiError{503, "Защита запросов временно недоступна"}
	}
	if n > max {
		return apiError{429, "Слишком много попыток. Попробуйте позже"}
	}
	return nil
}

type identity struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	Session  string `json:"session,omitempty"`
}

func requestToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if c, err := r.Cookie("finance_session"); err == nil {
		return c.Value
	}
	return ""
}
func (a *App) user(r *http.Request) (identity, error) {
	var u identity
	token := requestToken(r)
	if len(token) != 43 {
		return u, apiError{401, "Войдите по ключу восстановления"}
	}
	err := a.db.QueryRow(r.Context(), `SELECT u.id,u.nickname,s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, hash(token)).Scan(&u.ID, &u.Nickname, &u.Session)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, apiError{401, "Сессия завершена. Используйте ключ восстановления"}
	}
	if err == nil && r.Header.Get("X-Finance-User") != "" && r.Header.Get("X-Finance-User") != u.ID {
		return u, apiError{409, "Пользователь изменился. Обновите экран перед отправкой"}
	}
	return u, err
}
func (a *App) cookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: "finance_session", Value: token, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteStrictMode, MaxAge: 180 * 24 * 60 * 60})
}
func (a *App) newSession(ctx context.Context, q pgx.Tx, user string) (string, error) {
	token := newToken()
	_, err := q.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash) VALUES($1,$2,$3)`, newID(), user, hash(token))
	return token, err
}
func (a *App) register(w http.ResponseWriter, r *http.Request) error {
	if err := a.limit(r, "register:"+clientIP(r), 10, time.Hour); err != nil {
		return err
	}
	if a.registrationPassword == "" {
		return apiError{503, "Регистрация пока не настроена"}
	}
	var in struct {
		Nickname string `json:"nickname"`
		Password string `json:"password"`
	}
	if err := body(r, &in); err != nil {
		return err
	}
	if len(in.Password) > 1024 || !hmac.Equal([]byte(hash(in.Password)), []byte(hash(a.registrationPassword))) {
		return apiError{401, "Неверный пароль доступа"}
	}
	if !validName(in.Nickname) {
		return bad("Укажите имя до 80 символов")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	id, key := newID(), newToken()
	if _, err = tx.Exec(r.Context(), `INSERT INTO users(id,nickname,recovery_hash) VALUES($1,$2,$3)`, id, strings.TrimSpace(in.Nickname), hash(key)); err != nil {
		return err
	}
	token, err := a.newSession(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	a.cookie(w, token)
	respond(w, map[string]any{"user": identity{ID: id, Nickname: in.Nickname}, "recoveryKey": key})
	return nil
}
func (a *App) recover(w http.ResponseWriter, r *http.Request) error {
	if err := a.limit(r, "recover:"+clientIP(r), 10, 15*time.Minute); err != nil {
		return err
	}
	var in struct {
		Key string `json:"key"`
	}
	if err := body(r, &in); err != nil {
		return err
	}
	in.Key = strings.TrimPrefix(strings.TrimSpace(in.Key), "finance-key:v1:")
	if len(in.Key) != 43 {
		return bad("Неверный ключ восстановления")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var id string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM users WHERE recovery_hash=$1 FOR UPDATE`, hash(in.Key)).Scan(&id); errors.Is(err, pgx.ErrNoRows) {
		return apiError{401, "Неверный ключ восстановления"}
	} else if err != nil {
		return err
	}
	token, err := a.newSession(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	a.cookie(w, token)
	respond(w, map[string]bool{"ok": true})
	return nil
}
func (a *App) me(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	rows, err := a.db.Query(r.Context(), `SELECT b.id,b.name,b.owner_id,b.revision FROM books b JOIN members m ON m.book_id=b.id WHERE m.user_id=$1 ORDER BY m.joined_at`, u.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	books := []map[string]any{}
	for rows.Next() {
		var id, name, owner string
		var rev int64
		if err = rows.Scan(&id, &name, &owner, &rev); err != nil {
			return err
		}
		books = append(books, map[string]any{"id": id, "name": name, "owner": owner, "revision": rev})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	respond(w, map[string]any{"user": u, "books": books, "aiAvailable": a.openrouter != ""})
	return nil
}
func (a *App) nickname(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		Nickname string `json:"nickname"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	if !validName(in.Nickname) {
		return bad("Укажите имя до 80 символов")
	}
	_, err = a.db.Exec(r.Context(), `UPDATE users SET nickname=$1 WHERE id=$2`, strings.TrimSpace(in.Nickname), u.ID)
	if err != nil {
		return err
	}
	respond(w, map[string]bool{"ok": true})
	return nil
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(r.Context(), `DELETE FROM sessions WHERE id=$1`, u.Session)
	if err != nil {
		return err
	}
	a.cookie(w, "")
	respond(w, map[string]bool{"ok": true})
	return nil
}
func (a *App) rotateKey(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	key := newToken()
	_, err = a.db.Exec(r.Context(), `UPDATE users SET recovery_hash=$1 WHERE id=$2`, hash(key), u.ID)
	if err != nil {
		return err
	}
	respond(w, map[string]string{"recoveryKey": key})
	return nil
}
func (a *App) sessions(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	rows, err := a.db.Query(r.Context(), `SELECT id,created_at,expires_at FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC`, u.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id string
		var created, expires time.Time
		if err = rows.Scan(&id, &created, &expires); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "createdAt": created, "expiresAt": expires, "current": id == u.Session})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	respond(w, out)
	return nil
}
func (a *App) revokeSession(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(r.Context(), `DELETE FROM sessions WHERE id=$1 AND user_id=$2`, r.PathValue("id"), u.ID)
	if err != nil {
		return err
	}
	respond(w, map[string]bool{"ok": true})
	return nil
}
func (a *App) access(ctx context.Context, user, book string) (string, error) {
	var owner string
	err := a.db.QueryRow(ctx, `SELECT b.owner_id FROM books b JOIN members m ON m.book_id=b.id WHERE b.id=$1 AND m.user_id=$2`, book, user).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", forbidden()
	}
	return owner, err
}
func (a *App) createBook(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	if err = a.limit(r, "books:"+u.ID, 10, time.Hour); err != nil {
		return err
	}
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	if !uuidPattern.MatchString(in.ID) || !validName(in.Name) {
		return bad("Проверьте название книги")
	}
	state, _ := json.Marshal(initialState())
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var owner string
	err = tx.QueryRow(r.Context(), `SELECT owner_id FROM books WHERE id=$1`, in.ID).Scan(&owner)
	if err == nil {
		if owner != u.ID {
			return forbidden()
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		if _, err = tx.Exec(r.Context(), `INSERT INTO books(id,owner_id,name,state,revision) VALUES($1,$2,$3,$4,1)`, in.ID, u.ID, in.Name, state); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO members(book_id,user_id) VALUES($1,$2)`, in.ID, u.ID); err != nil {
			return err
		}
	} else {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]string{"id": in.ID})
	return nil
}
func (a *App) invite(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	book := r.PathValue("book")
	owner, err := a.access(r.Context(), u.ID, book)
	if err != nil {
		return err
	}
	if owner != u.ID {
		return forbidden()
	}
	if err = a.limit(r, "invite-create:"+u.ID, 20, time.Hour); err != nil {
		return err
	}
	alphabet := "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 8)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[b[i]&31]
	}
	code := string(b)
	_, err = a.db.Exec(r.Context(), `INSERT INTO invitations(code_hash,book_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')`, a.codeHash(code), book)
	if err != nil {
		return err
	}
	respond(w, map[string]any{"code": code, "expiresIn": 900})
	return nil
}
func (a *App) join(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	if err = a.limit(r, "join-ip:"+clientIP(r), 10, time.Minute); err != nil {
		return err
	}
	if err = a.limit(r, "join-global", 1000, time.Minute); err != nil {
		return err
	}
	var in struct {
		Code string `json:"code"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	if len(in.Code) != 8 {
		return bad("Код состоит из 8 символов")
	}
	h := a.codeHash(in.Code)
	if err = a.limit(r, "join-code:"+h, 5, 15*time.Minute); err != nil {
		return err
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var book string
	var used *string
	err = tx.QueryRow(r.Context(), `SELECT book_id,used_by FROM invitations WHERE code_hash=$1 AND expires_at>now() FOR UPDATE`, h).Scan(&book, &used)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && used != nil && *used != u.ID) {
		return bad("Код неверен, истек или уже использован")
	}
	if err != nil {
		return err
	}
	if used != nil {
		var active bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM members WHERE book_id=$1 AND user_id=$2)`, book, u.ID).Scan(&active); err != nil {
			return err
		}
		if !active {
			return bad("Приглашение уже использовано")
		}
		respond(w, map[string]string{"bookId": book})
		return nil
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO members(book_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, book, u.ID); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `UPDATE invitations SET used_by=$1 WHERE code_hash=$2`, u.ID, h); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]string{"bookId": book})
	return nil
}
func (a *App) members(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	owner, err := a.access(r.Context(), u.ID, r.PathValue("book"))
	if err != nil {
		return err
	}
	rows, err := a.db.Query(r.Context(), `SELECT u.id,u.nickname FROM users u JOIN members m ON m.user_id=u.id WHERE m.book_id=$1 ORDER BY m.joined_at`, r.PathValue("book"))
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "nickname": name, "owner": id == owner})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	respond(w, out)
	return nil
}
func (a *App) removeMember(w http.ResponseWriter, r *http.Request) error {
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
	var owner string
	if err = tx.QueryRow(r.Context(), `SELECT owner_id FROM books WHERE id=$1 FOR UPDATE`, book).Scan(&owner); err != nil {
		return forbidden()
	}
	if owner != u.ID || r.PathValue("user") == owner {
		return forbidden()
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM members WHERE book_id=$1 AND user_id=$2`, book, r.PathValue("user")); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, map[string]bool{"ok": true})
	return nil
}
func (a *App) integrations(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	if _, err = a.access(r.Context(), u.ID, r.PathValue("book")); err != nil {
		return err
	}
	rows, err := a.db.Query(r.Context(), `SELECT id,name,can_write,expires_at FROM integrations WHERE user_id=$1 AND book_id=$2 ORDER BY created_at`, u.ID, r.PathValue("book"))
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name string
		var write bool
		var expires time.Time
		if err = rows.Scan(&id, &name, &write, &expires); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "name": name, "write": write, "expiresAt": expires})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	respond(w, out)
	return nil
}
func (a *App) createIntegration(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	book := r.PathValue("book")
	if _, err = a.access(r.Context(), u.ID, book); err != nil {
		return err
	}
	var in struct {
		Name  string `json:"name"`
		Write bool   `json:"write"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	if !validName(in.Name) {
		return bad("Укажите название подключения")
	}
	token, id := newToken(), newID()
	_, err = a.db.Exec(r.Context(), `INSERT INTO integrations(id,book_id,user_id,name,token_hash,can_write) VALUES($1,$2,$3,$4,$5,$6)`, id, book, u.ID, in.Name, hash(token), in.Write)
	if err != nil {
		return err
	}
	respond(w, map[string]string{"id": id, "token": token})
	return nil
}
func (a *App) removeIntegration(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(r.Context(), `DELETE FROM integrations WHERE id=$1 AND user_id=$2 AND book_id=$3`, r.PathValue("id"), u.ID, r.PathValue("book"))
	if err != nil {
		return err
	}
	respond(w, map[string]bool{"ok": true})
	return nil
}

type Snapshot struct {
	State    State           `json:"state"`
	Revision int64           `json:"revision"`
	Results  []CommandResult `json:"results"`
}

func (a *App) snapshot(ctx context.Context, user, book string) (Snapshot, error) {
	out := Snapshot{Results: []CommandResult{}}
	var data []byte
	err := a.db.QueryRow(ctx, `SELECT state,revision FROM books b WHERE id=$1 AND EXISTS(SELECT 1 FROM members m WHERE m.book_id=b.id AND m.user_id=$2)`, book, user).Scan(&data, &out.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, forbidden()
	}
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(data, &out.State)
	if err == nil {
		err = requireDataVersion(out.State, dataVersionFromContext(ctx))
	}
	return out, err
}
func (a *App) getState(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	out, err := a.snapshot(r.Context(), u.ID, r.PathValue("book"))
	if err != nil {
		return err
	}
	respond(w, out)
	return nil
}
func (a *App) push(w http.ResponseWriter, r *http.Request) error {
	u, err := a.user(r)
	if err != nil {
		return err
	}
	var in struct {
		Commands []Command `json:"commands"`
	}
	if err = body(r, &in); err != nil {
		return err
	}
	if len(in.Commands) > 100 {
		return bad("Отправляйте не больше 100 изменений за раз")
	}
	out, err := a.applyCommands(r.Context(), u.ID, r.PathValue("book"), in.Commands)
	if err != nil {
		return err
	}
	respond(w, out)
	return nil
}
func (a *App) applyCommands(ctx context.Context, user, book string, commands []Command) (Snapshot, error) {
	return a.apply(ctx, user, book, commands, false)
}
func (a *App) applyVersion(ctx context.Context, user, book string, commands []Command, atomic bool, version int) (Snapshot, error) {
	return a.apply(context.WithValue(ctx, dataVersionKey{}, version), user, book, commands, atomic)
}

func (a *App) apply(ctx context.Context, user, book string, commands []Command, atomic bool) (Snapshot, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	defer tx.Rollback(ctx)
	out, err := a.applyInTx(ctx, tx, user, book, commands, atomic)
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
func (a *App) applyInTx(ctx context.Context, tx pgx.Tx, user, book string, commands []Command, atomic bool) (Snapshot, error) {
	out := Snapshot{Results: []CommandResult{}}
	var err error
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT state,revision FROM books WHERE id=$1 FOR UPDATE`, book).Scan(&raw, &out.Revision); errors.Is(err, pgx.ErrNoRows) {
		return out, forbidden()
	} else if err != nil {
		return out, err
	}
	var member bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM members WHERE book_id=$1 AND user_id=$2)`, book, user).Scan(&member); err != nil {
		return out, err
	}
	if !member {
		return out, forbidden()
	}
	if err = json.Unmarshal(raw, &out.State); err != nil {
		return out, err
	}
	if err = requireDataVersion(out.State, dataVersionFromContext(ctx)); err != nil {
		return out, err
	}
	for _, c := range commands {
		if !uuidPattern.MatchString(c.ID) {
			return out, bad("Неверный ID команды")
		}
		request, _ := json.Marshal(c)
		fingerprint := hash(string(request))
		var previous []byte
		var previousHash, previousUser string
		err = tx.QueryRow(ctx, `SELECT request_hash,user_id,result FROM mutations WHERE book_id=$1 AND id=$2`, book, c.ID).Scan(&previousHash, &previousUser, &previous)
		if err == nil {
			if fingerprint != previousHash || user != previousUser {
				return out, bad("ID команды уже использован с другими данными")
			}
			var result CommandResult
			if err = json.Unmarshal(previous, &result); err != nil {
				return out, err
			}
			out.Results = append(out.Results, result)
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		if err = requireCommandDataVersion(c, dataVersionFromContext(ctx)); err != nil {
			return out, err
		}
		result, validation := out.State.apply(c, user, out.Revision+1)
		if err = requireDataVersion(out.State, dataVersionFromContext(ctx)); err != nil {
			return out, err
		}
		if validation != nil {
			result = CommandResult{ID: c.ID, Status: "invalid", Error: validation.Error()}
		} else if result.Status == "ok" {
			out.Revision++
		}
		if atomic && result.Status != "ok" {
			return out, bad("Изменения не применены: " + result.Status + " " + result.Error)
		}
		encoded, _ := json.Marshal(result)
		if _, err = tx.Exec(ctx, `INSERT INTO mutations(book_id,id,user_id,request_hash,result) VALUES($1,$2,$3,$4,$5)`, book, c.ID, user, fingerprint, encoded); err != nil {
			return out, err
		}
		out.Results = append(out.Results, result)
	}
	if len(out.State.Entries) > 50000 || len(out.State.Accounts) > 100 || len(out.State.Categories) > 500 {
		return out, bad("Достигнут лимит книги MVP")
	}
	// shortcut: a locked JSONB snapshot suits small household books; add indexed rows and delta sync above 50,000 entries.
	encoded, err := json.Marshal(out.State)
	if err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE books SET state=$1,revision=$2 WHERE id=$3`, encoded, out.Revision, book); err != nil {
		return out, err
	}
	return out, nil
}

func jsonBytes(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
