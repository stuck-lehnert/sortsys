package runner

import (
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	WSURL          string
	WSIgnoreProxy  bool
	Token          string
	RunnerID       string
	LeaseSec       int
	PollLimit      int
	PollIntervalMS int
	JobType        string
	JPEGQuality    int
	RetryAfterSec  int
	UserAgent      string
}

func LoadConfigFromEnv() (Config, error) {
	cfg := Config{
		WSURL:          strings.TrimSpace(os.Getenv("JOB_RUNNER_WS_URL")),
		WSIgnoreProxy:  envBool("JOB_RUNNER_WS_IGNORE_PROXY", false),
		Token:          strings.TrimSpace(os.Getenv("JOB_RUNNER_TOKEN")),
		RunnerID:       strings.TrimSpace(os.Getenv("JOB_RUNNER_ID")),
		LeaseSec:       envInt("JOB_RUNNER_LEASE_SEC", 90),
		PollLimit:      envInt("JOB_RUNNER_POLL_LIMIT", 10),
		PollIntervalMS: envInt("JOB_RUNNER_POLL_INTERVAL_MS", 800),
		JobType:        envString("JOB_RUNNER_JOB_TYPE", "project_file_thumbnail_generate,tenant_logo_generate"),
		JPEGQuality:    envInt("JOB_RUNNER_JPEG_QUALITY", 85),
		RetryAfterSec:  envInt("JOB_RUNNER_RETRY_AFTER_SEC", 60),
		UserAgent:      envString("JOB_RUNNER_USER_AGENT", "sortsys-v2-job-runner/0.1"),
	}

	if cfg.WSURL == "" {
		return Config{}, fmt.Errorf("JOB_RUNNER_WS_URL is required")
	}
	if cfg.Token == "" {
		return Config{}, fmt.Errorf("JOB_RUNNER_TOKEN is required")
	}
	if cfg.RunnerID == "" {
		cfg.RunnerID = fmt.Sprintf("runner-%d", rand.Uint64())
	}
	if cfg.LeaseSec < 5 {
		cfg.LeaseSec = 5
	}
	if cfg.PollLimit < 1 {
		cfg.PollLimit = 1
	}
	if cfg.PollLimit > 50 {
		cfg.PollLimit = 50
	}
	if cfg.PollIntervalMS < 100 {
		cfg.PollIntervalMS = 100
	}
	if cfg.JPEGQuality < 60 {
		cfg.JPEGQuality = 60
	}
	if cfg.JPEGQuality > 95 {
		cfg.JPEGQuality = 95
	}
	if cfg.RetryAfterSec < 5 {
		cfg.RetryAfterSec = 5
	}

	return cfg, nil
}

func envString(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}

	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}

	return v
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if raw == "" {
		return fallback
	}

	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
