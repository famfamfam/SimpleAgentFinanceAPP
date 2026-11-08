package main

import (
	"context"
	"embed"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

//go:embed web/* react-web
var assets embed.FS

var buildVersion = "dev"

type App struct {
	db                   *pgxpool.Pool
	redis                *redis.Client
	secret               string
	registrationPassword string
	origin               string
	secure               bool
	openrouter           string
	model                string
	client               *http.Client
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := http.Client{Timeout: 3 * time.Second}
		_, port, err := net.SplitHostPort(env("LISTEN_ADDR", ":8080"))
		if err != nil {
			os.Exit(1)
		}
		response, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/api/health")
		if err != nil {
			os.Exit(1)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
func run(ctx context.Context) error {
	secret := os.Getenv("APP_SECRET")
	if len(secret) < 32 {
		return errors.New("APP_SECRET must have at least 32 characters")
	}
	registrationPassword := os.Getenv("REGISTRATION_PASSWORD")
	if registrationPassword == "" {
		return errors.New("REGISTRATION_PASSWORD must be set")
	}
	if _, err := aiDailyBudget(); err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	migrationCtx, cancel := context.WithTimeout(ctx, time.Minute)
	err = migrate(migrationCtx, pool, migrationFiles)
	cancel()
	if err != nil {
		return err
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		return nil
	}
	cache, err := newRedisClient(env("REDIS_URL", "redis://localhost:6379/0"))
	if err != nil {
		return err
	}
	defer cache.Close()
	if err = cache.Ping(ctx).Err(); err != nil {
		return err
	}
	a := &App{db: pool, redis: cache, secret: secret, registrationPassword: registrationPassword, origin: strings.TrimRight(os.Getenv("PUBLIC_URL"), "/"), secure: os.Getenv("SECURE_COOKIES") == "true", openrouter: os.Getenv("OPENROUTER_API_KEY"), model: env("OPENROUTER_MODEL", "qwen/qwen3.8-omni-flash"), client: &http.Client{Timeout: 75 * time.Second}}
	defer a.client.CloseIdleConnections()
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); a.cleanup(workerCtx) }()
	defer func() { stopWorker(); <-workerDone }()
	server := &http.Server{Addr: env("LISTEN_ADDR", ":8080"), Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	// Drain requests before closing pools, with headroom below Docker's 90s stop timeout.
	return serve(ctx, server, requestTimeout+5*time.Second)
}

func newRedisClient(address string) (*redis.Client, error) {
	options, err := redis.ParseURL(address)
	if err != nil {
		return nil, err
	}
	options.ContextTimeoutEnabled = true
	return redis.NewClient(options), nil
}

func serve(ctx context.Context, server *http.Server, shutdownTimeout time.Duration) error {
	listening := make(chan error, 1)
	go func() { listening <- server.ListenAndServe() }()
	slog.Info("listening", "address", server.Addr)
	select {
	case err := <-listening:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		err := server.Shutdown(shutdown)
		if err != nil {
			server.Close()
		}
		listenErr := <-listening
		if err != nil {
			return err
		}
		if errors.Is(listenErr, http.ErrServerClosed) {
			return nil
		}
		return listenErr
	}
}

func (a *App) cleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		passCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := a.cleanupExpired(passCtx)
		cancel()
		if err != nil && ctx.Err() == nil {
			slog.Warn("cleanup failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (a *App) cleanupExpired(ctx context.Context) error {
	if err := a.cleanupChat(ctx); err != nil {
		return err
	}
	for _, query := range []string{
		`DELETE FROM assistant_requests WHERE created_at < now()-interval '30 days'`,
		`DELETE FROM imports WHERE NOT applied AND created_at < now()-interval '7 days'`,
		`DELETE FROM invitations WHERE expires_at < now()-interval '1 day'`,
		`DELETE FROM sessions WHERE expires_at < now()`,
		`DELETE FROM integrations WHERE expires_at < now()`,
	} {
		if _, err := a.db.Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}
func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
