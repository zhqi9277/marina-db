package rpc

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteResponse(&buf, Response{ID: 7, Result: map[string]any{"pong": true}}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(buf.String(), "\n") {
		t.Fatalf("response must be one line, got %q", buf.String())
	}
	if !strings.Contains(buf.String(), `"pong":true`) {
		t.Fatalf("missing result: %s", buf.String())
	}
}

func TestReadRequestRequiresMethod(t *testing.T) {
	_, err := ReadRequest(bufio.NewReader(strings.NewReader("{\"id\":1}\n")))
	if err == nil {
		t.Fatal("expected missing method")
	}
}
