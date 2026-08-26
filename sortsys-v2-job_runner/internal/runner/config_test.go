package runner

import "testing"

func TestLoadConfigFromEnvWSIgnoreProxy(t *testing.T) {
	t.Setenv("JOB_RUNNER_WS_URL", "ws://localhost:3000/internal/job-runners/ws")
	t.Setenv("JOB_RUNNER_TOKEN", "test-token")
	t.Setenv("JOB_RUNNER_ID", "runner-test")

	testCases := []struct {
		name       string
		rawValue   string
		expected   bool
		useDefault bool
	}{
		{name: "defaults to false", rawValue: "", expected: false, useDefault: true},
		{name: "true literal", rawValue: "true", expected: true},
		{name: "one literal", rawValue: "1", expected: true},
		{name: "false literal", rawValue: "false", expected: false},
		{name: "invalid falls back", rawValue: "maybe", expected: false},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if tc.useDefault {
				t.Setenv("JOB_RUNNER_WS_IGNORE_PROXY", "")
			} else {
				t.Setenv("JOB_RUNNER_WS_IGNORE_PROXY", tc.rawValue)
			}

			cfg, err := LoadConfigFromEnv()
			if err != nil {
				t.Fatalf("LoadConfigFromEnv returned error: %v", err)
			}

			if cfg.WSIgnoreProxy != tc.expected {
				t.Fatalf("unexpected WSIgnoreProxy: got %v, want %v", cfg.WSIgnoreProxy, tc.expected)
			}
		})
	}
}
