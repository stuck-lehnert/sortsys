package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/sortsys/sortsys-v2-job_runner/internal/runner"
)

func main() {
	cfg, err := runner.LoadConfigFromEnv()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	r := runner.New(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := r.Run(ctx); err != nil {
		log.Fatalf("runner stopped with error: %v", err)
	}
}
