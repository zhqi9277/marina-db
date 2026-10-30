// Line-delimited JSON between the host and marina-agent. One object per line.
package rpc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
)

type Request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	ID     int    `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func ReadRequest(r *bufio.Reader) (Request, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return Request{}, err
	}
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		return Request{}, fmt.Errorf("request: %w", err)
	}
	if req.Method == "" {
		return Request{}, fmt.Errorf("request: missing method")
	}
	return req, nil
}

func WriteResponse(w io.Writer, resp Response) error {
	buf, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	_, err = w.Write(append(buf, '\n'))
	return err
}

func DecodeParams(raw json.RawMessage, dest any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return json.Unmarshal(raw, dest)
}
