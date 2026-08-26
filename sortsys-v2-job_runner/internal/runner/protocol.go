package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type wsEnvelope struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type protocolErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type wsClient struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan wsEnvelope
	seq       atomic.Uint64
	closed    chan struct{}
}

func newWSClient(conn *websocket.Conn) *wsClient {
	c := &wsClient{
		conn:    conn,
		pending: make(map[string]chan wsEnvelope),
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	return c
}

func (c *wsClient) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return c.conn.Close()
}

func (c *wsClient) Call(ctx context.Context, requestType string, requestPayload any, responseType string, responsePayload any) error {
	requestID := fmt.Sprintf("%d-%d", time.Now().UnixMilli(), c.seq.Add(1))

	responseCh := make(chan wsEnvelope, 1)
	c.pendingMu.Lock()
	c.pending[requestID] = responseCh
	c.pendingMu.Unlock()

	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, requestID)
		c.pendingMu.Unlock()
	}()

	envelope := wsEnvelope{Type: requestType, RequestID: requestID}
	if requestPayload != nil {
		payload, err := json.Marshal(requestPayload)
		if err != nil {
			return fmt.Errorf("marshal %s payload: %w", requestType, err)
		}
		envelope.Payload = payload
	}

	data, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal %s envelope: %w", requestType, err)
	}

	c.writeMu.Lock()
	err = c.conn.WriteMessage(websocket.TextMessage, data)
	c.writeMu.Unlock()
	if err != nil {
		return fmt.Errorf("write %s request: %w", requestType, err)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.closed:
		return fmt.Errorf("websocket closed")
	case response := <-responseCh:
		if response.Type == "error" {
			var perr protocolErrorPayload
			_ = json.Unmarshal(response.Payload, &perr)
			if perr.Code == "" {
				perr.Code = "protocol_error"
			}
			if perr.Message == "" {
				perr.Message = "unknown websocket error"
			}
			return fmt.Errorf("%s: %s", perr.Code, perr.Message)
		}
		if responseType != "" && response.Type != responseType {
			return fmt.Errorf("unexpected response type %q (expected %q)", response.Type, responseType)
		}
		if responsePayload != nil && len(response.Payload) > 0 {
			if err := json.Unmarshal(response.Payload, responsePayload); err != nil {
				return fmt.Errorf("unmarshal %s response payload: %w", response.Type, err)
			}
		}
		return nil
	}
}

func (c *wsClient) readLoop() {
	defer func() {
		select {
		case <-c.closed:
		default:
			close(c.closed)
		}
	}()

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		var envelope wsEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			continue
		}

		if envelope.RequestID == "" {
			continue
		}

		c.pendingMu.Lock()
		responseCh := c.pending[envelope.RequestID]
		c.pendingMu.Unlock()
		if responseCh == nil {
			continue
		}

		select {
		case responseCh <- envelope:
		default:
		}
	}
}
