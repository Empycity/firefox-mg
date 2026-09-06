package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2/hpack"
)

type request struct {
	Method         string      `json:"method"`
	URL            string      `json:"url"`
	Headers        [][2]string `json:"headers"`
	BodyBase64     string      `json:"body_base64"`
	ClientHelloHex string      `json:"client_hello_hex"`
	Network        string      `json:"network"`
	TimeoutSeconds int         `json:"timeout_seconds"`
	Insecure       bool        `json:"insecure"`
}

type response struct {
	Status     int         `json:"status"`
	Headers    [][2]string `json:"headers"`
	BodyBase64 string      `json:"body_base64"`
	Error      string      `json:"error,omitempty"`
}

func writeFrame(w io.Writer, typ, flags byte, streamID uint32, payload []byte) error {
	header := make([]byte, 9)
	header[0] = byte(len(payload) >> 16)
	header[1] = byte(len(payload) >> 8)
	header[2] = byte(len(payload))
	header[3] = typ
	header[4] = flags
	binary.BigEndian.PutUint32(header[5:], streamID&0x7fffffff)
	if _, err := w.Write(header); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func settingsPayload() []byte {
	values := [][2]uint32{{1, 65536}, {2, 0}, {4, 131072}, {5, 16384}}
	out := make([]byte, 0, 24)
	for _, item := range values {
		b := make([]byte, 6)
		binary.BigEndian.PutUint16(b[:2], uint16(item[0]))
		binary.BigEndian.PutUint32(b[2:], item[1])
		out = append(out, b...)
	}
	return out
}

func encodeHeaders(req request, u *url.URL, body []byte) ([]byte, error) {
	var block bytes.Buffer
	enc := hpack.NewEncoder(&block)
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	fields := [][2]string{{":method", req.Method}, {":path", path}, {":authority", u.Host}, {":scheme", u.Scheme}}
	fields = append(fields, req.Headers...)
	for _, field := range fields {
		name := strings.ToLower(field[0])
		if name == "host" || name == "connection" {
			continue
		}
		if err := enc.WriteField(hpack.HeaderField{Name: name, Value: field[1]}); err != nil {
			return nil, err
		}
	}
	return block.Bytes(), nil
}

func readFrame(r *bufio.Reader) (byte, byte, uint32, []byte, error) {
	header := make([]byte, 9)
	if _, err := io.ReadFull(r, header); err != nil {
		return 0, 0, 0, nil, err
	}
	size := int(header[0])<<16 | int(header[1])<<8 | int(header[2])
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, 0, 0, nil, err
	}
	return header[3], header[4], binary.BigEndian.Uint32(header[5:]) & 0x7fffffff, payload, nil
}

func dial(req request, u *url.URL) (*utls.UConn, error) {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "443"
	}
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	network := req.Network
	if network == "" {
		network = "tcp4"
	}
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("unsupported network %q", network)
	}
	raw, err := net.DialTimeout(network, net.JoinHostPort(host, port), timeout)
	if err != nil {
		return nil, err
	}
	_ = raw.SetDeadline(time.Now().Add(timeout))
	hello := utls.HelloFirefox_Auto
	if req.ClientHelloHex != "" {
		record, err := hex.DecodeString(req.ClientHelloHex)
		if err != nil { raw.Close(); return nil, err }
		fingerprinter := &utls.Fingerprinter{AllowBluntMimicry: true}
		spec, err := fingerprinter.FingerprintClientHello(record)
		if err != nil { raw.Close(); return nil, err }
		hello = utls.HelloCustom
		conn := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"h2", "http/1.1"}, InsecureSkipVerify: req.Insecure}, hello)
		if err := conn.ApplyPreset(spec); err != nil { raw.Close(); return nil, err }
		if err := conn.Handshake(); err != nil { raw.Close(); return nil, err }
		if conn.ConnectionState().NegotiatedProtocol != "h2" { raw.Close(); return nil, fmt.Errorf("ALPN=%q", conn.ConnectionState().NegotiatedProtocol) }
		return conn, nil
	}
	conn := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"h2", "http/1.1"}, InsecureSkipVerify: req.Insecure}, hello)
	if err := conn.Handshake(); err != nil {
		raw.Close()
		return nil, err
	}
	if conn.ConnectionState().NegotiatedProtocol != "h2" {
		raw.Close()
		return nil, fmt.Errorf("ALPN=%q", conn.ConnectionState().NegotiatedProtocol)
	}
	return conn, nil
}

func run(req request) (response, error) {
	u, err := url.Parse(req.URL)
	if err != nil {
		return response{}, err
	}
	body, err := base64.StdEncoding.DecodeString(req.BodyBase64)
	if err != nil {
		return response{}, err
	}
	conn, err := dial(req, u)
	if err != nil {
		return response{}, err
	}
	defer conn.Close()

	block, err := encodeHeaders(req, u, body)
	if err != nil {
		return response{}, err
	}
	if _, err = conn.Write([]byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")); err != nil {
		return response{}, err
	}
	if err = writeFrame(conn, 4, 0, 0, settingsPayload()); err != nil {
		return response{}, err
	}
	w := make([]byte, 4)
	binary.BigEndian.PutUint32(w, 12517377)
	if err = writeFrame(conn, 8, 0, 0, w); err != nil {
		return response{}, err
	}
	priority := []byte{0, 0, 0, 0, 41}
	headerPayload := append(priority, block...)
	headerFlags := byte(0x24)
	if len(body) == 0 {
		headerFlags |= 0x1
	}
	if err = writeFrame(conn, 1, headerFlags, 3, headerPayload); err != nil {
		return response{}, err
	}
	binary.BigEndian.PutUint32(w, 12451840)
	if err = writeFrame(conn, 8, 0, 3, w); err != nil {
		return response{}, err
	}
	if len(body) > 0 {
		for len(body) > 0 {
			n := len(body)
			if n > 16384 {
				n = 16384
			}
			flags := byte(0)
			if n == len(body) {
				flags = 0x1
			}
			if err = writeFrame(conn, 0, flags, 3, body[:n]); err != nil {
				return response{}, err
			}
			body = body[n:]
		}
	}

	reader := bufio.NewReader(conn)
	decoder := hpack.NewDecoder(4096, nil)
	var out response
	var headerBlock bytes.Buffer
	for {
		typ, flags, stream, payload, err := readFrame(reader)
		if err != nil {
			return response{}, err
		}
		switch typ {
		case 4:
			if flags&1 == 0 {
				_ = writeFrame(conn, 4, 1, 0, nil)
			}
		case 1, 9:
			if stream != 3 {
				continue
			}
			if typ == 1 {
				if flags&8 != 0 {
					pad := int(payload[0])
					payload = payload[1 : len(payload)-pad]
				}
				if flags&0x20 != 0 {
					payload = payload[5:]
				}
			}
			headerBlock.Write(payload)
			if flags&4 != 0 {
				fields, err := decoder.DecodeFull(headerBlock.Bytes())
				if err != nil {
					return response{}, err
				}
				for _, field := range fields {
					if field.Name == ":status" {
						out.Status, _ = strconv.Atoi(field.Value)
					} else {
						out.Headers = append(out.Headers, [2]string{field.Name, field.Value})
					}
				}
				headerBlock.Reset()
			}
			if flags&1 != 0 {
				return out, nil
			}
		case 0:
			if stream != 3 {
				continue
			}
			if flags&8 != 0 {
				pad := int(payload[0])
				payload = payload[1 : len(payload)-pad]
			}
			decoded, _ := base64.StdEncoding.DecodeString(out.BodyBase64)
			decoded = append(decoded, payload...)
			out.BodyBase64 = base64.StdEncoding.EncodeToString(decoded)
			if flags&1 != 0 {
				return out, nil
			}
		case 7:
			return response{}, fmt.Errorf("GOAWAY %x", payload)
		}
	}
}

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		json.NewEncoder(os.Stdout).Encode(response{Error: err.Error()})
		return
	}
	if req.Method == "" {
		req.Method = "GET"
	}
	resp, err := run(req)
	if err != nil {
		resp.Error = err.Error()
	}
	_ = json.NewEncoder(os.Stdout).Encode(resp)
}

var _ = tls.VersionTLS13
