package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"
)

func TestShutdownFinishesAnActiveRequestBeforeReturning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	address := make(chan string, 1)
	entered, finish := make(chan struct{}), make(chan struct{})
	server := &http.Server{Addr: "127.0.0.1:0", BaseContext: func(listener net.Listener) context.Context {
		address <- listener.Addr().String()
		return context.Background()
	}, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-finish
		io.WriteString(w, "committed")
	})}
	stopped := make(chan error, 1)
	go func() { stopped <- serve(ctx, server, time.Second) }()
	result := make(chan error, 1)
	go func() {
		client := http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://" + <-address)
		if err == nil {
			defer response.Body.Close()
			var data []byte
			data, err = io.ReadAll(response.Body)
			if string(data) != "committed" {
				t.Error("active response lost", string(data))
			}
		}
		result <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-stopped:
		close(finish)
		t.Fatal("server returned while a request was still active", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(finish)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
}

func TestServeDoesNotLeaveShutdownWaitersAfterListenErrors(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	before := runtime.NumGoroutine()
	for range 30 {
		if err := serve(ctx, &http.Server{Addr: listener.Addr().String()}, time.Second); err == nil {
			t.Fatal("occupied listener accepted")
		}
	}
	deadline := time.Now().Add(time.Second)
	for runtime.NumGoroutine() > before+5 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before+5 {
		t.Fatalf("failed starts left goroutines: before=%d after=%d", before, after)
	}
}

func TestServeReturnsWhenServerIsClosedExternally(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	server := &http.Server{Addr: "127.0.0.1:0", BaseContext: func(net.Listener) context.Context {
		close(ready)
		return context.Background()
	}}
	done := make(chan error, 1)
	go func() { done <- serve(ctx, server, time.Second) }()
	<-ready
	server.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(300 * time.Millisecond):
		cancel()
		<-done
		t.Fatal("closed server still waits for a signal")
	}
}

func TestEndpointBoundsAndCancelsRequestContext(t *testing.T) {
	var captured context.Context
	handler := endpoint(func(w http.ResponseWriter, r *http.Request) error {
		captured = r.Context()
		deadline, ok := captured.Deadline()
		if !ok || time.Until(deadline) > 75*time.Second || time.Until(deadline) < 74*time.Second {
			t.Error("request has no bounded processing deadline", deadline, ok)
		}
		return nil
	})
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/test", nil))
	if captured.Err() != context.Canceled {
		t.Fatal("completed request context was not released", captured.Err())
	}
}

func TestRedisHonorsRequestDeadline(t *testing.T) {
	a := integrationApp(t)
	if err := a.redis.Do(context.Background(), "CLIENT", "PAUSE", "600", "ALL").Err(); err != nil {
		t.Fatal(err)
	}
	defer a.redis.Do(context.Background(), "CLIENT", "UNPAUSE")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := a.redis.Ping(ctx).Err()
	if err == nil || time.Since(start) > 450*time.Millisecond {
		t.Fatal("Redis ignored the request deadline", time.Since(start), err)
	}
}

func TestShutdownDeadlineClosesOverdueRequests(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	address := make(chan string, 1)
	entered, requestCanceled := make(chan struct{}), make(chan struct{})
	server := &http.Server{Addr: "127.0.0.1:0", BaseContext: func(listener net.Listener) context.Context {
		address <- listener.Addr().String()
		return context.Background()
	}, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(requestCanceled)
	})}
	done := make(chan error, 1)
	go func() { done <- serve(ctx, server, 40*time.Millisecond) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		client := http.Client{Timeout: 2 * time.Second}
		if response, err := client.Get("http://" + <-address); err == nil {
			response.Body.Close()
		}
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("shutdown timeout not reported", err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown exceeded its deadline")
	}
	select {
	case <-requestCanceled:
	case <-time.After(time.Second):
		t.Fatal("forced shutdown did not cancel the request")
	}
	<-clientDone
}
