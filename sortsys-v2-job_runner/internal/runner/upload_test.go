package runner

import "testing"

func TestUploadCapabilitiesUseTheIssuingAPIAndProxyPrefix(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		socket string
		target string
		want   string
	}{
		{"ws://api:3000/internal/job-runners/ws", "/internal/legacy-uploads/ticket", "http://api:3000/internal/legacy-uploads/ticket"},
		{"wss://api.example/api/v2/internal/job-runners/ws", "/internal/legacy-uploads/ticket", "https://api.example/api/v2/internal/legacy-uploads/ticket"},
		{"ws://api:3000/internal/job-runners/ws", "https://storage.example/thumbnail", "https://storage.example/thumbnail"},
	} {
		worker := Runner{cfg: Config{WSURL: test.socket}}
		got, err := worker.uploadURL(test.target)
		if err != nil || got != test.want {
			t.Errorf("uploadURL(%q): got %q, %v; want %q", test.target, got, err, test.want)
		}
	}
}

func TestUploadCapabilitiesRejectUnrelatedRelativeDestinations(t *testing.T) {
	t.Parallel()
	worker := Runner{cfg: Config{WSURL: "ws://api:3000/internal/job-runners/ws"}}
	for _, target := range []string{"//foreign.example/internal/legacy-uploads/ticket", "/auth.login", "file:///private", "/internal/legacy-uploads/ticket?redirect=1", "/internal/legacy-uploads/../auth.login", "/internal/legacy-uploads/"} {
		if _, err := worker.uploadURL(target); err == nil {
			t.Errorf("accepted unrelated upload target %q", target)
		}
	}
}
