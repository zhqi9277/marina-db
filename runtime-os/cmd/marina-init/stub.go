//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "marina-init is PID 1 for the integrated Linux; build it with GOOS=linux")
	os.Exit(1)
}
