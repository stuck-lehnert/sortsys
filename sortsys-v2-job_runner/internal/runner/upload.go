package runner

import (
	"fmt"
	"net/url"
	"strings"
)

// Resolve API-relative capabilities against the API that issued the job.
func (r *Runner) uploadURL(value string) (string, error) {
	target, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("invalid upload URL")
	}
	if target.IsAbs() {
		if target.Scheme != "http" && target.Scheme != "https" {
			return "", fmt.Errorf("invalid upload URL scheme")
		}
		return target.String(), nil
	}
	if target.Host != "" || target.RawQuery != "" || target.Fragment != "" ||
		!strings.HasPrefix(target.Path, "/internal/legacy-uploads/") {
		return "", fmt.Errorf("invalid API upload capability")
	}
	ticket := strings.TrimPrefix(target.Path, "/internal/legacy-uploads/")
	if ticket == "" || strings.Contains(ticket, "/") {
		return "", fmt.Errorf("invalid API upload ticket")
	}
	base, err := url.Parse(r.cfg.WSURL)
	if err != nil || base.Host == "" {
		return "", fmt.Errorf("invalid API WebSocket URL")
	}
	switch base.Scheme {
	case "ws":
		base.Scheme = "http"
	case "wss":
		base.Scheme = "https"
	default:
		return "", fmt.Errorf("invalid API WebSocket scheme")
	}
	const socketPath = "/internal/job-runners/ws"
	if !strings.HasSuffix(base.Path, socketPath) {
		return "", fmt.Errorf("invalid API WebSocket path")
	}
	base.Path = strings.TrimSuffix(base.Path, socketPath) + target.Path
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}
