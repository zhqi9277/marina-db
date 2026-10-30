// marina-agent serves the host on loopback. Nothing here listens on a public address.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"marina/runtime-os/internal/agent"
)

func main() {
	log.SetPrefix("marina-agent: ")
	log.SetFlags(0)
	addr := os.Getenv("MARINA_AGENT_LISTEN")
	if addr == "" {
		addr = agent.DefaultListen
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	srv := &agent.Server{
		DataRoot: os.Getenv("MARINA_HOME"),
		AppRoot:  os.Getenv("MARINA_APP_ROOT"),
	}
	log.Printf("listening on %s", addr)
	if err := srv.ListenAndServe(ctx, addr); err != nil {
		log.Fatal(err)
	}
}
