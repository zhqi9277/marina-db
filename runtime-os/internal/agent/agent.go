// marina-agent is the control plane inside the integrated Linux.
// It binds loopback only. The host talks JSON-RPC: one object per line.
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"marina/runtime-os/internal/rpc"
)

const (
	DefaultListen = "127.0.0.1:4761"
	maxOutput     = 64 << 10
	maxLogBytes   = 256 << 10
)

type Server struct {
	DataRoot string
	AppRoot  string
	// Marina is the argv prefix for the in-guest CLI. Empty means discover node + marina.js.
	Marina  []string
	LogRoot string
}

type ExecParams struct {
	Argv    []string `json:"argv"`
	Dir     string   `json:"dir,omitempty"`
	Timeout int      `json:"timeout,omitempty"`
}

type EngineParams struct {
	Ref string `json:"ref"`
}

type LogsParams struct {
	File  string `json:"file"`
	Lines int    `json:"lines,omitempty"`
}

func (s *Server) dataRoot() string {
	if s.DataRoot != "" {
		return s.DataRoot
	}
	return "/var/lib/marina"
}

func (s *Server) appRoot() string {
	if s.AppRoot != "" {
		return s.AppRoot
	}
	return "/opt/marina"
}

func (s *Server) logRoot() string {
	if s.LogRoot != "" {
		return s.LogRoot
	}
	return filepath.Join(s.dataRoot(), "logs")
}

func (s *Server) ListenAndServe(ctx context.Context, addr string) error {
	if addr == "" {
		addr = DefaultListen
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return s.Serve(ctx, ln)
}

func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	defer ln.Close()
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.serveConn(ctx, conn)
	}
}

func (s *Server) serveConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 64<<10)
	for {
		req, err := rpc.ReadRequest(reader)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				_ = rpc.WriteResponse(conn, rpc.Response{Error: err.Error()})
			}
			return
		}
		result, callErr := s.Handle(ctx, req)
		resp := rpc.Response{ID: req.ID, Result: result}
		if callErr != nil {
			resp.Error = callErr.Error()
			resp.Result = nil
		}
		if err := rpc.WriteResponse(conn, resp); err != nil {
			return
		}
	}
}

func (s *Server) Handle(ctx context.Context, req rpc.Request) (any, error) {
	switch req.Method {
	case "ping":
		return map[string]any{"pong": true}, nil
	case "status":
		return s.status(), nil
	case "exec":
		var p ExecParams
		if err := rpc.DecodeParams(req.Params, &p); err != nil {
			return nil, err
		}
		return s.exec(ctx, p)
	case "start", "stop":
		var p EngineParams
		if err := rpc.DecodeParams(req.Params, &p); err != nil {
			return nil, err
		}
		if strings.TrimSpace(p.Ref) == "" {
			return nil, fmt.Errorf("%s: ref is required", req.Method)
		}
		return s.exec(ctx, ExecParams{Argv: append(s.marinaCmd(), req.Method, p.Ref), Dir: s.dataRoot(), Timeout: 120})
	case "logs":
		var p LogsParams
		if err := rpc.DecodeParams(req.Params, &p); err != nil {
			return nil, err
		}
		return s.logs(p)
	default:
		return nil, fmt.Errorf("unknown method %q", req.Method)
	}
}

func (s *Server) status() map[string]any {
	host, _ := os.Hostname()
	data := s.dataRoot()
	mounted := mountPoint(data)
	return map[string]any{
		"ok":          true,
		"hostname":    host,
		"dataRoot":    data,
		"dataMounted": mounted,
		"appRoot":     s.appRoot(),
		"listen":      DefaultListen,
	}
}

func mountPoint(target string) bool {
	body, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false
	}
	needle := " " + target + " "
	return strings.Contains(string(body), needle)
}

func (s *Server) marinaCmd() []string {
	if len(s.Marina) > 0 {
		out := make([]string, len(s.Marina))
		copy(out, s.Marina)
		return out
	}
	node := "/usr/local/bin/node"
	if _, err := os.Stat(node); err != nil {
		node = "node"
	}
	return []string{node, filepath.Join(s.appRoot(), "bin", "marina.js")}
}

func (s *Server) exec(ctx context.Context, p ExecParams) (any, error) {
	if len(p.Argv) == 0 || strings.TrimSpace(p.Argv[0]) == "" {
		return nil, fmt.Errorf("exec: argv is required")
	}
	dir := p.Dir
	if dir == "" {
		dir = s.dataRoot()
	}
	if err := s.allowDir(dir); err != nil {
		return nil, err
	}
	timeout := time.Duration(p.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if timeout > 30*time.Minute {
		timeout = 30 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, p.Argv[0], p.Argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"MARINA_HOME="+s.dataRoot(),
		"MARINA_INSIDE_LINUX=1",
	)
	var stdout, stderr limitedBuffer
	stdout.N = maxOutput
	stderr.N = maxOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("exec timed out after %s", timeout)
		} else {
			return nil, err
		}
	}
	return map[string]any{
		"code":   code,
		"stdout": stdout.String(),
		"stderr": stderr.String(),
	}, nil
}

func (s *Server) allowDir(dir string) error {
	clean := filepath.Clean(dir)
	roots := []string{s.dataRoot(), s.appRoot(), os.TempDir()}
	for _, root := range roots {
		root = filepath.Clean(root)
		if clean == root || strings.HasPrefix(clean, root+string(os.PathSeparator)) {
			return nil
		}
	}
	return fmt.Errorf("exec: dir %s is outside the marina roots", dir)
}

func (s *Server) logs(p LogsParams) (any, error) {
	name := p.File
	if name == "" {
		return nil, fmt.Errorf("logs: file is required")
	}
	if strings.Contains(name, "\x00") {
		return nil, fmt.Errorf("logs: invalid file")
	}
	root := filepath.Clean(s.logRoot())
	full := filepath.Clean(filepath.Join(root, name))
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return nil, fmt.Errorf("logs: file escapes %s", root)
	}
	body, err := os.ReadFile(full)
	if err != nil {
		return nil, err
	}
	if len(body) > maxLogBytes {
		body = body[len(body)-maxLogBytes:]
	}
	lines := p.Lines
	if lines <= 0 {
		lines = 80
	}
	if lines > 500 {
		lines = 500
	}
	all := strings.Split(strings.TrimRight(string(body), "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return map[string]any{"file": full, "text": strings.Join(all, "\n")}, nil
}

type limitedBuffer struct {
	N int
	b strings.Builder
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if l.N <= 0 {
		l.N = maxOutput
	}
	remain := l.N - l.b.Len()
	if remain > 0 {
		if len(p) > remain {
			_, _ = l.b.Write(p[:remain])
		} else {
			_, _ = l.b.Write(p)
		}
	}
	return len(p), nil
}

func (l *limitedBuffer) String() string { return l.b.String() }

// Call is a tiny client used by tests and by the host later.
func Call(conn net.Conn, id int, method string, params any) (rpc.Response, error) {
	payload := map[string]any{"id": id, "method": method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return rpc.Response{}, err
		}
		payload["params"] = json.RawMessage(raw)
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return rpc.Response{}, err
	}
	if _, err := conn.Write(append(buf, '\n')); err != nil {
		return rpc.Response{}, err
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return rpc.Response{}, err
	}
	var resp rpc.Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return rpc.Response{}, err
	}
	return resp, nil
}
