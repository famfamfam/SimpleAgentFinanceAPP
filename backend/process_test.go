package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestBackendHelperProcess(t *testing.T) {
	if os.Getenv("FINANCE_TEST_PROCESS") == "1" {
		main()
		os.Exit(0)
	}
}

func TestProcessSIGTERMDrainsAIAndRestartReplaysItsResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM lifecycle is tested on Linux")
	}
	a := integrationApp(t)
	database, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	query := database.Query()
	query.Set("search_path", a.db.Config().ConnConfig.RuntimeParams["search_path"])
	database.RawQuery = query.Encode()
	entered, finish := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(finish) })
	var providerCalls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if providerCalls.Add(1) == 1 {
			close(entered)
		}
		<-finish
		respond(w, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "Ready"}}}, "usage": map[string]any{"cost": 0}})
	}))
	defer provider.Close()
	defer unblock()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	baseURL := "http://" + address
	start := func() (*exec.Cmd, <-chan struct{}, func() error) {
		log, err := os.Create(filepath.Join(t.TempDir(), "backend.log"))
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestBackendHelperProcess$")
		cmd.Env = append(os.Environ(), "FINANCE_TEST_PROCESS=1", "DATABASE_URL="+database.String(),
			"REDIS_URL="+env("TEST_REDIS_URL", "redis://localhost:16379/15"), "LISTEN_ADDR="+address,
			"APP_SECRET="+strings.Repeat("s", 32), "REGISTRATION_PASSWORD="+testRegistrationPassword,
			"OPENROUTER_API_KEY=mock", "OPENROUTER_URL="+provider.URL, "AI_DAILY_BUDGET_USD=1.00",
			"PUBLIC_URL=", "SECURE_COOKIES=false", "TRUST_PROXY=false")
		cmd.Stdout, cmd.Stderr = log, log
		if err := cmd.Start(); err != nil {
			log.Close()
			t.Fatal(err)
		}
		done := make(chan struct{})
		var exitErr error
		go func() { exitErr = cmd.Wait(); close(done) }()
		t.Cleanup(func() {
			select {
			case <-done:
			default:
				cmd.Process.Kill()
				<-done
			}
			log.Close()
		})
		client := http.Client{Timeout: 250 * time.Millisecond}
		ready := false
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
			response, err := client.Get(baseURL + "/api/health")
			if err == nil {
				response.Body.Close()
				if response.StatusCode == 200 {
					ready = true
					break
				}
			}
			select {
			case <-done:
				data, _ := os.ReadFile(log.Name())
				t.Fatalf("backend exited during startup: %v\n%s", exitErr, data)
			case <-time.After(20 * time.Millisecond):
			}
		}
		if !ready {
			t.Fatal("backend did not become ready")
		}
		return cmd, done, func() error { <-done; return exitErr }
	}
	process, stopped, wait := start()
	client, _, _ := registerClient(t, baseURL, "Process lifecycle")
	book := newID()
	call(t, client, "POST", baseURL+"/api/books", map[string]string{"id": book, "name": "Lifecycle"}, 200)
	input := AssistantInput{ID: newID(), Text: "Hello", Date: "2026-10-30", AccountID: initialState().Accounts[0].ID}
	endpoint := baseURL + "/api/books/" + book + "/assistant"
	requestDone := make(chan error, 1)
	go func() {
		response, err := client.Post(endpoint, "application/json", bytes.NewReader(jsonBytes(input)))
		if err == nil {
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 {
				err = apiError{response.StatusCode, "active request failed"}
			}
		}
		requestDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("AI request did not reach provider")
	}
	if err := process.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
		t.Fatal("SIGTERM discarded the active AI request", wait())
	case <-time.After(50 * time.Millisecond):
	}
	unblock()
	if err := <-requestDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
		if err := wait(); err != nil {
			t.Fatal("graceful process stop failed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("process did not finish draining")
	}
	if slots, err := a.redis.ZCard(context.Background(), "finance:ai-active").Result(); err != nil || slots != 0 {
		t.Fatal("process left an active AI slot", slots, err)
	}
	process, stopped, wait = start()
	call(t, client, "POST", endpoint, input, 200)
	if providerCalls.Load() != 1 {
		t.Fatal("restart lost the saved AI result", providerCalls.Load())
	}
	if err := process.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
		if err := wait(); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("idle process did not stop")
	}
}
