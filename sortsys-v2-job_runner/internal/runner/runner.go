package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const thumbnailJobType = "project_file_thumbnail_generate"
const tenantLogoJobType = "tenant_logo_generate"
const deliveryNoteOCRJobType = "delivery_note_ocr"
const maxSourceImageBytes = 100 * 1024 * 1024

type Runner struct {
	cfg        Config
	httpClient *http.Client
	dialer     *websocket.Dialer
}

type helloPayload struct {
	Token    string `json:"token"`
	RunnerID string `json:"runnerId,omitempty"`
	LeaseSec int    `json:"leaseSec,omitempty"`
}

type helloResult struct {
	RunnerID string `json:"runnerId"`
	LeaseSec int    `json:"leaseSec"`
}

type pollPayload struct {
	Limit int    `json:"limit,omitempty"`
	Type  string `json:"type,omitempty"`
}

type pollResult struct {
	Jobs []openJob `json:"jobs"`
}

type openJob struct {
	ID string `json:"id"`
}

type acquirePayload struct {
	JobID    string `json:"jobId"`
	LeaseSec int    `json:"leaseSec,omitempty"`
}

type acquireResult struct {
	Acquired bool         `json:"acquired"`
	Job      *acquiredJob `json:"job,omitempty"`
}

type acquiredJob struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	TenantName string          `json:"tenantName"`
	Attempts   int             `json:"attempts"`
	Payload    json.RawMessage `json:"payload"`
}

type thumbnailJobPayload struct {
	ProjectID              string            `json:"projectId"`
	ProjectFileID          string            `json:"projectFileId"`
	SourceObjectKey        string            `json:"sourceObjectKey"`
	SourceMimeType         string            `json:"sourceMimeType"`
	SourceFileName         string            `json:"sourceFileName"`
	SourceWebpFileName     string            `json:"sourceWebpFileName"`
	ThumbnailObjectKey     string            `json:"thumbnailObjectKey"`
	ThumbnailMimeType      string            `json:"thumbnailMimeType"`
	MaxWidth               int               `json:"maxWidth"`
	MaxHeight              int               `json:"maxHeight"`
	SourceDownloadURL      string            `json:"sourceDownloadUrl"`
	SourceUploadURL        string            `json:"sourceUploadUrl"`
	SourceUploadMethod     string            `json:"sourceUploadMethod"`
	SourceUploadHeaders    map[string]string `json:"sourceUploadHeaders"`
	ThumbnailUploadURL     string            `json:"thumbnailUploadUrl"`
	ThumbnailUploadMethod  string            `json:"thumbnailUploadMethod"`
	ThumbnailUploadHeaders map[string]string `json:"thumbnailUploadHeaders"`
}

type tenantLogoJobPayload struct {
	GenerationID      string            `json:"generationId"`
	SourceObjectKey   string            `json:"sourceObjectKey"`
	SourceMimeType    string            `json:"sourceMimeType"`
	SourceFileName    string            `json:"sourceFileName"`
	LogoObjectKey     string            `json:"logoObjectKey"`
	LogoMimeType      string            `json:"logoMimeType"`
	SourceDownloadURL string            `json:"sourceDownloadUrl"`
	LogoUploadURL     string            `json:"logoUploadUrl"`
	LogoUploadMethod  string            `json:"logoUploadMethod"`
	LogoUploadHeaders map[string]string `json:"logoUploadHeaders"`
}

type completePayload struct {
	JobID  string `json:"jobId"`
	Result any    `json:"result"`
}

type thumbnailCompleteResult struct {
	ThumbnailObjectKey string `json:"thumbnailObjectKey"`
	ThumbnailMimeType  string `json:"thumbnailMimeType"`
	SourceMimeType     string `json:"sourceMimeType,omitempty"`
	SourceFileName     string `json:"sourceFileName,omitempty"`
	SourceSizeBytes    int64  `json:"sourceSizeBytes,omitempty"`
	SourceETag         string `json:"sourceEtag,omitempty"`
	Width              int    `json:"width"`
	Height             int    `json:"height"`
	SizeBytes          int64  `json:"sizeBytes"`
	ETag               string `json:"etag,omitempty"`
}

type tenantLogoCompleteResult struct {
	LogoObjectKey   string `json:"logoObjectKey"`
	LogoMimeType    string `json:"logoMimeType"`
	SourceMimeType  string `json:"sourceMimeType,omitempty"`
	SourceFileName  string `json:"sourceFileName,omitempty"`
	SourceSizeBytes int64  `json:"sourceSizeBytes,omitempty"`
	SourceETag      string `json:"sourceEtag,omitempty"`
	Width           int    `json:"width,omitempty"`
	Height          int    `json:"height,omitempty"`
	SizeBytes       int64  `json:"sizeBytes,omitempty"`
	ETag            string `json:"etag,omitempty"`
}

type failPayload struct {
	JobID         string `json:"jobId"`
	Error         string `json:"error"`
	RetryAfterSec int    `json:"retryAfterSec"`
}

func New(cfg Config) *Runner {
	dialer := websocket.DefaultDialer
	if dialer == nil {
		dialer = &websocket.Dialer{}
	}

	dialerCopy := *dialer
	if cfg.WSIgnoreProxy {
		dialerCopy.Proxy = nil
	}

	return &Runner{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 45 * time.Second,
		},
		dialer: &dialerCopy,
	}
}

func (r *Runner) Run(ctx context.Context) error {
	log.Printf("job runner started id=%s url=%s", r.cfg.RunnerID, r.cfg.WSURL)

	for {
		if err := ctx.Err(); err != nil {
			return nil
		}

		if err := r.runConnection(ctx); err != nil {
			log.Printf("connection ended: %v", err)
		}

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	}
}

func (r *Runner) runConnection(ctx context.Context) error {
	conn, _, err := r.dialer.DialContext(ctx, r.cfg.WSURL, http.Header{"User-Agent": []string{r.cfg.UserAgent}})
	if err != nil {
		return fmt.Errorf("dial websocket: %w", err)
	}

	client := newWSClient(conn)
	defer func() {
		_ = client.Close()
	}()

	var hello helloResult
	if err := client.Call(
		ctx,
		"hello",
		helloPayload{Token: r.cfg.Token, RunnerID: r.cfg.RunnerID, LeaseSec: r.cfg.LeaseSec},
		"hello.ok",
		&hello,
	); err != nil {
		return fmt.Errorf("hello failed: %w", err)
	}

	if hello.RunnerID != "" && hello.RunnerID != r.cfg.RunnerID {
		r.cfg.RunnerID = hello.RunnerID
	}
	if hello.LeaseSec > 0 {
		r.cfg.LeaseSec = hello.LeaseSec
	}

	for {
		if err := ctx.Err(); err != nil {
			return nil
		}

		jobTypes := normalizeJobTypesFilter(r.cfg.JobType)
		openJobsByID := map[string]openJob{}

		for _, jobType := range jobTypes {
			var polled pollResult
			err := client.Call(ctx, "jobs.poll", pollPayload{Limit: r.cfg.PollLimit, Type: jobType}, "jobs.poll.result", &polled)
			if err != nil {
				return fmt.Errorf("poll jobs: %w", err)
			}

			for _, job := range polled.Jobs {
				openJobsByID[job.ID] = job
			}
		}

		if len(openJobsByID) == 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Duration(r.cfg.PollIntervalMS) * time.Millisecond):
			}
			continue
		}

		for _, open := range openJobsByID {
			var acquired acquireResult
			err := client.Call(ctx, "jobs.acquire", acquirePayload{JobID: open.ID, LeaseSec: r.cfg.LeaseSec}, "jobs.acquire.result", &acquired)
			if err != nil {
				return fmt.Errorf("acquire job %s: %w", open.ID, err)
			}

			if !acquired.Acquired || acquired.Job == nil {
				continue
			}

			if err := r.processJob(ctx, client, acquired.Job); err != nil {
				log.Printf("job %s failed: %v", acquired.Job.ID, err)
			}
		}
	}
}

func (r *Runner) processJob(ctx context.Context, client *wsClient, job *acquiredJob) error {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	go r.heartbeatLoop(jobCtx, client, job.ID)

	var (
		result any
		err    error
	)

	switch job.Type {
	case thumbnailJobType:
		payload, parseErr := parseThumbnailJobPayload(job.Payload)
		if parseErr != nil {
			err = parseErr
			break
		}
		result, err = r.generateAndUploadThumbnail(ctx, payload)
	case tenantLogoJobType:
		payload, parseErr := parseTenantLogoJobPayload(job.Payload)
		if parseErr != nil {
			err = parseErr
			break
		}
		result, err = r.generateAndUploadTenantLogo(ctx, payload)
	case deliveryNoteOCRJobType:
		payload, parseErr := parseDeliveryNoteOCRJobPayload(job.Payload)
		if parseErr != nil {
			err = parseErr
			break
		}
		result, err = r.extractDeliveryNoteText(ctx, payload)
	default:
		err = fmt.Errorf("unsupported job type %q", job.Type)
	}

	if err != nil {
		failErr := client.Call(
			ctx,
			"jobs.fail",
			failPayload{JobID: job.ID, Error: trimError(err.Error()), RetryAfterSec: r.cfg.RetryAfterSec},
			"jobs.fail.result",
			nil,
		)
		if failErr != nil {
			return fmt.Errorf("report job failure after processing error (%v): %w", err, failErr)
		}
		return err
	}

	if err := client.Call(ctx, "jobs.complete", completePayload{JobID: job.ID, Result: result}, "jobs.complete.result", nil); err != nil {
		return fmt.Errorf("report completion for job %s: %w", job.ID, err)
	}

	switch typed := result.(type) {
	case thumbnailCompleteResult:
		log.Printf("job %s completed thumbnail (%dx%d, %d bytes)", job.ID, typed.Width, typed.Height, typed.SizeBytes)
	case tenantLogoCompleteResult:
		log.Printf("job %s completed logo (%dx%d, %d bytes)", job.ID, typed.Width, typed.Height, typed.SizeBytes)
	case deliveryNoteOCRCompleteResult:
		log.Printf("job %s completed OCR (%s, %.0f%%, %d pages)", job.ID, typed.Method, typed.Confidence*100, typed.PageCount)
	default:
		log.Printf("job %s completed", job.ID)
	}
	return nil
}

func (r *Runner) heartbeatLoop(ctx context.Context, client *wsClient, jobID string) {
	interval := time.Duration(r.cfg.LeaseSec/2) * time.Second
	if interval < 2*time.Second {
		interval = 2 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = client.Call(ctx, "jobs.heartbeat", map[string]any{"jobId": jobID, "leaseSec": r.cfg.LeaseSec}, "jobs.heartbeat.result", nil)
		}
	}
}

func parseThumbnailJobPayload(raw json.RawMessage) (thumbnailJobPayload, error) {
	var payload thumbnailJobPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return thumbnailJobPayload{}, fmt.Errorf("parse thumbnail payload: %w", err)
	}

	return payload, nil
}

func parseTenantLogoJobPayload(raw json.RawMessage) (tenantLogoJobPayload, error) {
	var payload tenantLogoJobPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return tenantLogoJobPayload{}, fmt.Errorf("parse tenant logo payload: %w", err)
	}

	return payload, nil
}

func (r *Runner) generateAndUploadThumbnail(ctx context.Context, payload thumbnailJobPayload) (thumbnailCompleteResult, error) {
	if payload.SourceDownloadURL == "" {
		return thumbnailCompleteResult{}, fmt.Errorf("missing sourceDownloadUrl")
	}
	if payload.SourceUploadURL == "" {
		return thumbnailCompleteResult{}, fmt.Errorf("missing sourceUploadUrl")
	}
	if payload.ThumbnailUploadURL == "" {
		return thumbnailCompleteResult{}, fmt.Errorf("missing thumbnailUploadUrl")
	}

	maxWidth := payload.MaxWidth
	maxHeight := payload.MaxHeight
	if maxWidth < 1 {
		maxWidth = 240
	}
	if maxHeight < 1 {
		maxHeight = 240
	}

	sourceBytes, err := r.downloadBytes(ctx, payload.SourceDownloadURL)
	if err != nil {
		return thumbnailCompleteResult{}, err
	}

	sourceWebp, err := ConvertToWebP(sourceBytes)
	if err != nil {
		return thumbnailCompleteResult{}, err
	}

	sourceETag, err := r.uploadSourceImage(ctx, payload, sourceWebp.Data)
	if err != nil {
		return thumbnailCompleteResult{}, err
	}

	thumb, err := ResizeToWebP(sourceBytes, maxWidth, maxHeight)
	if err != nil {
		return thumbnailCompleteResult{}, err
	}

	etag, err := r.uploadThumbnail(ctx, payload, thumb.Data)
	if err != nil {
		return thumbnailCompleteResult{}, err
	}

	mimeType := "image/webp"

	return thumbnailCompleteResult{
		ThumbnailObjectKey: payload.ThumbnailObjectKey,
		ThumbnailMimeType:  mimeType,
		SourceMimeType:     "image/webp",
		SourceFileName:     normalizedWebpFileName(payload),
		SourceSizeBytes:    int64(len(sourceWebp.Data)),
		SourceETag:         strings.Trim(sourceETag, `"`),
		Width:              thumb.Width,
		Height:             thumb.Height,
		SizeBytes:          int64(len(thumb.Data)),
		ETag:               strings.Trim(etag, `"`),
	}, nil
}

func (r *Runner) generateAndUploadTenantLogo(ctx context.Context, payload tenantLogoJobPayload) (tenantLogoCompleteResult, error) {
	if payload.SourceDownloadURL == "" {
		return tenantLogoCompleteResult{}, fmt.Errorf("missing sourceDownloadUrl")
	}
	if payload.LogoUploadURL == "" {
		return tenantLogoCompleteResult{}, fmt.Errorf("missing logoUploadUrl")
	}

	sourceBytes, err := r.downloadBytes(ctx, payload.SourceDownloadURL)
	if err != nil {
		return tenantLogoCompleteResult{}, err
	}

	logoWebp, err := ConvertToBlackAndWhiteWebP(sourceBytes)
	if err != nil {
		return tenantLogoCompleteResult{}, err
	}

	etag, err := r.uploadTenantLogo(ctx, payload, logoWebp.Data)
	if err != nil {
		return tenantLogoCompleteResult{}, err
	}

	return tenantLogoCompleteResult{
		LogoObjectKey:   payload.LogoObjectKey,
		LogoMimeType:    "image/webp",
		SourceMimeType:  "image/webp",
		SourceFileName:  normalizedLogoWebpFileName(payload),
		SourceSizeBytes: int64(len(logoWebp.Data)),
		SourceETag:      strings.Trim(etag, `"`),
		Width:           logoWebp.Width,
		Height:          logoWebp.Height,
		SizeBytes:       int64(len(logoWebp.Data)),
		ETag:            strings.Trim(etag, `"`),
	}, nil
}

func (r *Runner) downloadBytes(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build source download request: %w", err)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download source image: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("source download returned status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSourceImageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read source image: %w", err)
	}
	if len(data) > maxSourceImageBytes {
		return nil, fmt.Errorf("source image exceeds %d bytes", maxSourceImageBytes)
	}

	return data, nil
}

func (r *Runner) uploadThumbnail(ctx context.Context, payload thumbnailJobPayload, data []byte) (string, error) {
	method := payload.ThumbnailUploadMethod
	if method == "" {
		method = http.MethodPut
	}

	req, err := http.NewRequestWithContext(ctx, method, payload.ThumbnailUploadURL, bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("build thumbnail upload request: %w", err)
	}

	for key, value := range payload.ThumbnailUploadHeaders {
		req.Header.Set(key, value)
	}
	req.Header.Set("Content-Type", "image/webp")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("upload thumbnail: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("thumbnail upload returned status %d (%s)", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	return resp.Header.Get("ETag"), nil
}

func (r *Runner) uploadSourceImage(ctx context.Context, payload thumbnailJobPayload, data []byte) (string, error) {
	method := payload.SourceUploadMethod
	if method == "" {
		method = http.MethodPut
	}

	req, err := http.NewRequestWithContext(ctx, method, payload.SourceUploadURL, bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("build source upload request: %w", err)
	}

	for key, value := range payload.SourceUploadHeaders {
		req.Header.Set(key, value)
	}
	req.Header.Set("Content-Type", "image/webp")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("upload source image: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("source upload returned status %d (%s)", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	return resp.Header.Get("ETag"), nil
}

func (r *Runner) uploadTenantLogo(ctx context.Context, payload tenantLogoJobPayload, data []byte) (string, error) {
	method := payload.LogoUploadMethod
	if method == "" {
		method = http.MethodPut
	}

	req, err := http.NewRequestWithContext(ctx, method, payload.LogoUploadURL, bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("build tenant logo upload request: %w", err)
	}

	for key, value := range payload.LogoUploadHeaders {
		req.Header.Set(key, value)
	}
	req.Header.Set("Content-Type", "image/webp")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("upload tenant logo: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("tenant logo upload returned status %d (%s)", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	return resp.Header.Get("ETag"), nil
}

func normalizedWebpFileName(payload thumbnailJobPayload) string {
	value := strings.TrimSpace(payload.SourceWebpFileName)
	if value != "" {
		return value
	}

	name := strings.TrimSpace(payload.SourceFileName)
	if name == "" {
		return "image.webp"
	}

	lastSlash := strings.LastIndexAny(name, `/\\`)
	lastDot := strings.LastIndex(name, ".")
	if lastDot > lastSlash {
		name = name[:lastDot]
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return "image.webp"
	}

	if len(name) > 250 {
		name = name[:250]
	}

	return name + ".webp"
}

func normalizedLogoWebpFileName(payload tenantLogoJobPayload) string {
	value := strings.TrimSpace(payload.SourceFileName)
	if value == "" {
		return "logo.webp"
	}

	lastSlash := strings.LastIndexAny(value, `/\\`)
	lastDot := strings.LastIndex(value, ".")
	if lastDot > lastSlash {
		value = value[:lastDot]
	}

	value = strings.TrimSpace(value)
	if value == "" {
		return "logo.webp"
	}

	if len(value) > 250 {
		value = value[:250]
	}

	return value + ".webp"
}

func normalizeJobTypesFilter(input string) []string {
	parts := strings.Split(input, ",")
	seen := map[string]struct{}{}
	out := make([]string, 0, len(parts))

	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}

	if len(out) == 0 {
		return []string{""}
	}

	return out
}

func trimError(msg string) string {
	msg = strings.TrimSpace(msg)
	if len(msg) <= 4000 {
		return msg
	}
	return msg[:4000]
}
