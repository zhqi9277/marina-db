package agent

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"marina/runtime-os/internal/rpc"
)

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	return &Server{
		DataRoot: dir,
		AppRoot:  dir,
		LogRoot:  logs,
		Marina:   []string{"echo"},
	}, logs
}

func TestHandlePingExecAndLogs(t *testing.T) {
	srv, logs := testServer(t)
	pong, err := srv.Handle(context.Background(), rpc.Request{ID: 1, Method: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := pong.(map[string]any)
	if got["pong"] != true {
		t.Fatalf("ping: %#v", pong)
	}

	params, err := jsonMarshal(map[string]any{"argv": []string{"echo", "hello"}, "dir": srv.DataRoot})
	if err != nil {
		t.Fatal(err)
	}
	out, err := srv.Handle(context.Background(), rpc.Request{ID: 2, Method: "exec", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	body := out.(map[string]any)
	if body["code"] != 0 || body["stdout"] != "hello\n" {
		t.Fatalf("exec: %#v", body)
	}

	if err := os.WriteFile(filepath.Join(logs, "redis.log"), []byte("a\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	logOut, err := srv.Handle(context.Background(), rpc.Request{ID: 3, Method: "logs", Params: []byte(`{"file":"redis.log","lines":2}`)})
	if err != nil {
		t.Fatal(err)
	}
	if logOut.(map[string]any)["text"] != "b\nc" {
		t.Fatalf("logs: %#v", logOut)
	}
	if _, err := srv.Handle(context.Background(), rpc.Request{ID: 4, Method: "logs", Params: []byte(`{"file":"../secret"}`)}); err == nil {
		t.Fatal("logs path escape should fail")
	}
}

func TestStartDelegatesToMarina(t *testing.T) {
	srv, _ := testServer(t)
	out, err := srv.Handle(context.Background(), rpc.Request{ID: 1, Method: "start", Params: []byte(`{"ref":"redis"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if out.(map[string]any)["stdout"] != "start redis\n" {
		t.Fatalf("start: %#v", out)
	}
}

func TestServeLoopback(t *testing.T) {
	srv, _ := testServer(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.Serve(ctx, ln)

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	resp, err := Call(conn, 9, "ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Error != "" || resp.ID != 9 {
		t.Fatalf("response: %#v", resp)
	}
}
